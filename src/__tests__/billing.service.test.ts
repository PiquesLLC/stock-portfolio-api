import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

const {
  invoicesRetrieveMock,
  recordWebhookEventMock,
  subscriptionsCancelMock,
  subscriptionsRetrieveMock,
  checkoutCreateMock,
  customersCreateMock,
} = vi.hoisted(() => ({
  invoicesRetrieveMock: vi.fn(),
  recordWebhookEventMock: vi.fn(),
  subscriptionsCancelMock: vi.fn(),
  subscriptionsRetrieveMock: vi.fn(),
  checkoutCreateMock: vi.fn(),
  customersCreateMock: vi.fn(),
}));

vi.mock('stripe', () => {
  class StripeMock {
    subscriptions = {
      retrieve: subscriptionsRetrieveMock,
      cancel: subscriptionsCancelMock,
    };
    invoices = {
      retrieve: invoicesRetrieveMock,
    };
    customers = {
      create: customersCreateMock,
    };
    checkout = {
      sessions: {
        create: checkoutCreateMock,
      },
    };
    billingPortal = {
      sessions: {
        create: vi.fn(),
      },
    };
    webhooks = {
      constructEvent: vi.fn(),
    };
    constructor(_apiKey: string) {}
  }

  return {
    default: StripeMock,
  };
});

vi.mock('../utils/webhook-metrics', () => ({
  recordWebhookEvent: recordWebhookEventMock,
}));

vi.mock('../config', () => ({
  config: {
    stripeSecretKey: 'sk_test_123',
    stripeWebhookSecret: 'whsec_123',
    stripeProMonthlyPriceId: 'price_pro',
    stripeProYearlyPriceId: 'price_pro_yearly',
    stripePremiumMonthlyPriceId: 'price_premium',
    stripePremiumYearlyPriceId: 'price_premium_yearly',
    stripeReturnUrl: 'http://localhost:5173/settings/billing',
  },
}));

import {
  getBillingStatus,
  handleWebhookEvent,
  pollBillingStatusAfterCheckout,
  createCheckoutSession,
  AppleBillingRailActiveError,
} from '../services/billing.service';
import { APPLE_PURCHASE_SOURCE } from '../services/apple-entitlement-projection.service';

describe('billing webhook handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!(prismaMock.user as any).findFirst) {
      (prismaMock.user as any).findFirst = vi.fn();
    }
    prismaMock.billingWebhookEvent.create.mockResolvedValue({ id: 'evt_rec_1' });
    prismaMock.billingWebhookEvent.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.user.updateMany.mockResolvedValue({ count: 1 });
    // The Apple-aware plan writer resolves users first and asks Apple whether a
    // rail blocks. Default: one ordinary Stripe user with no Apple rail.
    (prismaMock.user as any).findMany.mockResolvedValue([{ id: 'user_1', applePurchaseSource: null }]);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user_1', applePurchaseSource: null });
    (prismaMock as any).$queryRawUnsafe.mockResolvedValue([]);
    (prismaMock.user as any).findFirst.mockResolvedValue({
      id: 'user_refund_1',
      stripeSubscriptionId: 'sub_refund_1',
    });
    subscriptionsCancelMock.mockResolvedValue({});
    invoicesRetrieveMock.mockResolvedValue({ subscription: 'sub_refund_1' });
    subscriptionsRetrieveMock.mockResolvedValue({
      status: 'active',
      cancel_at_period_end: false,
      items: {
        data: [
          {
            price: { id: 'price_pro' },
            current_period_end: 1730000000,
          },
        ],
      },
    });
  });

  it('processes checkout.session.completed and upgrades user plan', async () => {
    const event = {
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { userId: 'user_1' },
        },
      },
    };

    await handleWebhookEvent(event as any);

    expect(prismaMock.billingWebhookEvent.create).toHaveBeenCalledWith({
      data: { eventId: 'evt_checkout_1', eventType: 'checkout.session.completed' },
    });
    // The customer id is Stripe rail state and applies directly; the PLAN goes
    // through the Apple-aware writer, which also claims ownership by clearing
    // applePurchaseSource so a later Apple recomputation cannot downgrade it.
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user_1' }, data: { stripeCustomerId: 'cus_1' } })
    );
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user_1' },
        data: expect.objectContaining({
          plan: 'pro',
          stripeSubscriptionId: 'sub_1',
          applePurchaseSource: null,
        }),
      })
    );
    expect(prismaMock.billingWebhookEvent.deleteMany).not.toHaveBeenCalled();
  });

  it('processes customer.subscription.updated and updates plan for active subscriptions', async () => {
    const event = {
      id: 'evt_sub_updated_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_2',
          customer: 'cus_2',
          status: 'active',
          start_date: 1700000000,
          items: {
            data: [
              {
                price: { id: 'price_premium' },
                current_period_end: 1735000000,
              },
            ],
          },
        },
      },
    };

    await handleWebhookEvent(event as any);

    expect((prismaMock.user as any).findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { stripeCustomerId: 'cus_2' } })
    );
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user_1' },
        data: expect.objectContaining({
          plan: 'premium',
          stripeSubscriptionId: 'sub_2',
          applePurchaseSource: null,
        }),
      })
    );
  });

  it('downgrades unpaid customer.subscription.updated to free immediately', async () => {
    const event = {
      id: 'evt_sub_updated_unpaid_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_unpaid_1',
          customer: 'cus_unpaid_1',
          status: 'unpaid',
          start_date: 1700000000,
          items: {
            data: [
              {
                price: { id: 'price_premium' },
                current_period_end: 1735000000,
              },
            ],
          },
        },
      },
    };

    await handleWebhookEvent(event as any);

    // A downgrade, so no ownership claim is made.
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user_1' },
        data: expect.objectContaining({
          plan: 'free',
          stripeSubscriptionId: 'sub_unpaid_1',
          planExpiresAt: null,
        }),
      })
    );
  });

  it('processes customer.subscription.deleted and downgrades to free', async () => {
    const event = {
      id: 'evt_sub_deleted_1',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          customer: 'cus_3',
        },
      },
    };

    await handleWebhookEvent(event as any);

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user_1' },
        data: expect.objectContaining({
          plan: 'free',
          stripeSubscriptionId: null,
          planExpiresAt: null,
        }),
      })
    );
  });

  it('processes invoice.payment_failed and downgrades plan access immediately', async () => {
    const event = {
      id: 'evt_invoice_failed_1',
      type: 'invoice.payment_failed',
      data: {
        object: {
          customer: 'cus_4',
        },
      },
    };

    await handleWebhookEvent(event as any);

    expect((prismaMock.user as any).findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { stripeCustomerId: 'cus_4', plan: { not: 'free' } } })
    );
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user_1' },
        data: { plan: 'free', planExpiresAt: null },
      })
    );
    // stripeSubscriptionId must SURVIVE dunning: Stripe keeps the subscription
    // alive, and the Stripe->Apple exclusion depends on that id still being there.
    const failedCall = prismaMock.user.update.mock.calls.find(
      (c: any) => c[0]?.data?.plan === 'free' && c[0]?.where?.id === 'user_1',
    );
    expect(failedCall?.[0]?.data).not.toHaveProperty('stripeSubscriptionId');
  });

  it('ignores duplicate event deliveries by event id', async () => {
    prismaMock.billingWebhookEvent.create.mockRejectedValue({ code: 'P2002' });

    const event = {
      id: 'evt_duplicate_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_dup',
          subscription: 'sub_dup',
          metadata: { userId: 'user_dup' },
        },
      },
    };

    await handleWebhookEvent(event as any);

    expect(subscriptionsRetrieveMock).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(prismaMock.billingWebhookEvent.deleteMany).not.toHaveBeenCalled();
  });

  it('dedupes replayed charge.refunded webhook by event id and logs skip behavior', async () => {
    prismaMock.billingWebhookEvent.create
      .mockResolvedValueOnce({ id: 'evt_rec_1' })
      .mockRejectedValueOnce({ code: 'P2002' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const event = {
      id: 'evt_refund_replay_1',
      type: 'charge.refunded',
      data: {
        object: {
          customer: 'cus_replay_1',
          amount: 1000,
          amount_refunded: 1000,
          invoice: 'in_replay_1',
        },
      },
    };

    await handleWebhookEvent(event as any);
    await handleWebhookEvent(event as any);

    expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
    expect(subscriptionsCancelMock).toHaveBeenCalledTimes(1);
    expect(recordWebhookEventMock).toHaveBeenCalledWith('billing', 'deduped', 'charge.refunded');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Duplicate webhook ignored'));

    logSpy.mockRestore();
  });

  it('logs and skips old refunded subscription after user re-subscribes', async () => {
    (prismaMock.user as any).findFirst.mockResolvedValue({
      id: 'user_2',
      stripeSubscriptionId: 'sub_new_123',
    });
    invoicesRetrieveMock.mockResolvedValue({ subscription: 'sub_old_456' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const event = {
      id: 'evt_refund_old_sub_1',
      type: 'charge.refunded',
      data: {
        object: {
          customer: 'cus_2',
          amount: 2500,
          amount_refunded: 2500,
          invoice: 'in_old_sub_1',
        },
      },
    };

    await handleWebhookEvent(event as any);

    expect(subscriptionsCancelMock).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('does not match current sub_new_123')
    );

    logSpy.mockRestore();
  });

  it('returns lifecycle fields for billing status', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      plan: 'pro',
      planStartedAt: new Date('2026-02-01T00:00:00.000Z'),
      planExpiresAt: new Date('2026-03-01T00:00:00.000Z'),
      stripeCustomerId: 'cus_status_1',
      stripeSubscriptionId: 'sub_status_1',
    });
    subscriptionsRetrieveMock.mockResolvedValue({
      status: 'past_due',
      cancel_at_period_end: true,
      items: {
        data: [
          {
            price: { id: 'price_pro' },
            current_period_end: 1735000000,
          },
        ],
      },
    });

    const result = await getBillingStatus('user_status_1');

    expect(result.plan).toBe('pro');
    expect(result.subscriptionStatus).toBe('past_due');
    expect(result.cancelAtPeriodEnd).toBe(true);
    expect(result.currentPeriodEnd).toBeInstanceOf(Date);
    expect(result.isGracePeriod).toBe(true);
    expect(result.graceEndsAt).toBeInstanceOf(Date);
  });

  it('polls billing status with backoff until webhook-settled plan appears', async () => {
    const sleepCalls: number[] = [];
    const statusFetcher = vi
      .fn()
      .mockResolvedValueOnce({
        plan: 'free',
        planStartedAt: null,
        planExpiresAt: null,
        stripeCustomerId: 'cus_3',
        stripeSubscriptionId: null,
        subscriptionStatus: null,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        isGracePeriod: false,
        graceEndsAt: null,
      })
      .mockResolvedValueOnce({
        plan: 'free',
        planStartedAt: null,
        planExpiresAt: null,
        stripeCustomerId: 'cus_3',
        stripeSubscriptionId: null,
        subscriptionStatus: null,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        isGracePeriod: false,
        graceEndsAt: null,
      })
      .mockResolvedValueOnce({
        plan: 'pro',
        planStartedAt: new Date('2026-03-08T00:00:00.000Z'),
        planExpiresAt: new Date('2026-04-08T00:00:00.000Z'),
        stripeCustomerId: 'cus_3',
        stripeSubscriptionId: 'sub_3',
        subscriptionStatus: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: new Date('2026-04-08T00:00:00.000Z'),
        isGracePeriod: false,
        graceEndsAt: null,
      });

    const result = await pollBillingStatusAfterCheckout('user_checkout_1', {
      maxAttempts: 5,
      initialDelayMs: 200,
      backoffMultiplier: 2,
      maxDelayMs: 500,
      statusFetcher,
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
    });

    expect(result.plan).toBe('pro');
    expect(statusFetcher).toHaveBeenCalledTimes(3);
    expect(sleepCalls).toEqual([200, 400]);
  });
});

/**
 * Apple <-> Stripe exclusion, from the Stripe side.
 *
 * The Apple side of these rules is proven against a real engine in
 * apple-entitlement-projection.integration.test.ts. What is tested here is the
 * half that lives in Stripe code: refusing a second rail at checkout, and
 * refusing to let a stale Stripe event rewrite a plan Apple owns.
 */
describe('Apple -> Stripe exclusion', () => {
  const appleRow = (over: Record<string, unknown> = {}) => ({
    environment: 'Production',
    originalTransactionId: '2000000123456789',
    userId: 'user_1',
    plan: 'pro',
    status: 'active',
    expiresAt: '2030-01-01T00:00:00.000Z',
    gracePeriodExpiresAt: null,
    autoRenewStatus: 1,
    currentTransactionId: 'txn-1',
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user_1', email: 'a@b.c', stripeCustomerId: 'cus_1' });
    checkoutCreateMock.mockResolvedValue({ url: 'https://checkout.stripe.test/s/1' });
    (prismaMock as any).$queryRawUnsafe.mockResolvedValue([]);
  });

  for (const status of ['active', 'grace', 'billing_retry'] as const) {
    it(`REFUSES Stripe checkout while an Apple subscription is ${status}`, async () => {
      (prismaMock as any).$queryRawUnsafe.mockResolvedValue([appleRow({ status, gracePeriodExpiresAt: status === 'grace' ? '2030-01-01T00:00:00.000Z' : null })]);

      await expect(createCheckoutSession('user_1', 'price_pro'))
        .rejects.toBeInstanceOf(AppleBillingRailActiveError);

      // No provider-side paid rail may be created for a blocked user.
      expect(checkoutCreateMock).not.toHaveBeenCalled();
      expect(customersCreateMock).not.toHaveBeenCalled();
    });
  }

  it('billing_retry blocks even though the user currently has NO paid access', async () => {
    // The whole point of keeping the predicates separate: User.plan says free,
    // Apple may still collect, so a second rail would double-bill.
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user_1', email: 'a@b.c', stripeCustomerId: 'cus_1', plan: 'free' });
    (prismaMock as any).$queryRawUnsafe.mockResolvedValue([appleRow({ status: 'billing_retry', expiresAt: '2020-01-01T00:00:00.000Z' })]);
    await expect(createCheckoutSession('user_1', 'price_pro'))
      .rejects.toBeInstanceOf(AppleBillingRailActiveError);
  });

  for (const status of ['expired', 'revoked'] as const) {
    it(`ALLOWS Stripe checkout once the Apple subscription is ${status}`, async () => {
      (prismaMock as any).$queryRawUnsafe.mockResolvedValue([appleRow({ status })]);
      await expect(createCheckoutSession('user_1', 'price_pro')).resolves.toContain('https://');
      expect(checkoutCreateMock).toHaveBeenCalled();
    });
  }

  it('ALLOWS Stripe checkout for a user with no Apple rail at all', async () => {
    await expect(createCheckoutSession('user_1', 'price_pro')).resolves.toContain('https://');
  });

  it('scopes the rail query to Production', async () => {
    // Sandbox isolation is enforced by the query itself; the real-engine test
    // proves the filtering, this proves the argument is actually passed.
    await createCheckoutSession('user_1', 'price_pro');
    const call = (prismaMock as any).$queryRawUnsafe.mock.calls[0];
    expect(String(call[0])).toContain('"environment" = ?');
    expect(call[2]).toBe('Production');
  });
});

describe('stale Stripe events cannot erase Apple entitlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.billingWebhookEvent.create.mockResolvedValue({ id: 'evt_1' });
    prismaMock.user.update.mockResolvedValue({});
    (prismaMock as any).$queryRawUnsafe.mockResolvedValue([]);
    // The user on this Stripe customer is currently Apple-owned.
    (prismaMock.user as any).findMany.mockResolvedValue([{ id: 'user_1', applePurchaseSource: APPLE_PURCHASE_SOURCE }]);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user_1', applePurchaseSource: APPLE_PURCHASE_SOURCE });
  });

  it('a stale subscription.deleted does not free an Apple-owned plan', async () => {
    await handleWebhookEvent({
      id: 'evt_del_apple', type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_apple' } },
    } as any);

    const planWrites = prismaMock.user.update.mock.calls.filter((c: any) => c[0]?.data?.plan !== undefined);
    expect(planWrites).toHaveLength(0);

    // The dead Stripe rail IS cleared, which also resolves the double-rail state.
    const railWrites = prismaMock.user.update.mock.calls.filter(
      (c: any) => 'stripeSubscriptionId' in (c[0]?.data ?? {}),
    );
    expect(railWrites).toHaveLength(1);
    expect(railWrites[0][0].data.stripeSubscriptionId).toBe(null);
  });

  it('a stale invoice.payment_failed does not free an Apple-owned plan', async () => {
    await handleWebhookEvent({
      id: 'evt_pf_apple', type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_apple' } },
    } as any);
    const planWrites = prismaMock.user.update.mock.calls.filter((c: any) => c[0]?.data?.plan !== undefined);
    expect(planWrites).toHaveLength(0);
  });

  it('a Stripe GRANT is refused while a blocking Apple rail exists', async () => {
    // Should be unreachable via checkout, but the webhook path must not become
    // a back door that silently overwrites Apple.
    (prismaMock as any).$queryRawUnsafe.mockResolvedValue([{
      environment: 'Production', originalTransactionId: '2000000123456789', userId: 'user_1',
      plan: 'pro', status: 'active', expiresAt: '2030-01-01T00:00:00.000Z',
      gracePeriodExpiresAt: null, autoRenewStatus: 1, currentTransactionId: 'txn-1',
    }]);
    (prismaMock.user as any).findMany.mockResolvedValue([{ id: 'user_1', applePurchaseSource: APPLE_PURCHASE_SOURCE }]);

    await handleWebhookEvent({
      id: 'evt_upd_conflict', type: 'customer.subscription.updated',
      data: { object: {
        id: 'sub_x', customer: 'cus_apple', status: 'active', start_date: 1700000000,
        items: { data: [{ price: { id: 'price_pro' }, current_period_end: 1735000000 }] },
      } },
    } as any);

    const planWrites = prismaMock.user.update.mock.calls.filter((c: any) => c[0]?.data?.plan !== undefined);
    expect(planWrites).toHaveLength(0);
  });
});
