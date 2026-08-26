import Stripe from 'stripe';
import prisma from '../utils/prisma';
import { config } from '../config';
import { recordWebhookEvent } from '../utils/webhook-metrics';
import {
  userHasBlockingAppleRail,
  downgradeIfNotAppleOwned,
} from './apple-entitlement-projection.service';
import type { QueueClient } from './apple-reconciliation-queue.service';

/**
 * Stripe signup refused because Apple already holds this account’s billing rail.
 *
 * Deterministic and typed rather than a silent winner-picks: the caller maps it
 * to 409 so the user is told to manage the subscription in the App Store.
 */
export class AppleBillingRailActiveError extends Error {
  constructor(readonly userId: string) {
    super('This account already has an Apple subscription; manage it in the App Store.');
    this.name = 'AppleBillingRailActiveError';
  }
}

/** Apple’s tables are queried through the same raw interface the reconciler uses. */
const appleDb = (): QueueClient => prisma as unknown as QueueClient;

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

function resolveBillingAccessState(
  subscriptionStatus: string | null | undefined,
  priceId: string | null,
  periodEnd: Date | null
): { plan: PlanTier; planExpiresAt: Date | null } {
  if (subscriptionStatus === 'active' || subscriptionStatus === 'trialing') {
    return {
      plan: resolvePlanFromPriceId(priceId),
      planExpiresAt: periodEnd,
    };
  }

  return {
    plan: 'free',
    planExpiresAt: null,
  };
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

  /**
   * Apple -> Stripe exclusion.
   *
   * Asks Apple’s authoritative table, NOT User.plan: a user in billing_retry
   * reads as free while Apple may still collect for up to 60 days, and
   * admitting them here would double-bill the moment that retry succeeds.
   *
   * Runs before the customer is created and before the session exists, so no
   * provider-side paid rail is brought into being for a user who may not have
   * one.
   */
  if (await userHasBlockingAppleRail(appleDb(), user.id)) {
    throw new AppleBillingRailActiveError(user.id);
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

/**
 * Apply a Stripe-originated plan change without violating Apple’s authority.
 *
 * Blocking the Checkout endpoint alone is NOT enough: these webhook handlers
 * mutate User.plan directly, so a stale Stripe event can arrive long after Apple
 * became the owner of the plan. The two intents need opposite guards.
 *
 *   downgrade  a stale deleted / payment_failed / refund event must never free a
 *              plan Apple currently owns. The STRIPE-rail fields still apply —
 *              clearing a dead stripeSubscriptionId is correct, and it also
 *              resolves the double-rail condition rather than entrenching it.
 *
 *   grant      must not overwrite a currently blocking Production Apple rail, and
 *              when it does apply it CLAIMS ownership by clearing
 *              applePurchaseSource. Without that claim the marker would still say
 *              ‘app_store’ from a previous Apple subscription and a later Apple
 *              recomputation would happily downgrade a paid Stripe plan.
 *
 * The per-user loop is deliberate: the guard is per-user state, and an updateMany
 * predicate over a nullable column is exactly the NULL-comparison trap this repo
 * has been bitten by before.
 */
async function updateUserPlanByCustomer(
  stripeCustomerId: string,
  data: {
    plan: PlanTier;
    stripeSubscriptionId?: string | null;
    planExpiresAt?: Date | null;
    planStartedAt?: Date | null;
  },
  intent: 'grant' | 'downgrade',
): Promise<void> {
  // id ONLY. Reading applePurchaseSource here and acting on it later is the
  // check-then-write race this code used to have; the ownership test now lives
  // in the WHERE clause of the write itself, so there is nothing to go stale.
  const users = await prisma.user.findMany({
    where: { stripeCustomerId },
    select: { id: true },
  });
  for (const user of users) {
    await applyStripePlanChange(user, data, intent);
  }
}

async function applyStripePlanChange(
  user: { id: string },
  data: {
    plan: PlanTier;
    stripeSubscriptionId?: string | null;
    planExpiresAt?: Date | null;
    planStartedAt?: Date | null;
  },
  intent: 'grant' | 'downgrade',
): Promise<void> {
  const { plan, planExpiresAt, planStartedAt, ...railData } = data;

  /**
   * The Stripe rail identity is a FACT about what exists at the provider, and
   * it is persisted FIRST — before, and independently of, whether the plan
   * grant is permitted.
   *
   * This is load-bearing for the double-rail safety net. The Apple projector
   * detects a conflict through a non-null stripeSubscriptionId; if a refused
   * grant returned without recording sub_X, Stripe could be charging the
   * customer while Nala believed there was no Stripe rail at all, and the next
   * Apple reconciliation would grant normally and never park the conflict.
   */
  if ('stripeSubscriptionId' in railData) {
    await prisma.user.update({ where: { id: user.id }, data: railData, select: { id: true } });
  }

  if (intent === 'downgrade') {
    /**
     * Atomic: Apple ownership is tested in the WHERE clause of this very write,
     * so an Apple reconciliation that claims the plan after this handler started
     * makes the downgrade affect zero rows instead of erasing a fresh grant.
     */
    const changed = await downgradeIfNotAppleOwned(
      appleDb(), user.id, plan, planExpiresAt ?? null, planStartedAt ?? null,
    );
    if (!changed) {
      console.warn(
        `[Billing] Stripe downgrade did not apply for user ${user.id}: the current ` +
        'plan is Apple-owned. Stripe rail fields were still applied.',
      );
    }
    return;
  }

  if (await userHasBlockingAppleRail(appleDb(), user.id)) {
    // Should be unreachable: createCheckoutSession refuses this up front. If it
    // happens anyway the two rails raced, and silently overwriting Apple would
    // double-bill. The Stripe rail identity is already recorded above, so the
    // next Apple reconciliation sees a double rail and parks it for an operator
    // rather than granting as though Stripe were not there.
    console.error(
      `[Billing] RAIL CONFLICT: Stripe grant for user ${user.id} refused — ` +
      'a blocking Production Apple subscription already exists. ' +
      'The Stripe subscription id has been recorded so the conflict is durable.',
    );
    return;
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { plan, planExpiresAt, planStartedAt, applePurchaseSource: null },
    select: { id: true },
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
          // stripeCustomerId is rail state and always applies; the plan fields go
          // through the Apple-aware path.
          await prisma.user.update({
            where: { id: userId },
            data: { stripeCustomerId },
            select: { id: true },
          });
          const target = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true },
          });
          if (target) {
            await applyStripePlanChange(target, {
              plan,
              stripeSubscriptionId,
              planStartedAt: new Date(),
              planExpiresAt: periodEnd,
            }, 'grant');
          }
        } else {
          await updateUserPlanByCustomer(stripeCustomerId, {
            plan,
            stripeSubscriptionId,
            planStartedAt: new Date(),
            planExpiresAt: periodEnd,
          }, 'grant');
        }
        return;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const stripeCustomerId = typeof subscription.customer === 'string' ? subscription.customer : null;
        if (!stripeCustomerId) return;
        const firstItem = subscription.items.data[0];
        const priceId = firstItem?.price?.id ?? null;
        const periodEnd = firstItem?.current_period_end
          ? new Date(firstItem.current_period_end * 1000)
          : null;
        const accessState = resolveBillingAccessState(subscription.status, priceId, periodEnd);

        // A Stripe status change can go either direction, so the intent follows
        // the resolved access state rather than the event name.
        await updateUserPlanByCustomer(stripeCustomerId, {
          plan: accessState.plan,
          stripeSubscriptionId: subscription.id,
          planExpiresAt: accessState.planExpiresAt,
          planStartedAt: new Date(subscription.start_date * 1000),
        }, accessState.plan === 'free' ? 'downgrade' : 'grant');
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
        }, 'downgrade');
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
        // Apple-aware: a Stripe refund must not free a plan Apple currently owns.
        const refundTarget = await prisma.user.findUnique({
          where: { id: refundedUser.id },
          select: { id: true },
        });
        if (refundTarget) {
          await applyStripePlanChange(refundTarget, {
            plan: 'free',
            stripeSubscriptionId: null,
            planExpiresAt: null,
          }, 'downgrade');
        }
        console.log(`[Billing] Refund processed — user ${refundedUser.id} downgraded to free`);
        return;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : null;
        if (!stripeCustomerId) return;
        /**
         * Was an updateMany that freed every paying user on the customer. It now
         * runs per user so an Apple-owned plan is left alone: a Stripe payment
         * failure says nothing about an Apple subscription.
         *
         * stripeSubscriptionId is deliberately NOT cleared here. Stripe keeps the
         * subscription alive through dunning, and the Stripe->Apple exclusion
         * depends on that id still being present.
         */
        const failedUsers = await prisma.user.findMany({
          where: { stripeCustomerId, plan: { not: 'free' } },
          select: { id: true },
        });
        for (const failedUser of failedUsers) {
          await applyStripePlanChange(failedUser, { plan: 'free', planExpiresAt: null }, 'downgrade');
        }
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
