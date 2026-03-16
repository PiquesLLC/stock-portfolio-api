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
      checkoutCompleted: (eventId = `evt_checkout_${seed}`) => ({
        id: eventId,
        type: 'checkout.session.completed',
        data: {
          object: {
            metadata: { creatorUserId, subscriberUserId },
            subscription: stripeSubscriptionId,
          },
        },
      }),
      subscriptionUpdated: (eventId = `evt_sub_updated_${seed}`, cancelAtPeriodEnd = false, currentPeriodEnd?: number) => ({
        id: eventId,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: stripeSubscriptionId,
            cancel_at_period_end: cancelAtPeriodEnd,
            items: { data: [{ current_period_end: currentPeriodEnd ?? Math.floor(Date.now() / 1000) + 30 * 86400 }] },
          },
        },
      }),
      subscriptionDeleted: (eventId = `evt_sub_deleted_${seed}`) => ({
        id: eventId,
        type: 'customer.subscription.deleted',
        data: { object: { id: stripeSubscriptionId } },
      }),
      accountUpdated: (eventId = `evt_acct_updated_${seed}`, accountId = 'acct_connect_123', chargesEnabled = true, payoutsEnabled = true) => ({
        id: eventId,
        type: 'account.updated',
        data: { object: { id: accountId, charges_enabled: chargesEnabled, payouts_enabled: payoutsEnabled } },
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
  p.creatorWalletLedger.findMany ??= vi.fn().mockResolvedValue([]);
  p.creatorWalletLedger.count ??= vi.fn().mockResolvedValue(0);
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
  p.creator.findFirst ??= vi.fn();
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
    const callArg = checkoutCreateMock.mock.calls[0]?.[0];
    expect(callArg?.subscription_data?.trial_period_days).toBeUndefined();
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

  it('handles out-of-order invoice events (payment_failed before paid) and still credits exactly once', async () => {
    const fx = fixtureFactory('ooo_invoice');
    await handleCreatorWebhookEvent(fx.event.invoicePaymentFailed('evt_ooo_failed_first'));
    await handleCreatorWebhookEvent(fx.event.invoicePaid('evt_ooo_paid_after', 10000));

    const updateCalls = (prismaMock as any).creatorSubscription.updateMany.mock.calls;
    const paidCall = (prismaMock as any).creatorWalletLedger.create.mock.calls.find(
      (c: any[]) => c?.[0]?.data?.description === 'stripe_event:evt_ooo_paid_after:creator_share'
    );

    expect(updateCalls.some((c: any[]) => c?.[0]?.data?.status === 'past_due')).toBe(true);
    expect(paidCall).toBeTruthy();
    expect((prismaMock as any).creatorWalletLedger.create.mock.calls.filter(
      (c: any[]) => String(c?.[0]?.data?.description || '').includes('evt_ooo_paid_after')
    ).length).toBe(2);
  });

  it('handles out-of-order dispute events (closed before created) without throwing and preserves deterministic updates', async () => {
    const fx = fixtureFactory('ooo_dispute');
    await handleCreatorWebhookEvent(fx.event.disputeClosed('evt_ooo_dispute_closed_first', 'won'));
    await handleCreatorWebhookEvent(fx.event.disputeCreated('evt_ooo_dispute_created_after', 'fraudulent'));

    const updateCalls = (prismaMock as any).creatorSubscription.update.mock.calls.map((c: any[]) => c?.[0]?.data);
    expect(updateCalls).toContainEqual(expect.objectContaining({ status: 'active', disputedAt: null }));
    expect(updateCalls).toContainEqual(expect.objectContaining({ status: 'past_due', disputedAt: expect.any(Date) }));
    expect((prismaMock as any).creatorWalletLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: expect.stringContaining('evt_ooo_dispute_created_after'),
        }),
      })
    );
  });

  it('dedupes mixed duplicate event stream (failed, paid, refunded, payout_failed)', async () => {
    const fx = fixtureFactory('ooo_mix');
    const seenEventIds = new Set<string>();
    (prismaMock as any).creatorWebhookEvent.create.mockImplementation(({ data }: any) => {
      const eventId = String(data?.eventId ?? '');
      if (seenEventIds.has(eventId)) {
        return Promise.reject({ code: 'P2002' });
      }
      seenEventIds.add(eventId);
      return Promise.resolve({ id: `cw_${eventId}` });
    });

    await handleCreatorWebhookEvent(fx.event.invoicePaymentFailed('evt_mix_failed'));
    await handleCreatorWebhookEvent(fx.event.invoicePaymentFailed('evt_mix_failed'));

    await handleCreatorWebhookEvent(fx.event.invoicePaid('evt_mix_paid', 10000));
    await handleCreatorWebhookEvent(fx.event.invoicePaid('evt_mix_paid', 10000));

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
    await handleCreatorWebhookEvent(fx.event.chargeRefunded('evt_mix_refund', 10000, 3000));
    await handleCreatorWebhookEvent(fx.event.chargeRefunded('evt_mix_refund', 10000, 3000));

    await handleCreatorWebhookEvent(fx.event.payoutFailed('evt_mix_payout_failed'));
    await handleCreatorWebhookEvent(fx.event.payoutFailed('evt_mix_payout_failed'));

    const failedUpdates = (prismaMock as any).creatorSubscription.updateMany.mock.calls.filter(
      (c: any[]) => c?.[0]?.data?.status === 'past_due'
    );
    const paidLedgerByEvent = (prismaMock as any).creatorWalletLedger.create.mock.calls.filter(
      (c: any[]) => String(c?.[0]?.data?.description || '').includes('evt_mix_paid')
    );
    const refundLedgerByEvent = (prismaMock as any).creatorWalletLedger.create.mock.calls.filter(
      (c: any[]) => String(c?.[0]?.data?.description || '').includes('evt_mix_refund')
    );

    expect(failedUpdates.length).toBe(1);
    expect(paidLedgerByEvent.length).toBe(2); // creator share + platform fee once
    expect(refundLedgerByEvent.length).toBe(2); // refund + platform refund once
    expect((prismaMock as any).creatorPayout.updateMany.mock.calls.filter(
      (c: any[]) => c?.[0]?.where?.stripePayoutId === fx.ids.stripePayoutId
    ).length).toBe(1);
  });

  // ── Out-of-order / lifecycle tests ──────────────────────────────

  it('processes subscription lifecycle: checkout → updated → deleted', async () => {
    const fx = fixtureFactory('lifecycle');
    (prismaMock as any).creatorSubscription.upsert.mockResolvedValue({ id: fx.ids.subscriptionId });
    (prismaMock as any).creatorSubscription.findUnique.mockResolvedValue({ id: fx.ids.subscriptionId });

    await handleCreatorWebhookEvent(fx.event.checkoutCompleted());
    expect((prismaMock as any).creatorSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: 'active' }),
        create: expect.objectContaining({ status: 'active' }),
      })
    );
    expect((prismaMock as any).creatorSubscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'created' }),
      })
    );

    await handleCreatorWebhookEvent(fx.event.subscriptionUpdated('evt_sub_updated_lifecycle'));
    expect((prismaMock as any).creatorSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: fx.ids.stripeSubscriptionId },
        data: expect.objectContaining({ status: 'active' }),
      })
    );

    await handleCreatorWebhookEvent(fx.event.subscriptionDeleted());
    expect((prismaMock as any).creatorSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: fx.ids.stripeSubscriptionId },
        data: expect.objectContaining({ status: 'expired' }),
      })
    );
  });

  it('handles subscription.deleted before checkout.session.completed without throwing', async () => {
    const fx = fixtureFactory('deleted_first');
    (prismaMock as any).creatorSubscription.upsert.mockResolvedValue({ id: fx.ids.subscriptionId });
    (prismaMock as any).creatorSubscription.findUnique.mockResolvedValue({ id: fx.ids.subscriptionId });
    (prismaMock as any).creatorSubscription.updateMany.mockResolvedValue({ count: 0 });

    // deleted fires first — updateMany on non-existent subscription (count=0 is fine)
    await handleCreatorWebhookEvent(fx.event.subscriptionDeleted('evt_deleted_first'));
    expect((prismaMock as any).creatorSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'expired' }),
      })
    );

    // checkout arrives late — upsert still creates the subscription as active
    await handleCreatorWebhookEvent(fx.event.checkoutCompleted('evt_checkout_late'));
    expect((prismaMock as any).creatorSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: 'active' }),
        create: expect.objectContaining({ status: 'active' }),
      })
    );
  });

  it('processes charge.refunded after dispute.closed without double-canceling', async () => {
    const fx = fixtureFactory('double_rev');

    // dispute won restores active
    await handleCreatorWebhookEvent(fx.event.disputeClosed('evt_dispute_closed_double', 'won'));
    expect((prismaMock as any).creatorSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'active', disputedAt: null }),
      })
    );

    // full refund arrives after dispute was already closed as won
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
    await handleCreatorWebhookEvent(fx.event.chargeRefunded('evt_refund_after_dispute', 10000, 10000));

    // Refund handler writes ledger entries and cancels
    expect((prismaMock as any).creatorWalletLedger.create).toHaveBeenCalled();
    expect((prismaMock as any).creatorSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'canceled' }),
      })
    );
  });

  it('handles orphaned payout.paid without throwing when no DB record exists', async () => {
    const fx = fixtureFactory('orphan_payout');
    (prismaMock as any).creatorPayout.updateMany.mockResolvedValue({ count: 0 });

    await handleCreatorWebhookEvent(fx.event.payoutPaid('evt_orphan_payout'));

    // Should not throw — updateMany with count 0 is a no-op
    expect((prismaMock as any).creatorPayout.updateMany).toHaveBeenCalledWith({
      where: { stripePayoutId: fx.ids.stripePayoutId },
      data: { status: 'completed', paidAt: expect.any(Date) },
    });
  });

  it('processes invoice.paid after charge.refunded and credits independently', async () => {
    const fx = fixtureFactory('paid_after_refund');

    // First: refund processes
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
    await handleCreatorWebhookEvent(fx.event.chargeRefunded('evt_refund_first', 10000, 10000));

    // Second: late invoice.paid arrives (different event ID, so not deduped)
    await handleCreatorWebhookEvent(fx.event.invoicePaid('evt_paid_late', 10000));

    // Both should have been processed (different event IDs)
    const refundLedger = (prismaMock as any).creatorWalletLedger.create.mock.calls.filter(
      (c: any[]) => String(c?.[0]?.data?.description || '').includes('evt_refund_first')
    );
    const paidLedger = (prismaMock as any).creatorWalletLedger.create.mock.calls.filter(
      (c: any[]) => String(c?.[0]?.data?.description || '').includes('evt_paid_late')
    );
    expect(refundLedger.length).toBeGreaterThan(0);
    expect(paidLedger.length).toBeGreaterThan(0);
  });

  it('handles subscription.updated before checkout.session.completed gracefully', async () => {
    const fx = fixtureFactory('updated_first');
    (prismaMock as any).creatorSubscription.upsert.mockResolvedValue({ id: fx.ids.subscriptionId });
    (prismaMock as any).creatorSubscription.findUnique.mockResolvedValue({ id: fx.ids.subscriptionId });
    (prismaMock as any).creatorSubscription.updateMany.mockResolvedValue({ count: 0 });

    // updated arrives first — updateMany on non-existent (count 0)
    await handleCreatorWebhookEvent(fx.event.subscriptionUpdated('evt_updated_early'));
    expect((prismaMock as any).creatorSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: fx.ids.stripeSubscriptionId },
      })
    );

    // checkout arrives late — creates subscription
    await handleCreatorWebhookEvent(fx.event.checkoutCompleted('evt_checkout_after'));
    expect((prismaMock as any).creatorSubscription.upsert).toHaveBeenCalled();
  });

  // ── account.updated (Stripe Connect onboarding) ────────────────

  it('sets stripeConnectOnboarded=true on account.updated when charges_enabled && payouts_enabled', async () => {
    const fx = fixtureFactory('connect_ok');
    (prismaMock as any).creator.findFirst.mockResolvedValue({
      userId: fx.ids.creatorUserId,
      stripeConnectOnboarded: false,
    });
    (prismaMock as any).creator.update.mockResolvedValue({});

    await handleCreatorWebhookEvent(fx.event.accountUpdated('evt_acct_onboarded', 'acct_connect_123', true, true));

    expect((prismaMock as any).creator.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeConnectId: 'acct_connect_123' },
      })
    );
    expect((prismaMock as any).creator.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: fx.ids.creatorUserId },
        data: { stripeConnectOnboarded: true },
      })
    );
  });

  it('does NOT update stripeConnectOnboarded when charges_enabled is false', async () => {
    const fx = fixtureFactory('connect_partial');
    (prismaMock as any).creator.findFirst.mockResolvedValue(null);

    await handleCreatorWebhookEvent(fx.event.accountUpdated('evt_acct_partial', 'acct_connect_456', false, true));

    expect((prismaMock as any).creator.findFirst).not.toHaveBeenCalled();
    expect((prismaMock as any).creator.update).not.toHaveBeenCalled();
  });

  it('skips update if creator is already onboarded', async () => {
    const fx = fixtureFactory('connect_already');
    (prismaMock as any).creator.findFirst.mockResolvedValue({
      userId: fx.ids.creatorUserId,
      stripeConnectOnboarded: true,
    });

    await handleCreatorWebhookEvent(fx.event.accountUpdated('evt_acct_already', 'acct_connect_789', true, true));

    expect((prismaMock as any).creator.update).not.toHaveBeenCalled();
  });

  it('skips update if no creator found for stripeConnectId', async () => {
    const fx = fixtureFactory('connect_unknown');
    (prismaMock as any).creator.findFirst.mockResolvedValue(null);

    await handleCreatorWebhookEvent(fx.event.accountUpdated('evt_acct_unknown', 'acct_connect_unknown', true, true));

    expect((prismaMock as any).creator.update).not.toHaveBeenCalled();
  });
});
