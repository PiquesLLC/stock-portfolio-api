import Stripe from 'stripe';
import prisma from '../utils/prisma';
import { config } from '../config';
import { Prisma } from '../generated/prisma/client';
import { getPayoutBalanceFromLedger } from './creator.service';
import { recordWebhookEvent } from '../utils/webhook-metrics';

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

        await prisma.creatorSubscription.upsert({
          where: {
            subscriberUserId_creatorUserId: {
              subscriberUserId,
              creatorUserId,
            },
          },
          update: {
            status: 'active',
            stripeSubscriptionId,
            canceledAt: null,
          },
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
        await prisma.creatorSubscription.updateMany({
          where: { stripeSubscriptionId },
          data: {
            status: mappedStatus,
            ...(shouldUpdatePeriodEnd ? { currentPeriodEnd: new Date(currentPeriodEndUnix * 1000) } : {}),
            canceledAt: subscription.cancel_at_period_end ? new Date() : null,
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
          } catch { /* Stripe lookup failed — will be retried */ }
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
        // earning by charge id (description.contains('charge:${chargeId}')). Falls
        // back to no segment if Stripe didn't populate charge (shouldn't happen on
        // invoice.paid but defensive).
        const invoiceChargeId = typeof invoice.charge === 'string' ? invoice.charge : '';
        const chargeSegment = invoiceChargeId ? `:charge:${invoiceChargeId}` : '';
        const creatorEventKey = `stripe_event:${event.id}${chargeSegment}:creator_share${legacySuffix}`;
        const platformEventKey = `stripe_event:${event.id}${chargeSegment}:platform_fee${legacySuffix}`;
        const alreadyCredited = await prisma.creatorWalletLedger.findFirst({
          where: {
            creatorUserId: sub.creatorUserId,
            OR: [
              { description: creatorEventKey },
              { description: platformEventKey },
            ],
          },
          select: { id: true },
        });
        if (alreadyCredited) return;

        const { creatorCents: creatorShare, platformCents: platformShare } = splitCreatorRevenueCents(
          amountPaid,
          invoiceWithFee.application_fee_amount
        );

        await prisma.$transaction([
          prisma.creatorWalletLedger.create({
            data: {
              creatorUserId: sub.creatorUserId,
              type: 'earning',
              amountCents: creatorShare,
              subscriptionId: sub.id,
              description: creatorEventKey,
            },
          }),
          prisma.creatorWalletLedger.create({
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
        const previousRefundEntries = await prisma.creatorWalletLedger.findMany({
          where: {
            creatorUserId: sub.creatorUserId,
            type: 'refund',
            description: { contains: `charge:${chargeId}` },
          },
          select: { amountCents: true },
        });
        const previouslyDebitedCreator = previousRefundEntries.reduce((sum, r) => sum + Math.abs(r.amountCents), 0);
        const totalCreatorShare = getCumulativeCreatorRefundCents(charge);
        const incrementalCreator = totalCreatorShare - previouslyDebitedCreator;
        if (incrementalCreator <= 0) return; // Already fully accounted for

        const previousPlatformRefundEntries = await prisma.creatorWalletLedger.findMany({
          where: {
            creatorUserId: sub.creatorUserId,
            type: 'platform_fee',
            description: { contains: `charge:${chargeId}:refund_platform` },
          },
          select: { amountCents: true },
        });
        const previouslyDebitedPlatform = previousPlatformRefundEntries.reduce((sum, r) => sum + Math.abs(r.amountCents), 0);
        const totalPlatformRefund = cumulativeRefunded - totalCreatorShare;
        const incrementalPlatform = totalPlatformRefund - previouslyDebitedPlatform;
        if (incrementalPlatform < 0) return;

        const creatorRefund = -incrementalCreator;
        const platformRefund = -incrementalPlatform;
        const creatorRefundKey = `stripe_event:${event.id}:charge:${chargeId}:refund_creator`;
        const platformRefundKey = `stripe_event:${event.id}:charge:${chargeId}:refund_platform`;

        await prisma.$transaction([
          prisma.creatorWalletLedger.create({
            data: {
              creatorUserId: sub.creatorUserId,
              type: 'refund',
              amountCents: creatorRefund,
              subscriptionId: sub.id,
              description: creatorRefundKey,
            },
          }),
          prisma.creatorWalletLedger.create({
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
          // Net previous debits so we don't double-debit on refund→dispute or
          // re-dispute sequences. Sum ALL negative rows for this charge, on
          // both sides, regardless of whether they came from refund_* or
          // dispute_clawback_*.
          const [prevCreatorDebits, prevPlatformDebits] = await Promise.all([
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
                type: 'platform_fee',
                description: { contains: chargeToken },
                amountCents: { lt: 0 },
              },
              select: { amountCents: true },
            }),
          ]);
          prevDebitedCreator = prevCreatorDebits.reduce((sum, r) => sum + Math.abs(r.amountCents), 0);
          prevDebitedPlatform = prevPlatformDebits.reduce((sum, r) => sum + Math.abs(r.amountCents), 0);
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
          prisma.creatorWalletLedger.create({
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
            writes.push(prisma.creatorWalletLedger.create({
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
            writes.push(prisma.creatorWalletLedger.create({
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
          const restoreWrites: Prisma.PrismaPromise<unknown>[] = [
            // Reverse the $15 dispute fee (original was type=refund:-1500, so add back as earning)
            prisma.creatorWalletLedger.create({
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
              restoreWrites.push(prisma.creatorWalletLedger.create({
                data: {
                  creatorUserId: sub.creatorUserId,
                  type: 'earning',
                  amountCents: Math.abs(creatorClawback.amountCents),
                  subscriptionId: sub.id,
                  description: `stripe_event:${event.id}:charge:${wonChargeId}:dispute_won_restore_creator`,
                },
              }));
            }
            if (platformClawback && platformClawback.amountCents < 0) {
              restoreWrites.push(prisma.creatorWalletLedger.create({
                data: {
                  creatorUserId: sub.creatorUserId,
                  type: 'platform_fee',
                  amountCents: Math.abs(platformClawback.amountCents),
                  subscriptionId: sub.id,
                  description: `stripe_event:${event.id}:charge:${wonChargeId}:dispute_won_restore_platform`,
                },
              }));
            }
          }
          await prisma.$transaction(restoreWrites);
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

      case 'payout.paid': {
        const payout = event.data.object as Stripe.Payout;
        await prisma.creatorPayout.updateMany({
          where: { OR: [{ stripePayoutId: payout.id }, { stripeTransferId: payout.id }] },
          data: {
            status: 'completed',
            paidAt: new Date(),
          },
        });
        bumpCounter('processed');
        logCreatorBilling({
          outcome: 'processed',
          eventId: event.id,
          eventType: event.type,
          stripePayoutId: payout.id,
        });
        return;
      }

      case 'payout.failed': {
        const payout = event.data.object as Stripe.Payout;
        await prisma.creatorPayout.updateMany({
          where: { OR: [{ stripePayoutId: payout.id }, { stripeTransferId: payout.id }] },
          data: {
            status: 'failed',
          },
        });
        bumpCounter('payoutFailed');
        bumpCounter('processed');
        logCreatorBilling({
          outcome: 'processed',
          eventId: event.id,
          eventType: event.type,
          stripePayoutId: payout.id,
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
  if (!Number.isFinite(grossCents) || grossCents <= 0) {
    return { creatorCents: 0, platformCents: 0 };
  }

  if (typeof explicitPlatformFeeCents === 'number' && Number.isFinite(explicitPlatformFeeCents)) {
    const platformCents = Math.max(0, Math.min(grossCents, explicitPlatformFeeCents));
    return {
      creatorCents: grossCents - platformCents,
      platformCents,
    };
  }

  const creatorCents = Math.floor(grossCents * 0.8);
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
  const creator = await prisma.creator.findUnique({
    where: { userId },
    select: { stripeConnectId: true, status: true },
  });
  if (!creator || creator.status !== 'active') throw new Error('Creator not active');
  if (!creator.stripeConnectId) throw new Error('Stripe Connect onboarding required');

  // Wrap check + create in transaction to prevent TOCTOU double-payout
  const result = await prisma.$transaction(async (tx) => {
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

    await tx.creatorWalletLedger.create({
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

  // Initiate actual Stripe transfer to the creator's Connect account
  try {
    const stripe = getStripeClient();
    const transfer = await stripe.transfers.create({
      amount: result.amountCents,
      currency: 'usd',
      destination: creator.stripeConnectId!,
      description: `Nala creator payout ${result.payoutId}`,
      metadata: { payoutId: result.payoutId, creatorUserId: userId },
    });
    // Transfers are instant — mark as completed immediately
    await prisma.creatorPayout.update({
      where: { id: result.payoutId },
      data: { stripeTransferId: transfer.id, status: 'completed', paidAt: new Date() },
    });
  } catch (err) {
    console.error(`[Creator Payout] Stripe transfer failed for ${result.payoutId}:`, (err as Error).message);
    // Mark payout as failed AND reverse the ledger entry so balance is restored
    await prisma.$transaction([
      prisma.creatorPayout.update({
        where: { id: result.payoutId },
        data: { status: 'failed' },
      }),
      prisma.creatorWalletLedger.create({
        data: {
          creatorUserId: userId,
          type: 'earning',
          amountCents: result.amountCents,
          description: `payout_reversal:${result.payoutId}`,
        },
      }),
    ]);
    throw new Error('Payout transfer failed — please try again later');
  }

  return result;
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
