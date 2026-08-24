import Stripe from 'stripe';
import * as Sentry from '@sentry/node';
import prisma from '../utils/prisma';
import { config } from '../config';
import { Prisma } from '../generated/prisma/client';
import { getPayoutBalanceFromLedger } from './creator.service';
import { recordWebhookEvent } from '../utils/webhook-metrics';
import { v1LedgerCreate, isV1WalletFrozen } from './v1-wallet-freeze';
import { shadowWriteInvoicePaid } from '../v2/shadow-write/invoice-paid';
import { shadowWriteChargeRefunded } from '../v2/shadow-write/charge-refunded';
import { shadowWriteChargeDisputeCreated } from '../v2/shadow-write/charge-dispute-created';
import { shadowWriteChargeDisputeClosedWon } from '../v2/shadow-write/charge-dispute-closed-won';
import { shadowWritePayoutRequested } from '../v2/shadow-write/payout-requested';
import { shadowWritePayoutFailed } from '../v2/shadow-write/payout-failed';
import { shadowWriteTransferReversed } from '../v2/shadow-write/transfer-reversed';

type CreatorBillingCounterKey =
  | 'processed'
  | 'deduped'
  | 'failed'
  | 'refunded'
  | 'disputed'
  | 'payoutFailed';

const creatorBillingCounters: Record<CreatorBillingCounterKey, number> = {
  processed: 0,
  deduped: 0,
  failed: 0,
  refunded: 0,
  disputed: 0,
  payoutFailed: 0,
};

function bumpCounter(key: CreatorBillingCounterKey): void {
  creatorBillingCounters[key] = (creatorBillingCounters[key] ?? 0) + 1;
}

function logCreatorBilling(data: Record<string, unknown>): void {
  console.info('[CreatorBilling]', JSON.stringify({ ...data, counters: creatorBillingCounters }));
}

export function getCreatorBillingCounters(): Record<CreatorBillingCounterKey, number> {
  return { ...creatorBillingCounters };
}

function getStripeClient(): Stripe {
  if (!config.stripeSecretKey) {
    throw new Error('Stripe is not configured');
  }
  return new Stripe(config.stripeSecretKey);
}

// Extract the underlying Charge id for an Invoice across Stripe API versions.
//
// Background: Stripe API 2025-02 removed the top-level `Invoice.charge`
// field. The replacement is the dedicated `InvoicePayment` resource. Older
// API versions (account-pinned <2025-02) still return the legacy field.
// Webhooks dispatch the Invoice payload using the account's pinned version,
// so we must handle both shapes — AND fall back to an API call when the
// payload carries neither.
//
// Why this matters: the returned id is embedded into the ledger row's
// `description` as `:charge:<id>:creator_share` / `:platform_fee`. Dispute
// clawback (`charge.dispute.created`) and refund handlers look up the
// original earning via `description.contains('charge:<dispute.charge>')`.
// If the id is missing, the lookup returns null and the clawback is
// silently skipped — creator keeps the earnings, platform eats the
// chargeback + dispute fee.
//
// Resolution order:
//   1. Legacy top-level `invoice.charge` (older API versions)
//   2. Embedded `invoice.payments.data[0].payment.charge` (if expansion
//      was requested or surfaced by webhook)
//   3. `stripe.invoicePayments.list({invoice})` then extract charge from
//      the first payment. If the payment is a PaymentIntent (subscription
//      invoices typically are), retrieve the PI and read `latest_charge`.
//   4. Return '' and log a warning so the regression is visible in logs.
async function extractInvoiceChargeId(
  stripe: Stripe,
  invoice: Stripe.Invoice,
): Promise<string> {
  // Path 1: legacy top-level field.
  const legacy = (invoice as { charge?: unknown }).charge;
  if (typeof legacy === 'string' && legacy.length > 0) return legacy;

  const invoiceId = typeof invoice.id === 'string' ? invoice.id : '';
  if (!invoiceId) return '';

  // Path 2: embedded payments. Only present if webhook payload included
  // expansion (Stripe doesn't expand by default, but operators may
  // override per-endpoint).
  const embedded = (invoice as { payments?: { data?: unknown } }).payments?.data;
  if (Array.isArray(embedded) && embedded.length > 0) {
    const id = extractChargeFromPayment(embedded[0]);
    if (id) return id;
  }

  // Path 3: explicit API fetch.
  try {
    const ipList = await stripe.invoicePayments.list({
      invoice: invoiceId,
      limit: 1,
    });
    const first = ipList.data[0];
    if (first) {
      const direct = extractChargeFromPayment(first);
      if (direct) return direct;
      // Payment is a PaymentIntent rather than a direct Charge — retrieve
      // the PI and read latest_charge.
      const piId = extractPaymentIntentId(first);
      if (piId) {
        const pi = await stripe.paymentIntents.retrieve(piId);
        const latest = (pi as { latest_charge?: unknown }).latest_charge;
        if (typeof latest === 'string' && latest.length > 0) return latest;
        if (
          latest &&
          typeof latest === 'object' &&
          'id' in latest &&
          typeof (latest as { id?: unknown }).id === 'string'
        ) {
          return (latest as { id: string }).id;
        }
      }
    }
  } catch (err) {
    // Re-throw infrastructure failures (auth revoked, network down, Stripe
    // 5xx) so the outer webhook handler returns a 5xx and Stripe retries.
    // Silently degrading would write a charge-less ledger row that the
    // dedup widening below tolerates, but on a sustained outage we'd lose
    // visibility — better to retry. Swallow only InvalidRequest errors
    // (genuinely "no payments for this invoice" — rare but valid).
    const errAny = err as { type?: string };
    if (
      errAny.type === 'StripeAuthenticationError' ||
      errAny.type === 'StripeConnectionError' ||
      errAny.type === 'StripeAPIError' ||
      errAny.type === 'StripePermissionError' ||
      errAny.type === 'StripeRateLimitError' ||
      // Idempotency conflict on Stripe's side (concurrent request with the
      // same idempotency key while server held the lock). Transient —
      // let Stripe retry.
      errAny.type === 'StripeIdempotencyError'
    ) {
      throw err;
    }
    console.warn(
      `[CreatorWebhook] InvoicePayments lookup non-fatal for invoice ${invoiceId}: ` +
        `${(err as Error).message}`,
    );
  }

  // Visible regression marker. If this fires in production, the ledger
  // row will lack the :charge: segment and dispute clawback will silently
  // degrade. Monitor for this log line.
  console.warn(
    `[CreatorWebhook] No charge id available for invoice ${invoiceId} ` +
      `— ledger row will lack :charge: segment, breaking dispute clawback lookups`,
  );
  return '';
}

function extractChargeFromPayment(payment: unknown): string {
  if (!payment || typeof payment !== 'object') return '';
  const pay = (payment as { payment?: unknown }).payment;
  if (!pay || typeof pay !== 'object') return '';
  const charge = (pay as { charge?: unknown }).charge;
  if (typeof charge === 'string' && charge.length > 0) return charge;
  if (
    charge &&
    typeof charge === 'object' &&
    'id' in charge &&
    typeof (charge as { id?: unknown }).id === 'string' &&
    (charge as { id: string }).id.length > 0
  ) {
    return (charge as { id: string }).id;
  }
  return '';
}

function extractPaymentIntentId(payment: unknown): string {
  if (!payment || typeof payment !== 'object') return '';
  const pay = (payment as { payment?: unknown }).payment;
  if (!pay || typeof pay !== 'object') return '';
  const pi = (pay as { payment_intent?: unknown }).payment_intent;
  if (typeof pi === 'string' && pi.length > 0) return pi;
  if (
    pi &&
    typeof pi === 'object' &&
    'id' in pi &&
    typeof (pi as { id?: unknown }).id === 'string' &&
    (pi as { id: string }).id.length > 0
  ) {
    return (pi as { id: string }).id;
  }
  return '';
}

async function getOrCreateStripeCustomer(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, stripeCustomerId: true },
  });
  if (!user) throw new Error('User not found');

  if (user.stripeCustomerId) return user.stripeCustomerId;

  const stripe = getStripeClient();
  const customer = await stripe.customers.create({
    email: user.email ?? undefined,
    metadata: { userId },
  });
  await prisma.user.update({
    where: { id: userId },
    data: { stripeCustomerId: customer.id },
    select: { id: true },
  });
  return customer.id;
}

export async function createCreatorCheckoutSession(
  subscriberUserId: string,
  creatorUserId: string
): Promise<string> {
  if (!config.creatorMonetizationEnabled) {
    throw new Error('Creator monetization is disabled');
  }
  if (subscriberUserId === creatorUserId) {
    throw new Error('Cannot subscribe to yourself');
  }

  // Defense-in-depth against sock-puppet self-dealing: also block when the subscriber and
  // creator share an email or Stripe customer (the same person via an alt account), not just
  // when the userId matches. A determined attacker with a separate email + card still needs
  // the payment-fingerprint check at charge time (tracked as P1 in docs/AUDIT.md) — but this
  // closes the lazy case. Purely additive: it can only reject, never grant.
  const [subscriberAcct, creatorAcct] = await Promise.all([
    prisma.user.findUnique({ where: { id: subscriberUserId }, select: { email: true, stripeCustomerId: true } }),
    prisma.user.findUnique({ where: { id: creatorUserId }, select: { email: true, stripeCustomerId: true } }),
  ]);
  const sameEmail = !!subscriberAcct?.email && !!creatorAcct?.email &&
    subscriberAcct.email.trim().toLowerCase() === creatorAcct.email.trim().toLowerCase();
  const sameStripeCustomer = !!subscriberAcct?.stripeCustomerId &&
    subscriberAcct.stripeCustomerId === creatorAcct?.stripeCustomerId;
  if (sameEmail || sameStripeCustomer) {
    throw new Error('Cannot subscribe to yourself');
  }

  // Prevent duplicate subscriptions — block if active, trialing, or canceled but still within paid period
  const existingSub = await prisma.creatorSubscription.findUnique({
    where: { subscriberUserId_creatorUserId: { subscriberUserId, creatorUserId } },
    select: { status: true, currentPeriodEnd: true },
  });
  if (existingSub) {
    const stillEntitled = existingSub.status === 'active' || existingSub.status === 'trialing'
      || (existingSub.currentPeriodEnd && existingSub.currentPeriodEnd > new Date());
    if (stillEntitled) {
      throw new Error('Already subscribed to this creator');
    }
  }

  const creator = await prisma.creator.findUnique({
    where: { userId: creatorUserId },
    select: {
      status: true,
      pricingCents: true,
      trialDays: true,
      stripeConnectId: true,
      user: { select: { displayName: true } },
    },
  });
  if (!creator || creator.status !== 'active') {
    throw new Error('Creator unavailable');
  }
  if (!creator.stripeConnectId) {
    throw new Error('Creator payout account not configured');
  }

  const stripe = getStripeClient();
  const customerId = await getOrCreateStripeCustomer(subscriberUserId);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        recurring: { interval: 'month' },
        unit_amount: creator.pricingCents,
        product_data: {
          name: `${creator.user.displayName} Insights`,
          description: 'Educational content only. Not investment advice.',
        },
      },
    }],
    success_url: `${config.stripeReturnUrl}?creator_subscribe=success&creator=${creatorUserId}`,
    cancel_url: `${config.stripeReturnUrl}?creator_subscribe=cancel&creator=${creatorUserId}`,
    metadata: {
      creatorUserId,
      subscriberUserId,
    },
    subscription_data: {
      // Charges land on the platform balance. The 80/20 split is recorded in
      // CreatorWalletLedger by the invoice.paid handler, and the creator's
      // share is moved via stripe.transfers.create in requestPayout. This
      // replaces the previous destination-charge model whose auto-transfer
      // combined with the manual transfer produced a double-payment (audit C1).
      metadata: {
        creatorUserId,
        subscriberUserId,
      },
    },
    allow_promotion_codes: false,
  });

  if (!session.url) throw new Error('Checkout URL missing');
  return session.url;
}

export async function cancelCreatorSubscription(subscriberUserId: string, creatorUserId: string): Promise<void> {
  const sub = await prisma.creatorSubscription.findUnique({
    where: {
      subscriberUserId_creatorUserId: {
        subscriberUserId,
        creatorUserId,
      },
    },
    select: { stripeSubscriptionId: true, id: true },
  });
  if (!sub?.stripeSubscriptionId) {
    throw new Error('Active subscription not found');
  }

  const stripe = getStripeClient();
  await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });
}

async function markWebhookProcessed(eventId: string, eventType: string): Promise<boolean> {
  try {
    await prisma.creatorWebhookEvent.create({
      data: { eventId, eventType },
    });
    return true;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002') {
      return false;
    }
    throw error;
  }
}

async function resolveStripeSubscriptionIdFromCharge(charge: Stripe.Charge, stripe: Stripe): Promise<string | null> {
  const invoiceRef = (charge as Stripe.Charge & { invoice?: unknown }).invoice;
  let invoice: Stripe.Invoice | null = null;

  if (typeof invoiceRef === 'string') {
    const fetched = await stripe.invoices.retrieve(invoiceRef);
    if (!('deleted' in fetched)) {
      invoice = fetched as Stripe.Invoice;
    }
  } else if (invoiceRef && typeof invoiceRef === 'object') {
    invoice = invoiceRef as Stripe.Invoice;
  }

  const sub = (invoice as (Stripe.Invoice & { subscription?: unknown }) | null)?.subscription;
  return typeof sub === 'string' ? sub : null;
}

async function resolveSubscriptionFromDispute(dispute: Stripe.Dispute, stripe: Stripe): Promise<{
  id: string;
  creatorUserId: string;
  stripeSubscriptionId: string;
} | null> {
  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : null;
  if (!chargeId) return null;

  const charge = await stripe.charges.retrieve(chargeId);
  if (!charge || (charge as { object?: string }).object !== 'charge') return null;

  const stripeSubscriptionId = await resolveStripeSubscriptionIdFromCharge(charge as Stripe.Charge, stripe);
  if (!stripeSubscriptionId) return null;

  const sub = await prisma.creatorSubscription.findFirst({
    where: { stripeSubscriptionId: { equals: stripeSubscriptionId } },
    select: { id: true, creatorUserId: true, stripeSubscriptionId: true },
  });
  if (!sub?.stripeSubscriptionId) return null;
  return {
    id: sub.id,
    creatorUserId: sub.creatorUserId,
    stripeSubscriptionId: sub.stripeSubscriptionId,
  };
}

export async function handleCreatorWebhookEvent(event: Stripe.Event): Promise<void> {
  const shouldProcess = await markWebhookProcessed(event.id, event.type);
  if (!shouldProcess) {
    bumpCounter('deduped');
    recordWebhookEvent('creator', 'deduped', event.type);
    logCreatorBilling({
      outcome: 'deduped',
      eventId: event.id,
      eventType: event.type,
    });
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const creatorUserId = session.metadata?.creatorUserId;
        const subscriberUserId = session.metadata?.subscriberUserId;
        const stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : null;
        if (!creatorUserId || !subscriberUserId || !stripeSubscriptionId) return;

        // If a `customer.subscription.updated` raced ahead of us (A2 fallback
        // could have already upserted a row carrying status='canceled' or
        // 'past_due'), don't clobber that signal by force-setting active.
        // Only mutate to 'active' when the existing row (if any) is in a
        // non-terminal state. For brand-new rows the create branch sets it.
        const existingForCheckout = await prisma.creatorSubscription.findUnique({
          where: { subscriberUserId_creatorUserId: { subscriberUserId, creatorUserId } },
          select: { id: true, status: true },
        });
        const checkoutUpdateData: { status?: string; stripeSubscriptionId: string; canceledAt?: Date | null } = {
          stripeSubscriptionId,
        };
        if (!existingForCheckout || (existingForCheckout.status !== 'canceled' && existingForCheckout.status !== 'past_due' && existingForCheckout.status !== 'expired')) {
          checkoutUpdateData.status = 'active';
          checkoutUpdateData.canceledAt = null;
        }
        await prisma.creatorSubscription.upsert({
          where: {
            subscriberUserId_creatorUserId: {
              subscriberUserId,
              creatorUserId,
            },
          },
          update: checkoutUpdateData,
          create: {
            subscriberUserId,
            creatorUserId,
            status: 'active',
            stripeSubscriptionId,
          },
        });

        const sub = await prisma.creatorSubscription.findUnique({
          where: {
            subscriberUserId_creatorUserId: {
              subscriberUserId,
              creatorUserId,
            },
          },
          select: { id: true },
        });
        if (sub) {
          await prisma.creatorSubscriptionEvent.create({
            data: {
              subscriptionId: sub.id,
              eventType: 'created',
            },
          });
          // Ledger entry is created by invoice.paid handler — NOT here.
          // Creating here would double-credit since both events fire for the same payment.
        }
        bumpCounter('processed');
        logCreatorBilling({
          outcome: 'processed',
          eventId: event.id,
          eventType: event.type,
          creatorUserId,
          subscriptionId: sub?.id ?? null,
        });
        return;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const stripeSubscriptionId = subscription.id;
        const currentPeriodEndUnix = subscription.items.data[0]?.current_period_end ?? null;
        // Map Stripe's actual status — handle all known statuses
        const stripeStatus = subscription.status;
        let mappedStatus: string;
        if (stripeStatus === 'canceled' || stripeStatus === 'unpaid' || stripeStatus === 'incomplete_expired') {
          mappedStatus = 'canceled';
        } else if (stripeStatus === 'past_due' || stripeStatus === 'incomplete') {
          mappedStatus = 'past_due';
        } else if (stripeStatus === 'paused') {
          mappedStatus = 'past_due';
        } else if (stripeStatus === 'trialing') {
          mappedStatus = 'trialing';
        } else if (stripeStatus === 'active' && subscription.cancel_at_period_end) {
          // Still active until period end — keep active so access isn't revoked early
          mappedStatus = 'active';
        } else {
          mappedStatus = 'active';
        }
        // Don't overwrite currentPeriodEnd for past_due — invoice.payment_failed already expired it
        const shouldUpdatePeriodEnd = mappedStatus !== 'past_due' && currentPeriodEndUnix;
        const updateData = {
          status: mappedStatus,
          ...(shouldUpdatePeriodEnd ? { currentPeriodEnd: new Date(currentPeriodEndUnix * 1000) } : {}),
          canceledAt: subscription.cancel_at_period_end ? new Date() : null,
        };
        const updateResult = await prisma.creatorSubscription.updateMany({
          where: { stripeSubscriptionId },
          data: updateData,
        });
        // Out-of-order delivery: subscription.updated arrived before
        // checkout.session.completed / invoice.paid created the local row.
        // Without this fallback the cancellation/state signal would be lost
        // until the next webhook on this subscription. Mirror invoice.paid's
        // metadata-lookup pattern: pull creatorUserId/subscriberUserId from
        // the Stripe subscription's metadata (we set it at checkout creation)
        // and upsert so the signal lands.
        if (updateResult.count === 0) {
          const creatorUserId = subscription.metadata?.creatorUserId;
          const subscriberUserId = subscription.metadata?.subscriberUserId;
          if (creatorUserId && subscriberUserId) {
            await prisma.creatorSubscription.upsert({
              where: { subscriberUserId_creatorUserId: { subscriberUserId, creatorUserId } },
              update: { ...updateData, stripeSubscriptionId },
              create: {
                subscriberUserId,
                creatorUserId,
                stripeSubscriptionId,
                ...updateData,
              },
            });
          } else {
            console.warn(`[CreatorWebhook] customer.subscription.updated for unknown sub ${stripeSubscriptionId} — no metadata fallback (creatorUserId=${creatorUserId}, subscriberUserId=${subscriberUserId})`);
          }
        }
        bumpCounter('processed');
        logCreatorBilling({
          outcome: 'processed',
          eventId: event.id,
          eventType: event.type,
          subscriptionId: stripeSubscriptionId,
          upserted: updateResult.count === 0,
        });
        return;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await prisma.creatorSubscription.updateMany({
          where: { stripeSubscriptionId: subscription.id },
          data: {
            status: 'expired',
            canceledAt: new Date(),
          },
        });
        bumpCounter('processed');
        logCreatorBilling({
          outcome: 'processed',
          eventId: event.id,
          eventType: event.type,
          subscriptionId: subscription.id,
        });
        return;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const maybeSubscription = (invoice as Stripe.Invoice & { subscription?: unknown }).subscription;
        const stripeSubscriptionId = typeof maybeSubscription === 'string' ? maybeSubscription : null;
        if (!stripeSubscriptionId) return;
        const amountPaid = invoice.amount_paid;
        if (typeof amountPaid !== 'number' || !Number.isFinite(amountPaid) || amountPaid <= 0) return;

        let sub = await prisma.creatorSubscription.findFirst({
          where: { stripeSubscriptionId },
          select: { id: true, creatorUserId: true },
        });
        // invoice.paid can arrive before checkout.session.completed — resolve from Stripe subscription metadata
        if (!sub) {
          try {
            const stripe = getStripeClient();
            const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
            const creatorUserId = stripeSub.metadata?.creatorUserId;
            const subscriberUserId = stripeSub.metadata?.subscriberUserId;
            if (creatorUserId && subscriberUserId) {
              const created = await prisma.creatorSubscription.upsert({
                where: { subscriberUserId_creatorUserId: { subscriberUserId, creatorUserId } },
                update: { status: 'active', stripeSubscriptionId, canceledAt: null },
                create: { subscriberUserId, creatorUserId, status: 'active', stripeSubscriptionId },
              });
              sub = { id: created.id, creatorUserId };
            }
          } catch (lookupErr) {
            // Stripe lookup failure: re-throw so the outer catch deletes the
            // CreatorWebhookEvent dedup row and Stripe retries. Silently
            // returning here would permanently lose the invoice.paid event
            // (no ledger credit, no creator earnings, no retry).
            throw lookupErr;
          }
          if (!sub) return;
        }

        const invoiceWithFee = invoice as Stripe.Invoice & { application_fee_amount?: number | null };
        // Legacy destination-charge subs created before the audit-C1 fix still carry
        // transfer_data on the Stripe subscription, so their invoices have an
        // application_fee_amount and 80% has ALREADY been auto-transferred to the
        // creator's Connect account by Stripe. Mark those ledger rows with a
        // ':legacy_destination' suffix so getPayoutBalance can exclude them — otherwise
        // requestPayout would transfer the same 80% a second time from platform balance.
        const isLegacyDestinationCharge = typeof invoiceWithFee.application_fee_amount === 'number';
        const legacySuffix = isLegacyDestinationCharge ? ':legacy_destination' : '';
        // Embed the chargeId so dispute / refund handlers can look up the original
        // earning by charge id (description.contains('charge:${chargeId}')). On
        // Stripe API 2025-02+ the legacy `invoice.charge` field is gone, so the
        // helper falls through to an InvoicePayments lookup. See
        // `extractInvoiceChargeId` JSDoc for the full resolution chain.
        const invoiceChargeId = await extractInvoiceChargeId(getStripeClient(), invoice);
        const chargeSegment = invoiceChargeId ? `:charge:${invoiceChargeId}` : '';
        const creatorEventKey = `stripe_event:${event.id}${chargeSegment}:creator_share${legacySuffix}`;
        const platformEventKey = `stripe_event:${event.id}${chargeSegment}:platform_fee${legacySuffix}`;
        // Dedup by event-id PREFIX, NOT exact description match. The charge
        // segment is variable across retries (Stripe API outage / transient
        // failure on Path 3 of extractInvoiceChargeId could resolve '' on
        // delivery 1 then the real id on delivery 2 → two distinct exact
        // keys → double credit). Matching on `stripe_event:<event.id>:` is
        // sufficient: the event id is the unique anchor across all retries
        // for one Stripe event, and is the same regardless of whether the
        // charge segment is present.
        //
        // The TRAILING COLON is load-bearing: without it, `startsWith` would
        // false-positive across event ids that share a prefix (e.g.,
        // `evt_paid_1` would match rows for `evt_paid_10`). Production Stripe
        // event ids are fixed-length opaque tokens so the collision is
        // probabilistically zero — but test seeds and future-format changes
        // are not. Always include the colon.
        const eventKeyPrefix = `stripe_event:${event.id}:`;
        const alreadyCredited = await prisma.creatorWalletLedger.findFirst({
          where: {
            creatorUserId: sub.creatorUserId,
            description: { startsWith: eventKeyPrefix },
          },
          select: { id: true },
        });
        if (alreadyCredited) return;

        const { creatorCents: creatorShare, platformCents: platformShare } = splitCreatorRevenueCents(
          amountPaid,
          invoiceWithFee.application_fee_amount
        );

        await prisma.$transaction([
          v1LedgerCreate(prisma,{
            data: {
              creatorUserId: sub.creatorUserId,
              type: 'earning',
              amountCents: creatorShare,
              subscriptionId: sub.id,
              description: creatorEventKey,
            },
          }),
          v1LedgerCreate(prisma,{
            data: {
              creatorUserId: sub.creatorUserId,
              type: 'platform_fee',
              amountCents: platformShare,
              subscriptionId: sub.id,
              description: platformEventKey,
            },
          }),
          prisma.creatorSubscriptionEvent.create({
            data: {
              subscriptionId: sub.id,
              eventType: 'renewed',
            },
          }),
        ]);
        // v2 shadow-write: gated by V2_SHADOW_WRITE_ENABLED env. The helper
        // catches all errors internally so they CANNOT propagate to the v1
        // webhook response. We FIRE-AND-FORGET (no await) because:
        //   1. The handler doesn't depend on v2 success — v1 is the source
        //      of truth, v2 is a parallel observer.
        //   2. await would block the Stripe webhook response on v2's
        //      Postgres round-trip. If v2's database is degraded during a
        //      traffic spike, every webhook would eat the connect timeout
        //      and push response latency past Stripe's 30s budget,
        //      triggering retries and amplifying load.
        //   3. The .catch fallback is defensive — the helper SHOULD swallow
        //      all errors internally, but if it ever leaks an exception
        //      we still want it logged, not unhandled.
        // eventGroupId is a deterministic UUID v4 derived from event.id so
        // Stripe retries and MIG-1 backfill converge on the same v2 entry.
        void shadowWriteInvoicePaid({
          stripeEventId: event.id,
          stripeInvoiceId: typeof invoice.id === 'string' ? invoice.id : '',
          stripeChargeId: invoiceChargeId,
          creatorUserId: sub.creatorUserId,
          creatorShareCents: creatorShare,
          platformShareCents: platformShare,
          isLegacyDestination: isLegacyDestinationCharge,
          // event.created is Unix seconds (Stripe API). Multiply by 1000.
          // Falls back to `now()` if absent.
          effectiveAt: typeof event.created === 'number'
            ? new Date(event.created * 1000)
            : new Date(),
        }).catch((err) => {
          console.warn(`[v2-shadow] unexpected leak from shadow-write: ${(err as Error).message}`);
        });
        bumpCounter('processed');
        logCreatorBilling({
          outcome: 'processed',
          eventId: event.id,
          eventType: event.type,
          creatorUserId: sub.creatorUserId,
          subscriptionId: sub.id,
          amountPaid,
        });
        return;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const maybeSubscription = (invoice as Stripe.Invoice & { subscription?: unknown }).subscription;
        const stripeSubscriptionId = typeof maybeSubscription === 'string' ? maybeSubscription : null;
        if (!stripeSubscriptionId) return;

        await prisma.creatorSubscription.updateMany({
          where: { stripeSubscriptionId },
          data: {
            status: 'past_due',
            // Ensure access resolution no longer treats this as paid access.
            currentPeriodEnd: new Date(Date.now() - 1000),
          },
        });
        bumpCounter('processed');
        logCreatorBilling({
          outcome: 'processed',
          eventId: event.id,
          eventType: event.type,
          subscriptionId: stripeSubscriptionId,
        });
        return;
      }

      case 'charge.refunded': {
        const stripe = getStripeClient();
        const charge = event.data.object as Stripe.Charge;
        const stripeSubscriptionId = await resolveStripeSubscriptionIdFromCharge(charge, stripe);
        if (!stripeSubscriptionId) return;

        const sub = await prisma.creatorSubscription.findFirst({
          where: { stripeSubscriptionId },
          select: { id: true, creatorUserId: true },
        });
        if (!sub) return;

        const cumulativeRefunded = typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;
        if (cumulativeRefunded <= 0) return;

        // charge.amount_refunded is CUMULATIVE across all refund events for THIS CHARGE.
        // Scope refund tracking per-charge (not per-subscription) so multi-month refunds are independent.
        const chargeId = typeof charge.id === 'string' ? charge.id : '';
        const chargeToken = `charge:${chargeId}`;
        // NET previously-debited amounts, mirroring charge.dispute.created: sum the prior
        // refund + dispute-clawback DEBITS and SUBTRACT any dispute-WON RESTORES. Without
        // subtracting the restores, an earn -> dispute clawback -> dispute WON (restore) ->
        // refund sequence left previouslyDebited == the full share, so incremental == 0 and
        // the refund row was never written — the creator kept money the platform refunded to
        // the buyer (bug F1). type='refund' rows are always negative, so contains(chargeToken)
        // catches refund_creator + dispute_clawback_creator; the dispute_fee row has no
        // ":charge:" segment and is correctly excluded.
        const [creatorRefundDebits, creatorDisputeRestores, platformRefundDebits, platformDisputeRestores] =
          await Promise.all([
            prisma.creatorWalletLedger.findMany({
              where: { creatorUserId: sub.creatorUserId, type: 'refund', description: { contains: chargeToken }, amountCents: { lt: 0 } },
              select: { amountCents: true },
            }),
            prisma.creatorWalletLedger.findMany({
              where: { creatorUserId: sub.creatorUserId, type: 'earning', description: { contains: `${chargeToken}:dispute_won_restore_creator` } },
              select: { amountCents: true },
            }),
            prisma.creatorWalletLedger.findMany({
              where: { creatorUserId: sub.creatorUserId, type: 'platform_fee', description: { contains: chargeToken }, amountCents: { lt: 0 } },
              select: { amountCents: true },
            }),
            prisma.creatorWalletLedger.findMany({
              where: { creatorUserId: sub.creatorUserId, type: 'platform_fee', description: { contains: `${chargeToken}:dispute_won_restore_platform` } },
              select: { amountCents: true },
            }),
          ]);
        const sumAbs = (entries: { amountCents: number }[]) => entries.reduce((sum, r) => sum + Math.abs(r.amountCents), 0);
        const previouslyDebitedCreator = Math.max(0, sumAbs(creatorRefundDebits) - sumAbs(creatorDisputeRestores));
        const totalCreatorShare = getCumulativeCreatorRefundCents(charge);
        const incrementalCreator = totalCreatorShare - previouslyDebitedCreator;
        if (incrementalCreator <= 0) return; // Already fully accounted for

        const previouslyDebitedPlatform = Math.max(0, sumAbs(platformRefundDebits) - sumAbs(platformDisputeRestores));
        const totalPlatformRefund = cumulativeRefunded - totalCreatorShare;
        const incrementalPlatform = totalPlatformRefund - previouslyDebitedPlatform;
        if (incrementalPlatform < 0) return;

        const creatorRefund = -incrementalCreator;
        const platformRefund = -incrementalPlatform;
        const creatorRefundKey = `stripe_event:${event.id}:charge:${chargeId}:refund_creator`;
        const platformRefundKey = `stripe_event:${event.id}:charge:${chargeId}:refund_platform`;

        await prisma.$transaction([
          v1LedgerCreate(prisma,{
            data: {
              creatorUserId: sub.creatorUserId,
              type: 'refund',
              amountCents: creatorRefund,
              subscriptionId: sub.id,
              description: creatorRefundKey,
            },
          }),
          v1LedgerCreate(prisma,{
            data: {
              creatorUserId: sub.creatorUserId,
              type: 'platform_fee',
              amountCents: platformRefund,
              subscriptionId: sub.id,
              description: platformRefundKey,
            },
          }),
        ]);

        const amount = typeof charge.amount === 'number' ? charge.amount : 0;
        if (amount > 0 && cumulativeRefunded >= amount) {
          await prisma.creatorSubscription.update({
            where: { id: sub.id },
            data: {
              status: 'canceled',
              canceledAt: new Date(),
              currentPeriodEnd: new Date(Date.now() - 1000),
            },
          });
          await prisma.creatorSubscriptionEvent.create({
            data: {
              subscriptionId: sub.id,
              eventType: 'canceled',
            },
          });
        }
        // v2 shadow-write fires AFTER all v1 mutations succeed so v2
        // reflects "v1 finalized this delivery" — not a partial state where
        // refund rows are in v1 but the subscription cancellation update
        // threw and rolled back. Fire-and-forget; the helper swallows all
        // errors internally so v2 outage cannot block v1.
        // Uses the SAME idempotencySuffix scheme as MIG-1 G2
        // (stripe_clearing / creator_refund / platform_refund) so cross-
        // writer convergence with backfill dedups cleanly. Amounts passed
        // are INCREMENTAL (v1 handler already computed the delta).
        void shadowWriteChargeRefunded({
          stripeEventId: event.id,
          stripeChargeId: chargeId,
          creatorUserId: sub.creatorUserId,
          incrementalCreatorCents: incrementalCreator,
          incrementalPlatformCents: incrementalPlatform,
          effectiveAt: typeof event.created === 'number'
            ? new Date(event.created * 1000)
            : new Date(),
        }).catch((err) => {
          console.warn(`[v2-shadow] unexpected leak from shadow-write: ${(err as Error).message}`);
        });
        bumpCounter('refunded');
        bumpCounter('processed');
        logCreatorBilling({
          outcome: 'processed',
          eventId: event.id,
          eventType: event.type,
          creatorUserId: sub.creatorUserId,
          subscriptionId: sub.id,
          amountRefunded: cumulativeRefunded,
          fullRefund: amount > 0 && cumulativeRefunded >= amount,
        });
        return;
      }

      case 'charge.dispute.created': {
        const stripe = getStripeClient();
        const dispute = event.data.object as Stripe.Dispute;
        const sub = await resolveSubscriptionFromDispute(dispute, stripe);
        if (!sub) return;

        const reason = dispute.reason ?? 'unknown';
        const disputeChargeId = typeof dispute.charge === 'string' ? dispute.charge : '';
        console.error(`[CreatorWebhook] Dispute created for subscription ${sub.id}: reason=${reason}, chargeId=${disputeChargeId}`);

        // Locate the original earning + platform_fee for this charge so we can
        // claw them back. Requires the post-20260527 ':charge:<id>' segment in
        // descriptions — legacy rows without it can't be matched and the clawback
        // degrades to "dispute fee only" with a warning log.
        //
        // Lookups are pinned to the exact suffix `:creator_share` / `:platform_fee`
        // so they ONLY match the original credit rows, not the restore rows
        // written by `dispute.closed (won)` (`:dispute_won_restore_*`). Without
        // that pin, a second dispute on a previously-won charge could pick up
        // the restore row instead of the original earning and over-debit.
        let originalEarning: { amountCents: number } | null = null;
        let originalPlatform: { amountCents: number } | null = null;
        let prevDebitedCreator = 0;
        let prevDebitedPlatform = 0;
        if (disputeChargeId) {
          const chargeToken = `charge:${disputeChargeId}`;
          [originalEarning, originalPlatform] = await Promise.all([
            prisma.creatorWalletLedger.findFirst({
              where: {
                creatorUserId: sub.creatorUserId,
                type: 'earning',
                description: { contains: `${chargeToken}:creator_share` },
              },
              select: { amountCents: true },
              orderBy: { createdAt: 'desc' },
            }),
            prisma.creatorWalletLedger.findFirst({
              where: {
                creatorUserId: sub.creatorUserId,
                type: 'platform_fee',
                description: { contains: `${chargeToken}:platform_fee` },
                amountCents: { gt: 0 }, // exclude prior negative platform_fee rows (refunds/clawbacks)
              },
              select: { amountCents: true },
              orderBy: { createdAt: 'desc' },
            }),
          ]);
          // Compute the NET previously-debited amounts so we don't double-debit
          // on refund→dispute / re-dispute sequences AND we correctly re-claw on
          // won-then-redispute sequences. Net = |negative debits| - |positive
          // restores|. Sums ALL relevant rows for this charge.
          //
          // Creator side: type='refund' debit rows (refund_creator + dispute_clawback_creator)
          //               vs. type='earning' restore rows (:dispute_won_restore_creator).
          // Platform side: type='platform_fee' negative rows (refund_platform + dispute_clawback_platform)
          //                vs. type='platform_fee' positive restore rows (:dispute_won_restore_platform).
          const [prevCreatorDebits, prevCreatorRestores, prevPlatformDebits, prevPlatformRestores] = await Promise.all([
            prisma.creatorWalletLedger.findMany({
              where: {
                creatorUserId: sub.creatorUserId,
                type: 'refund',
                description: { contains: chargeToken },
                amountCents: { lt: 0 },
              },
              select: { amountCents: true },
            }),
            prisma.creatorWalletLedger.findMany({
              where: {
                creatorUserId: sub.creatorUserId,
                type: 'earning',
                description: { contains: `${chargeToken}:dispute_won_restore_creator` },
              },
              select: { amountCents: true },
            }),
            prisma.creatorWalletLedger.findMany({
              where: {
                creatorUserId: sub.creatorUserId,
                type: 'platform_fee',
                description: { contains: chargeToken },
                amountCents: { lt: 0 },
              },
              select: { amountCents: true },
            }),
            prisma.creatorWalletLedger.findMany({
              where: {
                creatorUserId: sub.creatorUserId,
                type: 'platform_fee',
                description: { contains: `${chargeToken}:dispute_won_restore_platform` },
              },
              select: { amountCents: true },
            }),
          ]);
          const grossDebitedCreator = prevCreatorDebits.reduce((sum, r) => sum + Math.abs(r.amountCents), 0);
          const grossRestoredCreator = prevCreatorRestores.reduce((sum, r) => sum + Math.abs(r.amountCents), 0);
          prevDebitedCreator = Math.max(0, grossDebitedCreator - grossRestoredCreator);
          const grossDebitedPlatform = prevPlatformDebits.reduce((sum, r) => sum + Math.abs(r.amountCents), 0);
          const grossRestoredPlatform = prevPlatformRestores.reduce((sum, r) => sum + Math.abs(r.amountCents), 0);
          prevDebitedPlatform = Math.max(0, grossDebitedPlatform - grossRestoredPlatform);
        }

        const writes: Prisma.PrismaPromise<unknown>[] = [
          prisma.creatorSubscription.update({
            where: { id: sub.id },
            data: {
              status: 'past_due',
              disputedAt: new Date(),
              currentPeriodEnd: new Date(Date.now() - 1000),
            },
          }),
          v1LedgerCreate(prisma,{
            data: {
              creatorUserId: sub.creatorUserId,
              type: 'refund',
              amountCents: -1500,
              subscriptionId: sub.id,
              description: `stripe_event:${event.id}:dispute_fee:${reason}`,
            },
          }),
        ];

        let clawbackAmountCents = 0;
        let platformClawbackCents = 0;
        if (originalEarning && originalEarning.amountCents > 0 && disputeChargeId) {
          clawbackAmountCents = Math.max(0, originalEarning.amountCents - prevDebitedCreator);
          if (clawbackAmountCents > 0) {
            writes.push(v1LedgerCreate(prisma,{
              data: {
                creatorUserId: sub.creatorUserId,
                type: 'refund',
                amountCents: -clawbackAmountCents,
                subscriptionId: sub.id,
                description: `stripe_event:${event.id}:charge:${disputeChargeId}:dispute_clawback_creator`,
              },
            }));
          }
        } else if (disputeChargeId) {
          console.warn(`[CreatorWebhook] Dispute ${event.id} on charge ${disputeChargeId}: no matching earning row for sub ${sub.id} — clawback skipped, dispute fee only`);
        }

        if (originalPlatform && originalPlatform.amountCents > 0 && disputeChargeId) {
          platformClawbackCents = Math.max(0, originalPlatform.amountCents - prevDebitedPlatform);
          if (platformClawbackCents > 0) {
            writes.push(v1LedgerCreate(prisma,{
              data: {
                creatorUserId: sub.creatorUserId,
                type: 'platform_fee',
                amountCents: -platformClawbackCents,
                subscriptionId: sub.id,
                description: `stripe_event:${event.id}:charge:${disputeChargeId}:dispute_clawback_platform`,
              },
            }));
          }
        }

        await prisma.$transaction(writes);
        // v2 shadow-write: fire-and-forget after v1 mutations succeed. Uses
        // the IDENTICAL scheme MIG-1 G3 mapper uses (DISPUTE_LOST eventType +
        // 'creator_clawback'/'platform_clawback' suffixes + component
        // breakdown metadata) so cross-writer convergence dedups cleanly.
        void shadowWriteChargeDisputeCreated({
          stripeEventId: event.id,
          stripeChargeId: disputeChargeId,
          creatorUserId: sub.creatorUserId,
          feeAmountCents: 1500,
          creatorClawbackCents: clawbackAmountCents,
          platformClawbackCents: platformClawbackCents,
          effectiveAt: typeof event.created === 'number'
            ? new Date(event.created * 1000)
            : new Date(),
        }).catch((err) => {
          console.warn(`[v2-shadow] unexpected leak from shadow-write: ${(err as Error).message}`);
        });
        bumpCounter('disputed');
        bumpCounter('processed');
        logCreatorBilling({
          outcome: 'processed',
          eventId: event.id,
          eventType: event.type,
          creatorUserId: sub.creatorUserId,
          subscriptionId: sub.id,
          reason,
          chargeId: disputeChargeId,
          clawbackAmountCents,
        });
        return;
      }

      case 'charge.dispute.closed': {
        const stripe = getStripeClient();
        const dispute = event.data.object as Stripe.Dispute;
        const sub = await resolveSubscriptionFromDispute(dispute, stripe);
        if (!sub) return;

        const outcome = dispute.status ?? 'unknown';
        if (outcome === 'won') {
          // Restore access: fetch real period end from Stripe
          let currentPeriodEnd: Date | null = null;
          try {
            const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
            const periodEndUnix = stripeSub.items.data[0]?.current_period_end;
            if (periodEndUnix) currentPeriodEnd = new Date(periodEndUnix * 1000);
          } catch { /* use null if retrieval fails */ }

          await prisma.creatorSubscription.update({
            where: { id: sub.id },
            data: {
              status: 'active',
              disputedAt: null,
              ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
            },
          });

          // Dispute won — restore the creator + platform clawback from
          // dispute.created and reverse the $15 dispute fee.
          const wonChargeId = typeof dispute.charge === 'string' ? dispute.charge : '';
          // Hoisted so the shadow-write call below can read them after the
          // `if (wonChargeId)` block closes; zero when no corresponding G3
          // clawback row was found.
          let wonCreatorRestoreCents = 0;
          let wonPlatformRestoreCents = 0;
          const restoreWrites: Prisma.PrismaPromise<unknown>[] = [
            // Reverse the $15 dispute fee (original was type=refund:-1500, so add back as earning)
            v1LedgerCreate(prisma,{
              data: {
                creatorUserId: sub.creatorUserId,
                type: 'earning',
                amountCents: 1500,
                subscriptionId: sub.id,
                description: `stripe_event:${event.id}:dispute_fee_reversal`,
              },
            }),
          ];
          if (wonChargeId) {
            const [creatorClawback, platformClawback] = await Promise.all([
              prisma.creatorWalletLedger.findFirst({
                where: {
                  creatorUserId: sub.creatorUserId,
                  type: 'refund',
                  description: { contains: `charge:${wonChargeId}:dispute_clawback_creator` },
                },
                select: { amountCents: true },
              }),
              prisma.creatorWalletLedger.findFirst({
                where: {
                  creatorUserId: sub.creatorUserId,
                  type: 'platform_fee',
                  description: { contains: `charge:${wonChargeId}:dispute_clawback_platform` },
                },
                select: { amountCents: true },
              }),
            ]);
            if (creatorClawback && creatorClawback.amountCents < 0) {
              wonCreatorRestoreCents = Math.abs(creatorClawback.amountCents);
              restoreWrites.push(v1LedgerCreate(prisma,{
                data: {
                  creatorUserId: sub.creatorUserId,
                  type: 'earning',
                  amountCents: wonCreatorRestoreCents,
                  subscriptionId: sub.id,
                  description: `stripe_event:${event.id}:charge:${wonChargeId}:dispute_won_restore_creator`,
                },
              }));
            }
            if (platformClawback && platformClawback.amountCents < 0) {
              wonPlatformRestoreCents = Math.abs(platformClawback.amountCents);
              restoreWrites.push(v1LedgerCreate(prisma,{
                data: {
                  creatorUserId: sub.creatorUserId,
                  type: 'platform_fee',
                  amountCents: wonPlatformRestoreCents,
                  subscriptionId: sub.id,
                  description: `stripe_event:${event.id}:charge:${wonChargeId}:dispute_won_restore_platform`,
                },
              }));
            }
          }
          await prisma.$transaction(restoreWrites);
          // v2 shadow-write — locks in the scheme MIG-1 G4 mapper uses
          // (RESTORE_AFTER_DISPUTE_WON + 'creator_restore'/'platform_restore'
          // suffixes + component-breakdown metadata). Amounts mirror what
          // v1 just wrote (Math.abs of the prior clawback rows; zero when
          // no corresponding clawback existed).
          void shadowWriteChargeDisputeClosedWon({
            stripeEventId: event.id,
            stripeChargeId: wonChargeId,
            creatorUserId: sub.creatorUserId,
            feeReversalCents: 1500,
            creatorRestoreCents: wonCreatorRestoreCents,
            platformRestoreCents: wonPlatformRestoreCents,
            effectiveAt: typeof event.created === 'number'
              ? new Date(event.created * 1000)
              : new Date(),
          }).catch((err) => {
            console.warn(`[v2-shadow] unexpected leak from shadow-write: ${(err as Error).message}`);
          });
        } else {
          await prisma.creatorSubscription.update({
            where: { id: sub.id },
            data: {
              status: 'canceled',
              canceledAt: new Date(),
            },
          });
        }
        bumpCounter('processed');
        logCreatorBilling({
          outcome: 'processed',
          eventId: event.id,
          eventType: event.type,
          creatorUserId: sub.creatorUserId,
          subscriptionId: sub.id,
          disputeOutcome: outcome,
        });
        return;
      }

      case 'account.updated': {
        const account = event.data.object as Stripe.Account;
        if (!account.id) { bumpCounter('processed'); return; }
        const creator = await prisma.creator.findFirst({
          where: { stripeConnectId: account.id },
          select: { userId: true, stripeConnectOnboarded: true },
        });
        if (creator) {
          const isEnabled = !!(account.charges_enabled && account.payouts_enabled);
          if (isEnabled && !creator.stripeConnectOnboarded) {
            await prisma.creator.update({
              where: { userId: creator.userId },
              data: { stripeConnectOnboarded: true },
            });
            logCreatorBilling({
              outcome: 'processed', eventId: event.id, eventType: event.type,
              stripeConnectId: account.id, creatorUserId: creator.userId, action: 'onboarded',
            });
          } else if (!isEnabled && creator.stripeConnectOnboarded) {
            // Connect account deactivated — disable creator monetization
            await prisma.creator.update({
              where: { userId: creator.userId },
              data: { stripeConnectOnboarded: false },
            });
            logCreatorBilling({
              outcome: 'processed', eventId: event.id, eventType: event.type,
              stripeConnectId: account.id, creatorUserId: creator.userId, action: 'deactivated',
            });
          }
        }
        bumpCounter('processed');
        return;
      }

      case 'payout.paid':
      case 'payout.failed': {
        // F-2 — EXPLICIT NO-OP. These previously issued an updateMany that could
        // never match a row, which is worse than doing nothing: it read as
        // working code and silently updated zero rows.
        //
        // Why it cannot match. `payout.*` events describe a Connect account's
        // BANK payout (a `po_…` object). A CreatorPayout row models the platform
        // -> Connect TRANSFER (`tr_…`). The old filter was
        // `stripePayoutId = po_… OR stripeTransferId = po_…`, but
        // `stripePayoutId` is never written to the row anywhere in this service
        // (its only occurrences are log fields), and `stripeTransferId` holds a
        // `tr_…` id, which cannot equal a `po_…` id.
        //
        // Why leaving it "harmlessly dead" was NOT safe. If anyone later starts
        // populating `stripePayoutId`, `payout.failed` becomes live — and it set
        // `status = 'failed'` with no ledger credit and no status guard. Since
        // `transfer.reversed` treats `failed` as already-reflected and returns
        // early, a genuine reversal arriving afterwards would be silently
        // dropped and the creator never credited. A dead handler plus a
        // terminal-status skip compose into a live invariant-2 violation.
        //
        // If Connect bank payouts ever need tracking, model them on their own
        // row rather than reusing CreatorPayout, whose status vocabulary means
        // "the transfer", not "the bank payout".
        const payout = event.data.object as Stripe.Payout;
        bumpCounter('processed');
        logCreatorBilling({
          outcome: 'processed',
          eventId: event.id,
          eventType: event.type,
          stripePayoutId: payout.id,
        });
        return;
      }

      case 'transfer.reversed': {
        // Under separate-charges-and-transfers, a manual reversal in the Stripe
        // dashboard (or a Connect-account compliance hold) flips a previously
        // successful transfer to reversed state. We need to restore the
        // creator's wallet by writing a compensating earning row, otherwise
        // their internal balance under-reports the actual Stripe balance.
        const transfer = event.data.object as Stripe.Transfer;
        const transferId = transfer.id;
        const payout = await prisma.creatorPayout.findFirst({
          where: { stripeTransferId: transferId },
          select: { id: true, creatorUserId: true, amountCents: true, status: true },
        });
        if (!payout) {
          // Reversal arrived before requestPayout finished writing stripeTransferId
          // (rare ms-window race). Throw so the outer catch deletes the dedup
          // marker and Stripe retries — the 30s backoff is far longer than the
          // race window. Silently swallowing here would permanently drop the
          // reversal and leave the local wallet diverged from Stripe state.
          throw new Error(`transfer.reversed for unknown transferId ${transferId}; will retry`);
        }
        if (payout.status === 'reversed' || payout.status === 'failed') {
          // Already reflected — idempotent skip. (Belt and suspenders; the DB
          // unique constraint on the ledger description below also blocks dup.)
          bumpCounter('processed');
          return;
        }
        // INVARIANT 1 — credit what Stripe ACTUALLY reversed, not the whole payout.
        //
        // A reversal can be partial: Stripe sets `amount_reversed` to the
        // cumulative reversed total and leaves `reversed` false. Crediting
        // `payout.amountCents` regardless meant a $1 reversal on a $1,000
        // transfer restored $1,000 to the wallet, which the creator could then
        // withdraw again — a $999 over-payment. `amount_reversed` was not read
        // anywhere in the codebase.
        //
        // Clamped to the payout amount so a malformed or unexpected value can
        // never credit MORE than was originally paid out.
        const rawReversed = (transfer as { amount_reversed?: unknown }).amount_reversed;
        const reversedCents = typeof rawReversed === 'number' && Number.isFinite(rawReversed) && rawReversed > 0
          ? Math.min(Math.trunc(rawReversed), payout.amountCents)
          : payout.amountCents; // absent/unusable → assume full, the prior behaviour
        if (reversedCents < payout.amountCents) {
          console.warn(
            `[Creator Billing] PARTIAL reversal on ${transferId}: crediting ${reversedCents} of ${payout.amountCents}`,
          );
        }
        // `amount_reversed` is CUMULATIVE, so credit only the slice not yet
        // credited, and reach the terminal 'reversed' status ONLY once the
        // reversal is actually complete.
        //
        // Marking the payout 'reversed' on a PARTIAL was wrong in the dangerous
        // direction: the status-based idempotent skip above then swallowed every
        // later event for the transfer. Stripe would go on to reverse the
        // remaining balance out of the creator's Connect account while our ledger
        // had credited only the first slice — a silent loss to the CREATOR, which
        // is invariant 2, not the over-payment I was guarding against.
        //
        // Reconciliation could not catch it either: once Stripe's `reversed`
        // flips true, both sides report "reversed" and agree, so the mismatch
        // exists only in the window between the two events and the daily scan can
        // miss it entirely.
        const priorCredits = await prisma.creatorWalletLedger.findMany({
          where: {
            creatorUserId: payout.creatorUserId,
            description: { startsWith: `transfer_reversed:${transferId}` },
          },
          select: { amountCents: true },
        });
        const alreadyCredited = priorCredits.reduce((sum, row) => sum + Math.abs(row.amountCents), 0);
        const deltaCents = Math.max(0, reversedCents - alreadyCredited);
        if (deltaCents === 0) {
          // Everything Stripe has reversed so far is already credited.
          bumpCounter('processed');
          return;
        }
        const fullyReversed = transfer.reversed === true || reversedCents >= payout.amountCents;
        await prisma.$transaction([
          prisma.creatorPayout.update({
            where: { id: payout.id },
            // Stay 'completed' while the reversal is partial, so a later event
            // is still processed rather than skipped as already-terminal.
            data: { status: fullyReversed ? 'reversed' : 'completed' },
          }),
          v1LedgerCreate(prisma,{
            data: {
              creatorUserId: payout.creatorUserId,
              type: 'earning',
              amountCents: deltaCents,
              // Cumulative figure in the key, so successive partials are distinct
              // rows while the unique(creatorUserId, description) index still
              // blocks a duplicate credit for the same cumulative total.
              description: `transfer_reversed:${transferId}:${reversedCents}`,
            },
          }),
        ]);
        // v2 shadow-write: G5c transfer.reversed. Same scheme as MIG-1.
        void shadowWriteTransferReversed({
          stripeTransferId: transferId,
          stripeEventId: event.id,
          creatorUserId: payout.creatorUserId,
          // The amount actually credited, not the original payout — otherwise v1
          // and v2 disagree by the un-reversed remainder for the same event.
          amountCents: deltaCents,
          effectiveAt: typeof event.created === 'number'
            ? new Date(event.created * 1000)
            : new Date(),
        }).catch((err) => {
          console.warn(`[v2-shadow] unexpected leak from shadow-write: ${(err as Error).message}`);
        });
        bumpCounter('processed');
        logCreatorBilling({
          outcome: 'processed',
          eventId: event.id,
          eventType: event.type,
          stripeTransferId: transferId,
          payoutId: payout.id,
          // What was actually restored this event; logging the full payout made
          // the operator's log claim $1,000 was returned when $1 was.
          restoredCents: deltaCents,
        });
        return;
      }

      default:
        bumpCounter('processed');
        logCreatorBilling({
          outcome: 'processed_unhandled',
          eventId: event.id,
          eventType: event.type,
        });
        return;
    }
  } catch (error) {
    // P2002 = unique violation on CreatorWalletLedger.(creatorUserId, description).
    // Means a concurrent webhook delivery already wrote the row we just attempted.
    // Treat as already-processed: keep the idempotency marker (so Stripe stops
    // retrying) and return 2xx without rethrowing. This is the entire point of
    // the DB-level uniqueness constraint.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      bumpCounter('deduped');
      logCreatorBilling({
        outcome: 'deduped',
        eventId: event.id,
        eventType: event.type,
        reason: 'P2002 unique violation — ledger entry already exists',
      });
      return;
    }
    bumpCounter('failed');
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[CreatorWebhook] Failed processing event ${event.type} (${event.id}): ${msg}`);
    logCreatorBilling({
      outcome: 'failed',
      eventId: event.id,
      eventType: event.type,
      error: msg,
    });
    await prisma.creatorWebhookEvent.deleteMany({ where: { eventId: event.id } });
    throw error;
  }
}

export async function createStripeConnectOnboardingLink(userId: string): Promise<string> {
  const creator = await prisma.creator.findUnique({
    where: { userId },
    select: { stripeConnectId: true, status: true, user: { select: { email: true } } },
  });
  if (!creator) throw new Error('Creator not found');
  if (creator.status === 'suspended') throw new Error('Account suspended');

  const stripe = getStripeClient();
  let accountId = creator.stripeConnectId;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      email: creator.user.email ?? undefined,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
      metadata: { creatorUserId: userId },
    });
    accountId = account.id;
    await prisma.creator.update({
      where: { userId },
      data: { stripeConnectId: accountId },
    });
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${config.stripeReturnUrl}?connect=refresh`,
    return_url: `${config.stripeReturnUrl}?connect=return`,
    type: 'account_onboarding',
  });
  return link.url;
}

/**
 * Fallback: checks Stripe account status directly and updates stripeConnectOnboarded
 * if charges_enabled && payouts_enabled. Used when the webhook hasn't arrived yet
 * (e.g., on Connect return redirect or profile fetch).
 * Returns true if the creator is now onboarded.
 */
export async function checkAndUpdateStripeConnectStatus(userId: string): Promise<boolean> {
  const creator = await prisma.creator.findUnique({
    where: { userId },
    select: { stripeConnectId: true, stripeConnectOnboarded: true },
  });
  if (!creator) return false;
  if (creator.stripeConnectOnboarded) return true;
  if (!creator.stripeConnectId) return false;

  try {
    const stripe = getStripeClient();
    const account = await stripe.accounts.retrieve(creator.stripeConnectId);
    if (account.charges_enabled && account.payouts_enabled) {
      await prisma.creator.update({
        where: { userId },
        data: { stripeConnectOnboarded: true },
      });
      console.info(`[CreatorBilling] Fallback: marked creator ${userId} as onboarded (stripeConnectId=${creator.stripeConnectId})`);
      return true;
    }
  } catch (error) {
    console.error(`[CreatorBilling] Fallback Stripe account check failed for ${userId}:`, error instanceof Error ? error.message : error);
  }
  return false;
}

function computeReservedBalanceCents(entries: Array<{ type: string; amountCents: number; createdAt: Date }>): number {
  const reserveCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  let reserved = 0;
  for (const entry of entries) {
    if (entry.createdAt > reserveCutoff && entry.type === 'earning') {
      reserved += Math.abs(entry.amountCents);
    }
  }
  return reserved;
}

function splitCreatorRevenueCents(
  grossCents: number,
  explicitPlatformFeeCents?: number | null
): { creatorCents: number; platformCents: number } {
  if (!Number.isInteger(grossCents) || grossCents <= 0) {
    return { creatorCents: 0, platformCents: 0 };
  }

  if (typeof explicitPlatformFeeCents === 'number' && Number.isFinite(explicitPlatformFeeCents)) {
    const platformCents = Math.max(0, Math.min(grossCents, explicitPlatformFeeCents));
    return {
      creatorCents: grossCents - platformCents,
      platformCents,
    };
  }

  // Exact integer 80% floor (BigInt avoids float-representation error in `gross * 0.8`).
  // MUST stay identical to creator-reconciliation `expectedCreatorShare` and the admin
  // fee-split so the writer, reconciler, and manual-fix endpoint never disagree.
  const creatorCents = Number((BigInt(grossCents) * 80n) / 100n);
  return {
    creatorCents,
    platformCents: grossCents - creatorCents,
  };
}

function getCumulativeCreatorRefundCents(charge: Stripe.Charge): number {
  const grossCents = typeof charge.amount === 'number' ? charge.amount : 0;
  const refundedCents = typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;
  if (grossCents <= 0 || refundedCents <= 0) return 0;

  const explicitPlatformFeeCents =
    typeof charge.application_fee_amount === 'number' ? charge.application_fee_amount : null;
  if (typeof explicitPlatformFeeCents === 'number') {
    const { creatorCents: creatorGrossCents } = splitCreatorRevenueCents(grossCents, explicitPlatformFeeCents);
    return Math.floor((refundedCents * creatorGrossCents) / grossCents);
  }

  return splitCreatorRevenueCents(refundedCents).creatorCents;
}

type PayoutPrismaClient = Pick<typeof prisma, 'creatorWalletLedger' | 'creatorPayout'>;

async function getLedgerBalanceFromClient(
  userId: string,
  client: PayoutPrismaClient
): Promise<number> {
  if (client === prisma) {
    return getPayoutBalanceFromLedger(userId);
  }

  const entries = await client.creatorWalletLedger.findMany({
    where: { creatorUserId: userId },
    select: { type: true, amountCents: true, description: true },
    orderBy: { createdAt: 'asc' },
  });

  let balance = 0;
  for (const entry of entries) {
    // Skip legacy destination-charge entries — funds already auto-transferred
    // to the creator's Connect account by Stripe (see audit C1 / invoice.paid handler).
    if (entry.description && entry.description.includes(':legacy_destination')) continue;
    if (entry.type === 'earning') balance += Math.abs(entry.amountCents);
    if (entry.type === 'payout' || entry.type === 'refund') balance -= Math.abs(entry.amountCents);
  }
  return balance;
}

export async function getPayoutBalance(
  userId: string,
  client: PayoutPrismaClient = prisma
): Promise<{ availableCents: number; reservedCents: number }> {
  const [entries, balance, pendingPayoutAgg] = await Promise.all([
    client.creatorWalletLedger.findMany({
      where: { creatorUserId: userId },
      select: { type: true, amountCents: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    getLedgerBalanceFromClient(userId, client),
    client.creatorPayout.aggregate({
      where: { creatorUserId: userId, status: 'pending' },
      _sum: { amountCents: true },
    }),
  ]);
  const reservedCents = computeReservedBalanceCents(entries);
  const pendingCents = pendingPayoutAgg._sum.amountCents ?? 0;
  return {
    availableCents: Math.max(0, balance - reservedCents - pendingCents),
    reservedCents,
  };
}

export async function requestPayout(userId: string): Promise<{ payoutId: string; amountCents: number }> {
  // Emergency kill switch — see config.creatorPayoutsEnabled. Payouts are
  // disabled platform-wide until destination-charge double-pay (C1) and
  // dispute clawback (C4) are remediated. Subscriptions continue normally;
  // earnings continue to accrue in the ledger; only withdrawals are blocked.
  if (!config.creatorPayoutsEnabled) {
    const err = new Error('Payouts are temporarily paused for maintenance. Your earnings continue to accrue and will be available when payouts resume.');
    (err as Error & { status?: number }).status = 503;
    throw err;
  }

  // INVARIANT 1/4/6 — refuse to pay out while the v1 wallet is frozen.
  //
  // Under V1_WALLET_FREEZE, v1LedgerCreate returns a no-op `SELECT 1` instead of
  // inserting the offsetting `payout:<id>` debit. The transfer still goes out,
  // but the ledger — which is the ONLY balance source both getPayoutBalance and
  // getPayoutBalanceFromLedger read — never records it. The creator's available
  // balance is therefore unchanged, and because the pending-unique index only
  // covers status='pending', a completed payout blocks nothing: they can request
  // again immediately, get a fresh payoutId, hence a fresh idempotency key,
  // hence a second real transfer. Repeatable without limit.
  //
  // admin.routes.ts already refuses its manual ledger endpoint under the freeze
  // for exactly this reason, and its comment even notes the freeze affects
  // "Stripe webhooks, payouts, etc." — this path was simply missed.
  if (isV1WalletFrozen()) {
    console.error(`[Creator Payout] FREEZE-BLOCKED payout request by ${userId}`);
    const err = new Error(
      'Payouts are paused while a wallet migration (V1_WALLET_FREEZE) is in progress. Your balance is unaffected and payouts resume when the migration completes.',
    );
    (err as Error & { status?: number }).status = 503;
    throw err;
  }

  // INVARIANT 5 — refuse to pay out when the reconciliation path is disabled.
  //
  // requestPayout gates on creatorPayoutsEnabled, but
  // runCreatorStripeReconciliation early-returns on creatorMonetizationEnabled.
  // Two uncoupled flags, so payouts-on + monetization-off is reachable — and in
  // that state a crash between a successful Stripe transfer and the local write
  // is detected by nothing at all. Reconciliation availability must be at least
  // as broad as payout availability; moving money without a working detector is
  // not a state we should be able to enter.
  if (!config.creatorMonetizationEnabled) {
    console.error('[Creator Payout] BLOCKED: payouts enabled but reconciliation (CREATOR_MONETIZATION_ENABLED) is off');
    const err = new Error(
      'Payouts are unavailable: the reconciliation path is not enabled. This is a configuration error — CREATOR_PAYOUTS_ENABLED requires CREATOR_MONETIZATION_ENABLED.',
    );
    (err as Error & { status?: number }).status = 503;
    throw err;
  }
  const creator = await prisma.creator.findUnique({
    where: { userId },
    select: { stripeConnectId: true, status: true },
  });
  if (!creator || creator.status !== 'active') throw new Error('Creator not active');
  if (!creator.stripeConnectId) throw new Error('Stripe Connect onboarding required');

  // Wrap check + create in transaction. The application-level pendingCount
  // check below is the fast path; the DB-level partial unique index
  // `creator_payout_pending_unique` (migration 20260527_add_payout_pending_unique)
  // is the authoritative guarantee that two concurrent requestPayout calls
  // can never both insert a pending row — libsql silently no-ops Prisma's
  // Serializable isolation, so the application check has a race window.
  let result: { payoutId: string; amountCents: number };
  try {
    result = await prisma.$transaction(async (tx) => {
    const pendingCount = await tx.creatorPayout.count({
      where: { creatorUserId: userId, status: 'pending' },
    });
    if (pendingCount > 0) {
      throw new Error('Existing payout request is still pending');
    }

    const { availableCents } = await getPayoutBalance(userId, tx);
    if (availableCents < config.payoutMinCents) {
      throw new Error(`Minimum payout is $${(config.payoutMinCents / 100).toFixed(0)}`);
    }

    const payout = await tx.creatorPayout.create({
      data: {
        creatorUserId: userId,
        amountCents: availableCents,
        status: 'pending',
      },
      select: { id: true, amountCents: true },
    });

    await v1LedgerCreate(tx, {
      data: {
        creatorUserId: userId,
        type: 'payout',
        amountCents: availableCents,
        // Each payout gets a distinct description so the (creatorUserId, description)
        // unique constraint enforces "one ledger row per payout" at the DB level.
        description: `payout:${payout.id}`,
      },
    });

    return { payoutId: payout.id, amountCents: payout.amountCents };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  } catch (txErr) {
    // The partial unique index `creator_payout_pending_unique` enforces
    // "at most one pending payout per creator". A concurrent peer that
    // beat us to the insert produces P2002 here — translate to the same
    // user-visible message the inline pendingCount check uses.
    if (txErr instanceof Prisma.PrismaClientKnownRequestError && txErr.code === 'P2002') {
      throw new Error('Existing payout request is still pending');
    }
    throw txErr;
  }

  // Initiate actual Stripe transfer to the creator's Connect account.
  // CRITICAL: idempotencyKey scoped to payoutId. Without this, a TCP drop
  // between our process and Stripe's API can leave a transfer created
  // server-side while our catch block writes a payout_reversal earning row,
  // letting the user re-trigger a second transfer for the same wallet
  // balance. With the key, any retry returns the original transfer object
  // — Stripe guarantees at-most-one transfer per idempotencyKey for 24h.
  // H-2 — the transfer and the bookkeeping are now SEPARATE phases.
  //
  // They used to share one try/catch, so a failure of the local "mark completed"
  // write was indistinguishable from a failed transfer: the catch marked the
  // payout `failed` and credited the wallet back — after the money had already
  // left. The creator could then request payout again and be paid twice. The
  // idempotency key does not prevent that: the retry is a NEW payout row with a
  // NEW id, so it carries a different key and Stripe treats it as a distinct,
  // legitimate transfer.
  //
  // Rule from here on: the wallet is only ever restored when we KNOW no money
  // moved.
  //
  // On an AMBIGUOUS failure we RESOLVE the ambiguity rather than parking it.
  // Re-issuing the transfer under the same idempotency key is exactly-once by
  // construction: Stripe returns the ORIGINAL transfer if one was created, and
  // creates it if not. Simply parking the payout instead would strand the
  // creator's money — the ledger debit stands, and
  // creator-stripe-reconciliation.service.ts cannot recover it (it only scans
  // payouts that already carry a stripeTransferId, and it is a read-only
  // reporter that writes no ledger or payout rows).
  const issueTransfer = () => getStripeClient().transfers.create({
    amount: result.amountCents,
    currency: 'usd',
    destination: creator.stripeConnectId!,
    description: `Nala creator payout ${result.payoutId}`,
    metadata: { payoutId: result.payoutId, creatorUserId: userId },
    // F-1 recovery key. If this process dies between the payout transaction
    // committing and this call returning, the ONLY way to learn whether Stripe
    // received the transfer is to ask Stripe — and `transfers.list` cannot
    // filter on metadata (verified against the installed SDK: TransferListParams
    // exposes created / destination / transfer_group / pagination only, and
    // there is no transfers.search). `transfer_group` IS a first-class list
    // filter, so it is what makes the stranded-payout recovery in
    // creator-stripe-reconciliation.service.ts an exact lookup rather than a scan.
    transfer_group: payoutTransferGroup(result.payoutId),
  }, {
    // CRITICAL: scoped to payoutId. Stripe guarantees at-most-one transfer per
    // key for 24h, which is what makes the retry above safe.
    idempotencyKey: `payout-${result.payoutId}`,
    // Disable the SDK's INTERNAL retries for this call specifically.
    //
    // stripe-node defaults maxNetworkRetries to 2, and it retries on connection
    // errors, 409 and 5xx, reusing the same Idempotency-Key. That means one
    // `await` could be up to three HTTP attempts and the error we catch is the
    // LAST one — so "the error came from the request that would have created the
    // transfer" is false. Attempt #1 could create the transfer, the response be
    // lost, and attempt #2 return a 429 (Stripe's rate limiter sits ahead of the
    // idempotency store, so it does not replay the stored 201). Classifying that
    // 429 as "nothing was created" would reverse the wallet on money already
    // sent — the double-pay again.
    //
    // With retries off, one call is one request — with ONE documented
    // exception: `_shouldRetry` short-circuits on ECONNRESET/EPIPE at
    // numRetries === 0 BEFORE it checks the retry budget
    // (RequestSender.js:145-149, HttpClient.js:30), so those two codes still get
    // a single unconditional internal retry. That is tolerable precisely
    // because the classification below was narrowed: every outcome of that
    // second attempt except StripeInvalidRequestError is treated as ambiguous
    // and never reverses, and a same-key replay of a request that DID create
    // the transfer is served the stored success response rather than a 400.
    //
    // Recovery otherwise belongs to our own explicit same-key retry, whose
    // outcome we handle deliberately.
    maxNetworkRetries: 0,
  });

  let transferId: string;
  try {
    transferId = (await issueTransfer()).id;
  } catch (err) {
    if (!isDefiniteStripeRejection(err)) {
      // Stripe may or may not have created the transfer. Ask again under the
      // same key to find out.
      console.warn(
        `[Creator Payout] ambiguous transfer outcome for ${result.payoutId}, retrying under the same idempotency key:`,
        (err as Error).message,
      );
      try {
        transferId = (await issueTransfer()).id;
        console.warn(`[Creator Payout] resolved ${result.payoutId} on idempotent retry (transfer=${transferId})`);
      } catch (retryErr) {
        // DELIBERATELY no reversal on this path, whatever the error looks like.
        //
        // It is tempting to treat a "definite rejection" here as proof the key
        // was never consumed — but that inference is unsound. Stripe raises a
        // 429 from its rate limiter BEFORE consulting the idempotency key, and
        // an auth/permission error can come from a key rotated between the two
        // calls. Neither says anything about whether the FIRST attempt created
        // the transfer. Reversing on them would credit the wallet for money
        // that had already been sent, and the creator's next request carries a
        // new payoutId — hence a new idempotency key — which Stripe would
        // honour as a second, distinct transfer.
        //
        // Only the FIRST attempt's rejection is sound evidence (see the else
        // branch below): there the error came from the very request that would
        // have created the transfer.
        //
        // So: unresolved. The ledger debit MUST stand, and the creator's money
        // is held until a human settles it. Stranded funds are recoverable;
        // a double payment is not.
        console.error(
          `[Creator Payout] UNRESOLVED transfer for ${result.payoutId} — creator funds held pending manual reconciliation:`,
          (retryErr as Error).message,
        );
        bumpCounter('payoutFailed');
        Sentry.captureException(retryErr, {
          level: 'fatal',
          tags: { component: 'creator_payout', outcome: 'unresolved_transfer' },
          extra: { payoutId: result.payoutId, creatorUserId: userId, amountCents: result.amountCents },
        });
        await prisma.creatorPayout.update({
          where: { id: result.payoutId },
          data: { status: 'processing' },
        }).catch((updateErr) => {
          // Leaves the row 'pending', which blocks this creator's future payout
          // requests. That is the safe direction, but it is silent — alert too.
          console.error(`[Creator Payout] could not park ${result.payoutId} as processing:`, (updateErr as Error).message);
          Sentry.captureException(updateErr, {
            level: 'fatal',
            tags: { component: 'creator_payout', outcome: 'park_failed' },
            extra: { payoutId: result.payoutId, creatorUserId: userId },
          });
        });
        throw payoutError('Payout is being confirmed with our payment provider. Do not retry — we will follow up.', 503);
      }
    } else {
      // Stripe positively rejected the FIRST attempt (bad params, insufficient
      // balance, auth/permission, rate limit). The error came from the same
      // request that would have created the transfer, so no transfer exists and
      // restoring the wallet is safe.
      console.error(`[Creator Payout] Stripe rejected transfer for ${result.payoutId}:`, (err as Error).message);
      const reversed = await reverseOrHold(result.payoutId, userId, result.amountCents);
      // If the reversal itself failed the payout row is still `pending`, which
      // permanently blocks this creator — so "please try again later" would be
      // actively misleading: every retry now fails with "Existing payout request
      // is still pending". Say it needs us instead.
      throw reversed
        ? payoutError('Payout transfer failed — please try again later', 400)
        : payoutError('Payout could not be completed and your balance could not be released automatically. We have been alerted and will resolve this — please do not retry.', 503);
    }
  }

  // Money HAS moved. Nothing below may reverse the ledger.
  try {
    // Transfers are instant — mark as completed immediately. Capture the
    // paidAt so the shadow-write writes the SAME effective timestamp v1's
    // CreatorPayout row carries — keeps v1 and v2 reporting aligned on
    // payout-day grouping.
    const paidAt = new Date();
    await prisma.creatorPayout.update({
      where: { id: result.payoutId },
      data: { stripeTransferId: transferId, status: 'completed', paidAt },
    });
    // v2 shadow-write: G5a payout requested. Fires AFTER the Stripe transfer
    // succeeded so v2 only mirrors finalized v1 state.
    void shadowWritePayoutRequested({
      payoutId: result.payoutId,
      creatorUserId: userId,
      amountCents: result.amountCents,
      effectiveAt: paidAt,
    }).catch((err) => {
      console.warn(`[v2-shadow] unexpected leak from shadow-write: ${(err as Error).message}`);
    });
  } catch (bookkeepingErr) {
    // The transfer succeeded but we failed to record it. This is the exact case
    // that used to trigger a wallet reversal and enable the double-pay. Record
    // what we can and surface loudly; never restore the balance.
    console.error(
      `[Creator Payout] PAID BUT UNRECORDED ${result.payoutId} (stripeTransferId=${transferId}):`,
      (bookkeepingErr as Error).message,
    );
    Sentry.captureException(bookkeepingErr, {
      level: 'fatal',
      tags: { component: 'creator_payout', outcome: 'paid_but_unrecorded' },
      extra: { payoutId: result.payoutId, creatorUserId: userId, stripeTransferId: transferId },
    });
    await prisma.creatorPayout.update({
      where: { id: result.payoutId },
      data: { status: 'processing', stripeTransferId: transferId },
    }).catch(() => { /* already logged and reported above; nothing more to do */ });
    throw payoutError('Payout was sent but confirmation failed — we will reconcile it shortly.', 503);
  }

  return result;
}

/**
 * Stripe `transfer_group` for a payout — the durable handle that lets
 * reconciliation ask "did Stripe ever receive this payout?" after a crash.
 * Shared with creator-stripe-reconciliation.service.ts; both sides must agree
 * on this exact string or recovery silently finds nothing.
 */
export function payoutTransferGroup(payoutId: string): string {
  return `payout_${payoutId}`;
}

/**
 * Error carrying an explicit HTTP status. `creator.controller.ts` defaults to
 * 400 otherwise, which would report "your request was bad" for outcomes where
 * money may well have moved.
 */
function payoutError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * Reverse a payout, and if the reversal itself fails, make sure somebody hears
 * about it.
 *
 * A bare `await reversePayout(...)` was a silent trap: its `$transaction` can
 * throw (SQLITE_BUSY is a live failure mode on this database), and when it does
 * the payout row stays `pending` with the ledger still debited. `requestPayout`
 * refuses to start while a `pending` row exists — enforced both in code and by
 * the `creator_payout_pending_unique` partial index — so that creator can never
 * request a payout again, and nothing in this codebase sweeps the state: the
 * reconciliation service only looks at payouts that already carry a
 * `stripeTransferId`, and the payout webhooks key on ids this row does not have.
 *
 * We cannot repair it from here, so the requirement is that it never fails
 * quietly.
 */
async function reverseOrHold(payoutId: string, creatorUserId: string, amountCents: number): Promise<boolean> {
  try {
    await reversePayout(payoutId, creatorUserId, amountCents);
    return true;
  } catch (reversalErr) {
    console.error(
      `[Creator Payout] REVERSAL FAILED for ${payoutId} — row left pending, creator is now blocked from requesting payouts:`,
      (reversalErr as Error).message,
    );
    bumpCounter('payoutFailed');
    Sentry.captureException(reversalErr, {
      level: 'fatal',
      tags: { component: 'creator_payout', outcome: 'reversal_failed' },
      extra: { payoutId, creatorUserId, amountCents },
    });
    return false;
  }
}

/**
 * Restore a creator's wallet after a payout that provably never sent money.
 * ONLY call this when Stripe positively rejected the transfer — calling it on
 * an ambiguous or successful outcome is the double-pay bug (H-2). Prefer
 * `reverseOrHold`, which reports a failed reversal.
 */
async function reversePayout(payoutId: string, creatorUserId: string, amountCents: number): Promise<void> {
  await prisma.$transaction([
    prisma.creatorPayout.update({
      where: { id: payoutId },
      data: { status: 'failed' },
    }),
    v1LedgerCreate(prisma, {
      data: {
        creatorUserId,
        type: 'earning',
        amountCents,
        description: `payout_reversal:${payoutId}`,
      },
    }),
  ]);
  // v2 shadow-write: G5b payout failed (restore).
  void shadowWritePayoutFailed({
    payoutId,
    creatorUserId,
    amountCents,
    effectiveAt: new Date(),
  }).catch((err) => {
    console.warn(`[v2-shadow] unexpected leak from shadow-write: ${(err as Error).message}`);
  });
}

/**
 * H-2 — did Stripe positively REJECT the request, meaning no transfer exists?
 *
 * Only these outcomes are safe to treat as "no money moved" and therefore safe
 * to reverse the wallet for. Connection errors, generic API errors and anything
 * unrecognised are ambiguous by definition: the request may have been processed
 * before the failure surfaced on our side.
 */
function isDefiniteStripeRejection(err: unknown): boolean {
  // Read `.type` rather than `err instanceof Stripe.errors.StripeError`.
  // instanceof would be a liability in the one place we cannot afford one: if
  // `Stripe.errors` is ever undefined (a mocked//stubbed SDK, a bundler that
  // drops the statics), `x instanceof undefined` THROWS — inside the error
  // handler on the money path. Duck-typing degrades to "ambiguous", which is
  // the safe direction: no wallet reversal.
  const type = (err as { type?: unknown } | null | undefined)?.type;
  if (typeof type !== 'string') return false;
  switch (type) {
    case 'StripeInvalidRequestError':
      // The ONLY error we treat as proof that no transfer exists.
      //
      // Stripe never auto-retries a 400, and a replayed identical request under
      // the same idempotency key returns the stored success response rather than
      // a 400 — so seeing this means the request was refused on its own terms.
      //
      // Auth, permission and rate-limit errors were previously in this list and
      // are NOT safe: a 429 comes from an edge rate limiter that never consults
      // the idempotency store, and an auth failure can come from a key rotated
      // between attempts. Neither tells us whether an earlier attempt created
      // the transfer, so both must fall through to "ambiguous".
      return true;
    default:
      // StripeConnectionError, StripeAPIError, StripeUnknownError, …
      //
      // StripeIdempotencyError belongs HERE, not above. Stripe raises it when
      // the key was already used with DIFFERENT parameters — which means a
      // prior request under `payout-${payoutId}` was accepted and a transfer
      // may well exist. Classifying it as a definite rejection would reverse
      // the wallet on a payout that had already been sent: the exact double-pay
      // this function exists to prevent. (Elsewhere in this file the same error
      // type is treated as transient/retryable, which is consistent with it
      // being ambiguous rather than a refusal.)
      return false;
  }
}

type LedgerType = 'earning' | 'platform_fee' | 'refund' | 'payout';

type CreatorLedgerQuery = {
  limit?: number;
  cursor?: string;
  type?: LedgerType;
  from?: Date;
  to?: Date;
};

export async function getCreatorLedger(
  userId: string,
  query: CreatorLedgerQuery
): Promise<{
  items: Array<{
    id: string;
    createdAt: Date;
    type: string;
    amountCents: number;
    description: string | null;
    subscriptionId: string | null;
  }>;
  page: {
    cursor?: string;
    nextCursor?: string;
    limit: number;
    hasMore: boolean;
  };
  summary: {
    availableCents: number;
    reservedCents: number;
    pendingPayoutCents: number;
  };
}> {
  const limit = Math.max(1, Math.min(query.limit ?? 25, 100));
  const where: {
    creatorUserId: string;
    type?: LedgerType;
    createdAt?: { gte?: Date; lte?: Date };
  } = { creatorUserId: userId };

  if (query.type) {
    where.type = query.type;
  }
  if (query.from || query.to) {
    where.createdAt = {};
    if (query.from) where.createdAt.gte = query.from;
    if (query.to) where.createdAt.lte = query.to;
  }

  const [rows, balance, pendingPayoutAgg] = await Promise.all([
    prisma.creatorWalletLedger.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
      select: {
        id: true,
        createdAt: true,
        type: true,
        amountCents: true,
        description: true,
        subscriptionId: true,
      },
    }),
    getPayoutBalance(userId),
    prisma.creatorPayout.aggregate({
      where: { creatorUserId: userId, status: 'pending' },
      _sum: { amountCents: true },
    }),
  ]);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? items[items.length - 1]?.id : undefined;

  return {
    items,
    page: {
      cursor: query.cursor,
      nextCursor,
      limit,
      hasMore,
    },
    summary: {
      availableCents: balance.availableCents,
      reservedCents: balance.reservedCents,
      pendingPayoutCents: pendingPayoutAgg._sum.amountCents ?? 0,
    },
  };
}
