import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

const { subscriptionsRetrieveMock } = vi.hoisted(() => ({
  subscriptionsRetrieveMock: vi.fn(),
}));

vi.mock('stripe', () => {
  class StripeMock {
    subscriptions = {
      retrieve: subscriptionsRetrieveMock,
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

import { handleWebhookEvent } from '../services/billing.service';
import { getBillingStatus } from '../services/billing.service';

describe('billing webhook handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.billingWebhookEvent.create.mockResolvedValue({ id: 'evt_rec_1' });
    prismaMock.billingWebhookEvent.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.user.updateMany.mockResolvedValue({ count: 1 });
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
});
