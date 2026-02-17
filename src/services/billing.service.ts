import Stripe from 'stripe';
import prisma from '../utils/prisma';
import { config } from '../config';

export type PlanTier = 'free' | 'pro' | 'premium';

function getStripeClient(): Stripe {
  if (!config.stripeSecretKey) {
    throw new Error('Stripe is not configured');
  }
  return new Stripe(config.stripeSecretKey);
}

function resolvePlanFromPriceId(priceId: string | null): PlanTier {
  if (!priceId) return 'free';
  if (config.stripePricePremium && priceId === config.stripePricePremium) return 'premium';
  if (config.stripePricePro && priceId === config.stripePricePro) return 'pro';
  return 'free';
}

async function resolvePlanFromSubscription(
  stripe: Stripe,
  subscriptionId: string
): Promise<{ plan: PlanTier; periodEnd: Date | null }> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const firstItem = subscription.items.data[0];
  const priceId = firstItem?.price?.id ?? null;
  const plan = resolvePlanFromPriceId(priceId);
  const periodEnd = firstItem?.current_period_end
    ? new Date(firstItem.current_period_end * 1000)
    : null;
  return { plan, periodEnd };
}

export async function createCheckoutSession(userId: string, priceId: string): Promise<string> {
  const stripe = getStripeClient();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, stripeCustomerId: true },
  });
  if (!user) {
    throw new Error('User not found');
  }

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { userId: user.id },
    });
    customerId = customer.id;
    await prisma.user.update({
      where: { id: user.id },
      data: { stripeCustomerId: customerId },
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${config.stripeReturnUrl}?checkout=success`,
    cancel_url: `${config.stripeReturnUrl}?checkout=cancel`,
    metadata: { userId },
    allow_promotion_codes: true,
  });

  if (!session.url) {
    throw new Error('Checkout session URL missing');
  }

  return session.url;
}

export async function createCustomerPortalSession(userId: string): Promise<string> {
  const stripe = getStripeClient();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true },
  });
  if (!user?.stripeCustomerId) {
    throw new Error('No billing account found');
  }

  const portal = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: config.stripeReturnUrl,
  });

  return portal.url;
}

async function updateUserPlanByCustomer(
  stripeCustomerId: string,
  data: {
    plan: PlanTier;
    stripeSubscriptionId?: string | null;
    planExpiresAt?: Date | null;
    planStartedAt?: Date | null;
  }
): Promise<void> {
  await prisma.user.updateMany({
    where: { stripeCustomerId },
    data,
  });
}

export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
  const stripe = getStripeClient();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const stripeCustomerId = typeof session.customer === 'string' ? session.customer : null;
      const stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : null;
      const userId = session.metadata?.userId;

      if (!stripeCustomerId || !stripeSubscriptionId) return;
      const { plan, periodEnd } = await resolvePlanFromSubscription(stripe, stripeSubscriptionId);

      if (userId) {
        await prisma.user.update({
          where: { id: userId },
          data: {
            plan,
            stripeCustomerId,
            stripeSubscriptionId,
            planStartedAt: new Date(),
            planExpiresAt: periodEnd,
          },
        });
      } else {
        await updateUserPlanByCustomer(stripeCustomerId, {
          plan,
          stripeSubscriptionId,
          planStartedAt: new Date(),
          planExpiresAt: periodEnd,
        });
      }
      return;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const stripeCustomerId = typeof subscription.customer === 'string' ? subscription.customer : null;
      if (!stripeCustomerId) return;
      const firstItem = subscription.items.data[0];
      const priceId = firstItem?.price?.id ?? null;
      const plan = resolvePlanFromPriceId(priceId);
      const periodEnd = firstItem?.current_period_end
        ? new Date(firstItem.current_period_end * 1000)
        : null;

      await updateUserPlanByCustomer(stripeCustomerId, {
        plan,
        stripeSubscriptionId: subscription.id,
        planExpiresAt: periodEnd,
        planStartedAt: new Date(subscription.start_date * 1000),
      });
      return;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const stripeCustomerId = typeof subscription.customer === 'string' ? subscription.customer : null;
      if (!stripeCustomerId) return;
      await updateUserPlanByCustomer(stripeCustomerId, {
        plan: 'free',
        stripeSubscriptionId: null,
        planExpiresAt: null,
      });
      return;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : null;
      if (!stripeCustomerId) return;
      const gracePeriodEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      await prisma.user.updateMany({
        where: { stripeCustomerId, plan: { not: 'free' } },
        data: { planExpiresAt: gracePeriodEnd },
      });
      return;
    }

    default:
      return;
  }
}

export async function getBillingStatus(userId: string): Promise<{
  plan: string;
  planStartedAt: Date | null;
  planExpiresAt: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      plan: true,
      planStartedAt: true,
      planExpiresAt: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
    },
  });

  if (!user) {
    throw new Error('User not found');
  }

  return user;
}
