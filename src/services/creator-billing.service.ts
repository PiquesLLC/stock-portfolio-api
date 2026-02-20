import Stripe from 'stripe';
import prisma from '../utils/prisma';
import { config } from '../config';
import { getPayoutBalanceFromLedger } from './creator.service';

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
      trial_period_days: creator.trialDays > 0 ? creator.trialDays : undefined,
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

export async function handleCreatorWebhookEvent(event: Stripe.Event): Promise<void> {
  const shouldProcess = await markWebhookProcessed(event.id, event.type);
  if (!shouldProcess) return;

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
        return;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const maybeSubscription = (invoice as Stripe.Invoice & { subscription?: unknown }).subscription;
        const stripeSubscriptionId = typeof maybeSubscription === 'string' ? maybeSubscription : null;
        if (!stripeSubscriptionId) return;
        const amountPaid = invoice.amount_paid;
        if (!amountPaid || amountPaid <= 0) return;

        const sub = await prisma.creatorSubscription.findFirst({
          where: { stripeSubscriptionId },
          select: { id: true, creatorUserId: true },
        });
        if (!sub) return;

        const creatorShare = Math.round(amountPaid * 0.8);
        const platformShare = amountPaid - creatorShare;

        await prisma.$transaction([
          prisma.creatorWalletLedger.create({
            data: {
              creatorUserId: sub.creatorUserId,
              type: 'earning',
              amountCents: creatorShare,
              subscriptionId: sub.id,
              description: 'Subscription payment (creator share)',
            },
          }),
          prisma.creatorWalletLedger.create({
            data: {
              creatorUserId: sub.creatorUserId,
              type: 'platform_fee',
              amountCents: platformShare,
              subscriptionId: sub.id,
              description: 'Platform fee (20%)',
            },
          }),
          prisma.creatorSubscriptionEvent.create({
            data: {
              subscriptionId: sub.id,
              eventType: 'renewed',
            },
          }),
        ]);
        return;
      }

      default:
        return;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[CreatorWebhook] Failed processing event ${event.type} (${event.id}): ${msg}`);
    await prisma.creatorWebhookEvent.deleteMany({ where: { eventId: event.id } });
    throw error;
  }
}

export async function createStripeConnectOnboardingLink(userId: string): Promise<string> {
  const creator = await prisma.creator.findUnique({
    where: { userId },
    select: { stripeConnectId: true, user: { select: { email: true } } },
  });
  if (!creator) throw new Error('Creator not found');

  const stripe = getStripeClient();
  let accountId = creator.stripeConnectId;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      email: creator.user.email ?? undefined,
      capabilities: {
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

  const pendingCount = await prisma.creatorPayout.count({
    where: { creatorUserId: userId, status: 'pending' },
  });
  if (pendingCount > 0) {
    throw new Error('Existing payout request is still pending');
  }

  const { availableCents } = await getPayoutBalance(userId);
  if (availableCents < 5000) {
    throw new Error('Minimum payout is $50');
  }

  const payout = await prisma.creatorPayout.create({
    data: {
      creatorUserId: userId,
      amountCents: availableCents,
      status: 'pending',
    },
    select: { id: true, amountCents: true },
  });

  await prisma.creatorWalletLedger.create({
    data: {
      creatorUserId: userId,
      type: 'payout',
      amountCents: availableCents,
      description: 'Payout requested',
    },
  });

  return {
    payoutId: payout.id,
    amountCents: payout.amountCents,
  };
}
