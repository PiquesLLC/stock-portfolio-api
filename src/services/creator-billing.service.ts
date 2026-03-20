import Stripe from 'stripe';
import prisma from '../utils/prisma';
import { config } from '../config';
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
      application_fee_percent: 20,
      transfer_data: { destination: creator.stripeConnectId },
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
        await prisma.creatorSubscription.updateMany({
          where: { stripeSubscriptionId },
          data: {
            status: subscription.cancel_at_period_end ? 'canceled' : 'active',
            currentPeriodEnd: currentPeriodEndUnix ? new Date(currentPeriodEndUnix * 1000) : null,
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

        const sub = await prisma.creatorSubscription.findFirst({
          where: { stripeSubscriptionId },
          select: { id: true, creatorUserId: true },
        });
        if (!sub) return;

        const creatorEventKey = `stripe_event:${event.id}:creator_share`;
        const platformEventKey = `stripe_event:${event.id}:platform_fee`;
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

        const creatorShare = Math.round(amountPaid * 0.8);
        const platformShare = amountPaid - creatorShare;

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

        const amount = typeof charge.amount === 'number' ? charge.amount : 0;
        const cumulativeRefunded = typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;
        if (cumulativeRefunded <= 0) return;

        // charge.amount_refunded is CUMULATIVE across all refund events for this charge.
        // To get the incremental refund for THIS event, check what we've already debited.
        const previousRefundEntries = await prisma.creatorWalletLedger.findMany({
          where: {
            creatorUserId: sub.creatorUserId,
            type: 'refund',
            subscriptionId: sub.id,
          },
          select: { amountCents: true },
        });
        const previouslyDebitedCreator = previousRefundEntries.reduce((sum, r) => sum + Math.abs(r.amountCents), 0);
        const totalCreatorShare = Math.round(cumulativeRefunded * 0.8);
        const incrementalCreator = totalCreatorShare - previouslyDebitedCreator;
        if (incrementalCreator <= 0) return; // Already fully accounted for

        // For simplicity, compute incremental platform share from the incremental total
        const incrementalTotal = incrementalCreator / 0.8; // back-calculate incremental refund amount
        const incrementalPlatform = Math.round(incrementalTotal) - incrementalCreator;

        const creatorRefund = -incrementalCreator;
        const platformRefund = -incrementalPlatform;
        const amountRefunded = cumulativeRefunded;
        const creatorRefundKey = `stripe_event:${event.id}:refund_creator`;
        const platformRefundKey = `stripe_event:${event.id}:refund_platform`;

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

        if (amount > 0 && amountRefunded >= amount) {
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
          amountRefunded,
          fullRefund: amount > 0 && amountRefunded >= amount,
        });
        return;
      }

      case 'charge.dispute.created': {
        const stripe = getStripeClient();
        const dispute = event.data.object as Stripe.Dispute;
        const sub = await resolveSubscriptionFromDispute(dispute, stripe);
        if (!sub) return;

        const reason = dispute.reason ?? 'unknown';
        console.error(`[CreatorWebhook] Dispute created for subscription ${sub.id}: reason=${reason}`);

        await prisma.$transaction([
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
              type: 'platform_fee',
              amountCents: 1500,
              subscriptionId: sub.id,
              description: `stripe_event:${event.id}:dispute_fee:${reason}`,
            },
          }),
        ]);
        bumpCounter('disputed');
        bumpCounter('processed');
        logCreatorBilling({
          outcome: 'processed',
          eventId: event.id,
          eventType: event.type,
          creatorUserId: sub.creatorUserId,
          subscriptionId: sub.id,
          reason,
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

          // Reverse the $15 dispute fee
          await prisma.creatorWalletLedger.create({
            data: {
              creatorUserId: sub.creatorUserId,
              type: 'platform_fee',
              amountCents: -1500,
              description: `stripe_event:${event.id}:dispute_fee_reversal`,
            },
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
        if (account.charges_enabled && account.payouts_enabled && account.id) {
          const creator = await prisma.creator.findFirst({
            where: { stripeConnectId: account.id },
            select: { userId: true, stripeConnectOnboarded: true },
          });
          if (creator && !creator.stripeConnectOnboarded) {
            await prisma.creator.update({
              where: { userId: creator.userId },
              data: { stripeConnectOnboarded: true },
            });
            logCreatorBilling({
              outcome: 'processed',
              eventId: event.id,
              eventType: event.type,
              stripeConnectId: account.id,
              creatorUserId: creator.userId,
              action: 'onboarded',
            });
          }
        }
        bumpCounter('processed');
        return;
      }

      case 'payout.paid': {
        const payout = event.data.object as Stripe.Payout;
        await prisma.creatorPayout.updateMany({
          where: { stripePayoutId: payout.id },
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
          where: { stripePayoutId: payout.id },
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

export async function getPayoutBalance(userId: string): Promise<{ availableCents: number; reservedCents: number }> {
  const [entries, balance, pendingPayoutAgg] = await Promise.all([
    prisma.creatorWalletLedger.findMany({
      where: { creatorUserId: userId },
      select: { type: true, amountCents: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    getPayoutBalanceFromLedger(userId),
    prisma.creatorPayout.aggregate({
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

    const { availableCents } = await getPayoutBalance(userId);
    if (availableCents < 500) {
      throw new Error('Minimum payout is $5');
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
        description: 'Payout requested',
      },
    });

    return { payoutId: payout.id, amountCents: payout.amountCents };
  });

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
