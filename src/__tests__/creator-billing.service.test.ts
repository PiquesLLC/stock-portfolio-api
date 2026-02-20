import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

const {
  checkoutCreateMock,
  chargesRetrieveMock,
  invoicesRetrieveMock,
  subscriptionsUpdateMock,
} = vi.hoisted(() => ({
  checkoutCreateMock: vi.fn(),
  chargesRetrieveMock: vi.fn(),
  invoicesRetrieveMock: vi.fn(),
  subscriptionsUpdateMock: vi.fn(),
}));

vi.mock('stripe', () => {
  class StripeMock {
    checkout = {
      sessions: {
        create: checkoutCreateMock,
      },
    };
    charges = {
      retrieve: chargesRetrieveMock,
    };
    invoices = {
      retrieve: invoicesRetrieveMock,
    };
    subscriptions = {
      update: subscriptionsUpdateMock,
    };
    customers = {
      create: vi.fn(),
    };
    accounts = {
      create: vi.fn(),
    };
    accountLinks = {
      create: vi.fn(),
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
    stripeConnectWebhookSecret: 'whsec_connect_123',
    stripeReturnUrl: 'http://localhost:5173/settings/billing',
    creatorMonetizationEnabled: true,
    creatorAdminUserIds: [],
  },
}));

import {
  createCreatorCheckoutSession,
  handleCreatorWebhookEvent,
} from '../services/creator-billing.service';

function fixtureFactory(seed = '1') {
  const creatorUserId = `creator_${seed}`;
  const subscriberUserId = `subscriber_${seed}`;
  const subscriptionId = `creator_sub_${seed}`;
  const stripeSubscriptionId = `sub_${seed}`;
  const stripeChargeId = `ch_${seed}`;
  const stripeInvoiceId = `in_${seed}`;
  const stripePayoutId = `po_${seed}`;

  return {
    ids: {
      creatorUserId,
      subscriberUserId,
      subscriptionId,
      stripeSubscriptionId,
      stripeChargeId,
      stripeInvoiceId,
      stripePayoutId,
    },
    event: {
      invoicePaid: (eventId = `evt_paid_${seed}`, amountPaid = 10000) => ({
        id: eventId,
        type: 'invoice.paid',
        data: { object: { amount_paid: amountPaid, subscription: stripeSubscriptionId } },
      }),
      invoicePaymentFailed: (eventId = `evt_failed_${seed}`) => ({
        id: eventId,
        type: 'invoice.payment_failed',
        data: { object: { subscription: stripeSubscriptionId } },
      }),
      chargeRefunded: (eventId = `evt_refund_${seed}`, amount = 10000, amountRefunded = 10000) => ({
        id: eventId,
        type: 'charge.refunded',
        data: { object: { id: stripeChargeId, amount, amount_refunded: amountRefunded, invoice: stripeInvoiceId } },
      }),
      disputeCreated: (eventId = `evt_dispute_created_${seed}`, reason = 'fraudulent') => ({
        id: eventId,
        type: 'charge.dispute.created',
        data: { object: { charge: stripeChargeId, reason, status: 'needs_response' } },
      }),
      disputeClosed: (eventId = `evt_dispute_closed_${seed}`, status: 'won' | 'lost') => ({
        id: eventId,
        type: 'charge.dispute.closed',
        data: { object: { charge: stripeChargeId, status } },
      }),
      payoutPaid: (eventId = `evt_payout_paid_${seed}`) => ({
        id: eventId,
        type: 'payout.paid',
        data: { object: { id: stripePayoutId } },
      }),
      payoutFailed: (eventId = `evt_payout_failed_${seed}`) => ({
        id: eventId,
        type: 'payout.failed',
        data: { object: { id: stripePayoutId } },
      }),
    },
  };
}

function ensureCreatorMockShape(): void {
  const p = prismaMock as any;
  p.creatorWebhookEvent ??= {};
  p.creatorWebhookEvent.create ??= vi.fn();
  p.creatorWebhookEvent.deleteMany ??= vi.fn();

  p.creatorSubscription ??= {};
  p.creatorSubscription.findFirst ??= vi.fn();
  p.creatorSubscription.update ??= vi.fn();
  p.creatorSubscription.updateMany ??= vi.fn();
  p.creatorSubscription.upsert ??= vi.fn();
  p.creatorSubscription.findUnique ??= vi.fn();

  p.creatorWalletLedger ??= {};
  p.creatorWalletLedger.findFirst ??= vi.fn();
  p.creatorWalletLedger.create ??= vi.fn();
  p.creatorWalletLedger.createMany ??= vi.fn();

  p.creatorSubscriptionEvent ??= {};
  p.creatorSubscriptionEvent.create ??= vi.fn();

  p.creatorPayout ??= {};
  p.creatorPayout.updateMany ??= vi.fn();
  p.creatorPayout.aggregate ??= vi.fn();
  p.creatorPayout.count ??= vi.fn();
  p.creatorPayout.create ??= vi.fn();

  p.creator ??= {};
  p.creator.findUnique ??= vi.fn();
  p.creator.update ??= vi.fn();

  p.user ??= {};
  p.user.findUnique ??= vi.fn();
  p.user.update ??= vi.fn();

  p.$transaction ??= vi.fn((ops: any[]) => Promise.all(ops));
}

describe('creator billing webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureCreatorMockShape();
    (prismaMock as any).$transaction = vi.fn((arg: unknown) => {
      if (typeof arg === 'function') return arg(prismaMock);
      if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
      return Promise.resolve(arg);
    });

    (prismaMock as any).creatorWebhookEvent.create.mockResolvedValue({ id: 'cw_1' });
    (prismaMock as any).creatorWebhookEvent.deleteMany.mockResolvedValue({ count: 1 });
    (prismaMock as any).creatorSubscription.findFirst.mockResolvedValue({
      id: 'creator_sub_1',
      creatorUserId: 'creator_1',
      stripeSubscriptionId: 'sub_1',
    });
    (prismaMock as any).creatorSubscription.update.mockResolvedValue({});
    (prismaMock as any).creatorSubscription.updateMany.mockResolvedValue({ count: 1 });
    (prismaMock as any).creatorSubscriptionEvent.create.mockResolvedValue({});
    (prismaMock as any).creatorWalletLedger.findFirst.mockResolvedValue(null);
    (prismaMock as any).creatorWalletLedger.create.mockResolvedValue({});
    (prismaMock as any).creatorPayout.updateMany.mockResolvedValue({ count: 1 });

    chargesRetrieveMock.mockResolvedValue({
      id: 'ch_1',
      object: 'charge',
      amount: 10000,
      amount_refunded: 10000,
      invoice: 'in_1',
    });
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_1',
      subscription: 'sub_1',
    });
  });

  it('creates checkout with transfer destination + 20% app fee', async () => {
    (prismaMock as any).creator.findUnique.mockResolvedValue({
      status: 'active',
      pricingCents: 1500,
      trialDays: 7,
      stripeConnectId: 'acct_123',
      user: { displayName: 'Creator One' },
    });
    (prismaMock as any).user.findUnique.mockResolvedValue({
      id: 'subscriber_1',
      email: 'sub@example.com',
      stripeCustomerId: 'cus_1',
    });
    checkoutCreateMock.mockResolvedValue({ url: 'https://checkout.stripe.test/cs_123' });

    const url = await createCreatorCheckoutSession('subscriber_1', 'creator_1');
    expect(url).toContain('checkout.stripe.test');
    expect(checkoutCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_data: expect.objectContaining({
          application_fee_percent: 20,
          transfer_data: { destination: 'acct_123' },
        }),
      })
    );
  });

  it('ignores duplicate webhook event ids', async () => {
    (prismaMock as any).creatorWebhookEvent.create.mockRejectedValue({ code: 'P2002' });
    const fx = fixtureFactory('dup');
    await handleCreatorWebhookEvent(fx.event.invoicePaid('evt_dup'));

    expect((prismaMock as any).creatorWalletLedger.create).not.toHaveBeenCalled();
    expect((prismaMock as any).creatorSubscription.updateMany).not.toHaveBeenCalled();
  });

  it('does not credit if invoice.amount_paid is non-number', async () => {
    const fx = fixtureFactory('badamt');
    await handleCreatorWebhookEvent({
      id: 'evt_bad_amount',
      type: 'invoice.paid',
      data: { object: { amount_paid: '10000', subscription: fx.ids.stripeSubscriptionId } },
    } as any);

    expect((prismaMock as any).creatorWalletLedger.create).not.toHaveBeenCalled();
  });

  it('sets past_due on invoice.payment_failed', async () => {
    const fx = fixtureFactory('failed');
    await handleCreatorWebhookEvent(fx.event.invoicePaymentFailed());

    expect((prismaMock as any).creatorSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: fx.ids.stripeSubscriptionId },
        data: expect.objectContaining({ status: 'past_due', currentPeriodEnd: expect.any(Date) }),
      })
    );
  });

  it('writes refund reversal entries for partial refund without cancel', async () => {
    const fx = fixtureFactory('partial');
    chargesRetrieveMock.mockResolvedValueOnce({
      id: fx.ids.stripeChargeId,
      object: 'charge',
      amount: 10000,
      amount_refunded: 3000,
      invoice: fx.ids.stripeInvoiceId,
    });
    invoicesRetrieveMock.mockResolvedValueOnce({
      id: fx.ids.stripeInvoiceId,
      subscription: fx.ids.stripeSubscriptionId,
    });

    await handleCreatorWebhookEvent(fx.event.chargeRefunded('evt_refund_partial', 10000, 3000));

    expect((prismaMock as any).creatorWalletLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'refund',
          amountCents: -2400,
        }),
      })
    );
    expect((prismaMock as any).creatorSubscription.update).not.toHaveBeenCalled();
  });

  it('full refund cancels subscription and writes cancel event', async () => {
    const fx = fixtureFactory('full');
    chargesRetrieveMock.mockResolvedValueOnce({
      id: fx.ids.stripeChargeId,
      object: 'charge',
      amount: 10000,
      amount_refunded: 10000,
      invoice: fx.ids.stripeInvoiceId,
    });
    invoicesRetrieveMock.mockResolvedValueOnce({
      id: fx.ids.stripeInvoiceId,
      subscription: fx.ids.stripeSubscriptionId,
    });

    await handleCreatorWebhookEvent(fx.event.chargeRefunded('evt_refund_full', 10000, 10000));

    expect((prismaMock as any).creatorSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'canceled', canceledAt: expect.any(Date) }),
      })
    );
    expect((prismaMock as any).creatorSubscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'canceled' }),
      })
    );
  });

  it('marks past_due + disputedAt and records dispute fee on charge.dispute.created', async () => {
    const fx = fixtureFactory('dispute');
    await handleCreatorWebhookEvent(fx.event.disputeCreated('evt_dispute_created', 'fraudulent'));

    expect((prismaMock as any).creatorSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'past_due', disputedAt: expect.any(Date) }),
      })
    );
    expect((prismaMock as any).creatorWalletLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'platform_fee',
          amountCents: 1500,
        }),
      })
    );
  });

  it('restores active on dispute won and cancels on dispute lost', async () => {
    const fx = fixtureFactory('closed');
    await handleCreatorWebhookEvent(fx.event.disputeClosed('evt_dispute_won', 'won'));
    expect((prismaMock as any).creatorSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'active', disputedAt: null }),
      })
    );

    await handleCreatorWebhookEvent(fx.event.disputeClosed('evt_dispute_lost', 'lost'));
    expect((prismaMock as any).creatorSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'canceled', canceledAt: expect.any(Date) }),
      })
    );
  });

  it('handles refund-then-dispute and dispute-then-refund sequences deterministically', async () => {
    const fxA = fixtureFactory('seqA');
    const fxB = fixtureFactory('seqB');

    // sequence A: refund then dispute
    chargesRetrieveMock.mockResolvedValueOnce({
      id: fxA.ids.stripeChargeId,
      object: 'charge',
      amount: 10000,
      amount_refunded: 10000,
      invoice: fxA.ids.stripeInvoiceId,
    });
    invoicesRetrieveMock.mockResolvedValueOnce({
      id: fxA.ids.stripeInvoiceId,
      subscription: fxA.ids.stripeSubscriptionId,
    });
    await handleCreatorWebhookEvent(fxA.event.chargeRefunded('evt_seqA_refund', 10000, 10000));
    await handleCreatorWebhookEvent(fxA.event.disputeCreated('evt_seqA_dispute', 'fraudulent'));

    // sequence B: dispute then refund
    chargesRetrieveMock.mockResolvedValueOnce({
      id: fxB.ids.stripeChargeId,
      object: 'charge',
      amount: 10000,
      amount_refunded: 10000,
      invoice: fxB.ids.stripeInvoiceId,
    });
    invoicesRetrieveMock.mockResolvedValueOnce({
      id: fxB.ids.stripeInvoiceId,
      subscription: fxB.ids.stripeSubscriptionId,
    });
    await handleCreatorWebhookEvent(fxB.event.disputeCreated('evt_seqB_dispute', 'fraudulent'));
    await handleCreatorWebhookEvent(fxB.event.chargeRefunded('evt_seqB_refund', 10000, 10000));

    expect((prismaMock as any).creatorWebhookEvent.create).toHaveBeenCalledTimes(4);
    expect((prismaMock as any).creatorWalletLedger.create).toHaveBeenCalled();
    expect((prismaMock as any).creatorSubscription.update).toHaveBeenCalled();
  });

  it('updates payout by stripePayoutId for payout.paid and payout.failed', async () => {
    const fx = fixtureFactory('payout');
    await handleCreatorWebhookEvent(fx.event.payoutPaid('evt_payout_paid_1'));
    expect((prismaMock as any).creatorPayout.updateMany).toHaveBeenCalledWith({
      where: { stripePayoutId: fx.ids.stripePayoutId },
      data: { status: 'completed', paidAt: expect.any(Date) },
    });

    await handleCreatorWebhookEvent(fx.event.payoutFailed('evt_payout_failed_1'));
    expect((prismaMock as any).creatorPayout.updateMany).toHaveBeenCalledWith({
      where: { stripePayoutId: fx.ids.stripePayoutId },
      data: { status: 'failed' },
    });
  });
});
