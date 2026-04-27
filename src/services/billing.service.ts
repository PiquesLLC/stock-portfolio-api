import Stripe from 'stripe';
import prisma from '../utils/prisma';
import { config } from '../config';
import { recordWebhookEvent } from '../utils/webhook-metrics';

export type PlanTier = 'free' | 'pro' | 'premium' | 'elite';

interface BillingWebhookEventDelegate {
  create(args: { data: { eventId: string; eventType: string } }): Promise<unknown>;
  deleteMany(args: { where: { eventId: string } }): Promise<unknown>;
  count(args?: { where?: { eventId?: string } }): Promise<number>;
}

function getBillingWebhookEventDelegate(): BillingWebhookEventDelegate {
  return (prisma as unknown as { billingWebhookEvent: BillingWebhookEventDelegate }).billingWebhookEvent;
}

function getStripeClient(): Stripe {
  if (!config.stripeSecretKey) {
    throw new Error('Stripe is not configured');
  }
  return new Stripe(config.stripeSecretKey);
}

type BillingStatus = Awaited<ReturnType<typeof getBillingStatus>>;

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function pollBillingStatusAfterCheckout(
  userId: string,
  options?: {
    maxAttempts?: number;
    initialDelayMs?: number;
    backoffMultiplier?: number;
    maxDelayMs?: number;
    statusFetcher?: (userId: string) => Promise<BillingStatus>;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<BillingStatus> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 6);
  const backoffMultiplier = options?.backoffMultiplier ?? 1.8;
  const maxDelayMs = options?.maxDelayMs ?? 3000;
  let delayMs = Math.max(1, options?.initialDelayMs ?? 300);
  const fetchStatus = options?.statusFetcher ?? getBillingStatus;
  const sleep = options?.sleep ?? defaultSleep;

  let status = await fetchStatus(userId);

  // Checkout redirect can beat webhook settlement; poll briefly with backoff so
  // callers can wait for plan propagation before showing stale "free" state.
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    const isSettled =
      status.plan !== 'free' ||
      Boolean(status.stripeSubscriptionId) ||
      status.subscriptionStatus !== null;
    if (isSettled) {
      return status;
    }

    await sleep(delayMs);
    delayMs = Math.min(maxDelayMs, Math.round(delayMs * backoffMultiplier));
    status = await fetchStatus(userId);
  }

  return status;
}

function resolvePlanFromPriceId(priceId: string | null): PlanTier {
  if (!priceId) return 'free';
  if (
    (config.stripeEliteMonthlyPriceId && priceId === config.stripeEliteMonthlyPriceId) ||
    (config.stripeEliteYearlyPriceId && priceId === config.stripeEliteYearlyPriceId)
  ) {
    return 'elite';
  }
  if (
    (config.stripePremiumMonthlyPriceId && priceId === config.stripePremiumMonthlyPriceId) ||
    (config.stripePremiumYearlyPriceId && priceId === config.stripePremiumYearlyPriceId)
  ) {
    return 'premium';
  }
  if (
    (config.stripeProMonthlyPriceId && priceId === config.stripeProMonthlyPriceId) ||
    (config.stripeProYearlyPriceId && priceId === config.stripeProYearlyPriceId)
  ) {
    return 'pro';
  }
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
  // Validate priceId against configured price IDs
  const ALLOWED_PRICE_IDS = new Set([
    config.stripeProMonthlyPriceId, config.stripeProYearlyPriceId,
    config.stripePremiumMonthlyPriceId, config.stripePremiumYearlyPriceId,
    config.stripeEliteMonthlyPriceId, config.stripeEliteYearlyPriceId,
  ].filter(Boolean));
  if (!ALLOWED_PRICE_IDS.has(priceId)) {
    throw new Error('Invalid price ID');
  }

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
    // Re-read to guard against concurrent checkout race (double customer creation)
    const freshUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { stripeCustomerId: true },
    });
    if (freshUser?.stripeCustomerId) {
      customerId = freshUser.stripeCustomerId;
    } else {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customerId },
        select: { id: true },
      });
    }
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${config.stripeReturnUrl}?checkout=success`,
    cancel_url: `${config.stripeReturnUrl}?checkout=cancel#tab=pricing`,
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
  const billingWebhookEvent = getBillingWebhookEventDelegate();
  try {
    await billingWebhookEvent.create({
      data: {
        eventId: event.id,
        eventType: event.type,
      },
    });
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002') {
      // Duplicate webhook delivery; already processed.
      console.log(`[Billing] Duplicate webhook ignored: ${event.type} (${event.id})`);
      recordWebhookEvent('billing', 'deduped', event.type);
      return;
    }
    throw error;
  }

  const stripe = getStripeClient();

  try {
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
            select: { id: true },
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

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const stripeCustomerId = typeof charge.customer === 'string' ? charge.customer : null;
        if (!stripeCustomerId) return;

        // Partial refunds are intentionally a no-op for entitlement; only a
        // full refund should trigger cancellation + downgrade in this handler.
        if (charge.amount_refunded < charge.amount) return;

        // Trace the exact subscription: charge → invoice → subscription
        const chargeInvoice = (charge as unknown as { invoice?: string | { id: string } | null }).invoice;
        const invoiceId = typeof chargeInvoice === 'string' ? chargeInvoice : chargeInvoice?.id ?? null;
        let refundedSubscriptionId: string | null = null;
        if (invoiceId) {
          const invoice = await stripe.invoices.retrieve(invoiceId);
          const invSub = (invoice as unknown as { subscription?: string | { id: string } | null }).subscription;
          refundedSubscriptionId = typeof invSub === 'string' ? invSub : invSub?.id ?? null;
        }

        // Find the user by customer ID
        const refundedUser = await prisma.user.findFirst({
          where: { stripeCustomerId },
          select: { id: true, stripeSubscriptionId: true },
        });
        if (!refundedUser) return;

        // Only cancel if the refunded subscription matches the user's current subscription.
        // Fail closed: if we can't resolve the subscription ID, skip downgrade to avoid
        // accidentally cancelling a newer subscription from an ambiguous refund payload.
        if (!refundedSubscriptionId) {
          console.warn(`[Billing] Refund for customer ${stripeCustomerId} has no resolvable subscription ID — skipping downgrade`);
          return;
        }
        if (refundedUser.stripeSubscriptionId !== refundedSubscriptionId) {
          console.log(`[Billing] Refund for subscription ${refundedSubscriptionId} does not match current ${refundedUser.stripeSubscriptionId} — skipping`);
          return;
        }

        // Cancel the Stripe subscription if active
        if (refundedUser.stripeSubscriptionId) {
          try {
            await stripe.subscriptions.cancel(refundedUser.stripeSubscriptionId);
          } catch {
            // Subscription may already be cancelled
          }
        }

        // Immediately downgrade to free
        await prisma.user.update({
          where: { id: refundedUser.id },
          data: {
            plan: 'free',
            stripeSubscriptionId: null,
            planExpiresAt: null,
          },
          select: { id: true },
        });
        console.log(`[Billing] Refund processed — user ${refundedUser.id} downgraded to free`);
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
  } catch (error) {
    // Allow Stripe retries by removing idempotency marker when processing fails.
    await billingWebhookEvent.deleteMany({
      where: { eventId: event.id },
    });
    throw error;
  }
}

export async function assertBillingDeploySafety(): Promise<void> {
  if (!config.billingEnabled) {
    return;
  }

  const missing: string[] = [];
  if (!config.stripeSecretKey) missing.push('STRIPE_SECRET_KEY');
  if (!config.stripeWebhookSecret) missing.push('STRIPE_WEBHOOK_SECRET');
  if (!config.stripeProMonthlyPriceId) missing.push('STRIPE_PRO_MONTHLY_PRICE_ID');
  if (!config.stripePremiumMonthlyPriceId) missing.push('STRIPE_PREMIUM_MONTHLY_PRICE_ID');
  // Connect/creator webhook secret validation added Apr 26 after a 2-day silent
  // signature mismatch on /creator/webhooks/stripe. Required when creator
  // monetization is on; signature verification fails open with empty string
  // otherwise, returning 400 on every delivery without surfacing the cause.
  if (config.creatorMonetizationEnabled && !config.stripeConnectWebhookSecret) {
    missing.push('STRIPE_CONNECT_WEBHOOK_SECRET');
  }

  if (missing.length > 0) {
    throw new Error(`Billing is enabled but missing env vars: ${missing.join(', ')}`);
  }

  // Verifies db push/migrations created the idempotency table before accepting traffic.
  await getBillingWebhookEventDelegate().count();
}

export async function getBillingStatus(userId: string): Promise<{
  plan: string;
  planStartedAt: Date | null;
  planExpiresAt: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  isGracePeriod: boolean;
  graceEndsAt: Date | null;
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

  let subscriptionStatus: string | null = null;
  let cancelAtPeriodEnd = false;
  let currentPeriodEnd: Date | null = null;

  if (user.stripeSubscriptionId && config.stripeSecretKey) {
    try {
      const stripe = getStripeClient();
      const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
      subscriptionStatus = subscription.status ?? null;
      cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end);
      const firstItem = subscription.items.data[0];
      currentPeriodEnd = firstItem?.current_period_end
        ? new Date(firstItem.current_period_end * 1000)
        : null;
    } catch {
      console.error('[Billing] Failed to refresh subscription lifecycle');
    }
  }

  const isGracePeriod = subscriptionStatus === 'past_due' || subscriptionStatus === 'unpaid';
  const graceEndsAt = isGracePeriod ? user.planExpiresAt : null;

  return {
    ...user,
    subscriptionStatus,
    cancelAtPeriodEnd,
    currentPeriodEnd,
    isGracePeriod,
    graceEndsAt,
  };
}
