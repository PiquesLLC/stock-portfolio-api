import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

const {
  invoicesRetrieveMock,
  recordWebhookEventMock,
  subscriptionsCancelMock,
  subscriptionsRetrieveMock,
} = vi.hoisted(() => ({
  invoicesRetrieveMock: vi.fn(),
  recordWebhookEventMock: vi.fn(),
  subscriptionsCancelMock: vi.fn(),
  subscriptionsRetrieveMock: vi.fn(),
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
      create: vi.fn(),
    };
    checkout = {
      sessions: {
        create: vi.fn(),
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
} from '../services/billing.service';

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
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user_1' },
        data: expect.objectContaining({
          plan: 'pro',
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
        }),
      })
    );
    expect(prismaMock.billingWebhookEvent.deleteMany).not.toHaveBeenCalled();
  });

  it('processes customer.subscription.updated and updates plan', async () => {
    const event = {
      id: 'evt_sub_updated_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_2',
          customer: 'cus_2',
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

    expect(prismaMock.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeCustomerId: 'cus_2' },
        data: expect.objectContaining({
          plan: 'premium',
          stripeSubscriptionId: 'sub_2',
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

    expect(prismaMock.user.updateMany).toHaveBeenCalledWith({
      where: { stripeCustomerId: 'cus_3' },
      data: {
        plan: 'free',
        stripeSubscriptionId: null,
        planExpiresAt: null,
      },
    });
  });

  it('processes invoice.payment_failed and sets grace-period expiry', async () => {
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

    expect(prismaMock.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeCustomerId: 'cus_4', plan: { not: 'free' } },
        data: expect.objectContaining({
          planExpiresAt: expect.any(Date),
        }),
      })
    );
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
