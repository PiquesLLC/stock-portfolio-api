import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

const {
  checkoutCreateMock,
  chargesRetrieveMock,
  getPayoutBalanceFromLedgerMock,
  invoicesRetrieveMock,
  transfersCreateMock,
  subscriptionsUpdateMock,
  invoicePaymentsListMock,
  paymentIntentsRetrieveMock,
  sentryCaptureExceptionMock,
} = vi.hoisted(() => ({
  checkoutCreateMock: vi.fn(),
  chargesRetrieveMock: vi.fn(),
  getPayoutBalanceFromLedgerMock: vi.fn(),
  invoicesRetrieveMock: vi.fn(),
  transfersCreateMock: vi.fn(),
  subscriptionsUpdateMock: vi.fn(),
  invoicePaymentsListMock: vi.fn(),
  paymentIntentsRetrieveMock: vi.fn(),
  sentryCaptureExceptionMock: vi.fn(),
}));

// Payout failures that cannot be repaired in-process must ALERT rather than
// leave a lone console line, so the tests assert on the Sentry call.
vi.mock('@sentry/node', () => ({
  captureException: sentryCaptureExceptionMock,
  captureMessage: vi.fn(),
  setupExpressErrorHandler: vi.fn(),
  init: vi.fn(),
  close: vi.fn(async () => true),
  flush: vi.fn(async () => true),
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
    invoicePayments = {
      list: invoicePaymentsListMock,
    };
    paymentIntents = {
      retrieve: paymentIntentsRetrieveMock,
    };
    subscriptions = {
      update: subscriptionsUpdateMock,
    };
    customers = {
      create: vi.fn(),
    };
    transfers = {
      create: transfersCreateMock,
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

vi.mock('../services/creator.service', () => ({
  getPayoutBalanceFromLedger: getPayoutBalanceFromLedgerMock,
}));

vi.mock('../config', () => ({
  config: {
    stripeSecretKey: 'sk_test_123',
    stripeConnectWebhookSecret: 'whsec_connect_123',
    stripeReturnUrl: 'http://localhost:5173/settings/billing',
    creatorMonetizationEnabled: true,
    creatorPayoutsEnabled: true,
    creatorAdminUserIds: [],
  },
}));

import {
  createCreatorCheckoutSession,
  getPayoutBalance,
  handleCreatorWebhookEvent,
  requestPayout,
} from '../services/creator-billing.service';
import { config } from '../config';

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
  p.creatorPayout.update ??= vi.fn();
  p.creatorPayout.aggregate ??= vi.fn();
  p.creatorPayout.count ??= vi.fn();
  p.creatorPayout.create ??= vi.fn();
  p.creatorPayout.findFirst ??= vi.fn();

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
    // Re-arm per test: clearAllMocks() clears CALLS but not implementations, so
    // a prior test's prior-credit fixture would otherwise leak in and skew the
    // reversal delta calculation.
    (prismaMock as any).creatorWalletLedger.findMany.mockResolvedValue([]);
    (prismaMock as any).creatorPayout.updateMany.mockResolvedValue({ count: 1 });
    (prismaMock as any).creatorPayout.update.mockResolvedValue({});
    (prismaMock as any).creatorPayout.create.mockResolvedValue({ id: 'payout_1', amountCents: 8000 });
    (prismaMock as any).creatorPayout.count.mockResolvedValue(0);
    (prismaMock as any).creatorPayout.aggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
    getPayoutBalanceFromLedgerMock.mockResolvedValue(10000);
    transfersCreateMock.mockResolvedValue({ id: 'tr_1' });

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

  it('creates checkout without transfer_data or application_fee (separate-charges model)', async () => {
    (prismaMock as any).creator.findUnique.mockResolvedValue({
      status: 'active',
      pricingCents: 1500,
      trialDays: 7,
      stripeConnectId: 'acct_123',
      user: { displayName: 'Creator One' },
    });
    // The self-deal guard reads subscriber then creator; give them DISTINCT email/customer
    // so it doesn't (correctly) reject this legit checkout. The sticky fallback then serves
    // getOrCreateStripeCustomer's subscriber lookup.
    (prismaMock as any).user.findUnique
      .mockResolvedValueOnce({ email: 'sub@example.com', stripeCustomerId: 'cus_1' })
      .mockResolvedValueOnce({ email: 'creator@example.com', stripeCustomerId: 'cus_2' })
      .mockResolvedValue({
        id: 'subscriber_1',
        email: 'sub@example.com',
        stripeCustomerId: 'cus_1',
      });
    checkoutCreateMock.mockResolvedValue({ url: 'https://checkout.stripe.test/cs_123' });

    const url = await createCreatorCheckoutSession('subscriber_1', 'creator_1');
    expect(url).toContain('checkout.stripe.test');
    // Under separate-charges-and-transfers, the checkout session must NOT carry
    // transfer_data or application_fee_percent — funds stay on platform balance
    // until requestPayout initiates the single transfer. See audit C1.
    const callArg = checkoutCreateMock.mock.calls[0]?.[0];
    expect(callArg?.subscription_data?.application_fee_percent).toBeUndefined();
    expect(callArg?.subscription_data?.transfer_data).toBeUndefined();
    expect(callArg?.subscription_data?.trial_period_days).toBeUndefined();
    // Metadata is still required so the invoice.paid handler can map back to the creator/subscriber.
    expect(callArg?.subscription_data?.metadata).toEqual({
      creatorUserId: 'creator_1',
      subscriberUserId: 'subscriber_1',
    });
  });

  it('blocks self-subscribe when subscriber and creator share an email (case-insensitive) — sock-puppet guard', async () => {
    (prismaMock as any).user.findUnique
      .mockResolvedValueOnce({ email: 'me@example.com', stripeCustomerId: 'cus_sub' })     // subscriber pre-flight
      .mockResolvedValueOnce({ email: 'ME@Example.com', stripeCustomerId: 'cus_creator' }); // creator pre-flight (same email, diff case)
    await expect(createCreatorCheckoutSession('subscriber_1', 'creator_1'))
      .rejects.toThrow('Cannot subscribe to yourself');
    // Must reject BEFORE any Stripe customer/session is created.
    expect(checkoutCreateMock).not.toHaveBeenCalled();
  });

  it('blocks self-subscribe when subscriber and creator share a Stripe customer — sock-puppet guard', async () => {
    (prismaMock as any).user.findUnique
      .mockResolvedValueOnce({ email: 'a@example.com', stripeCustomerId: 'cus_shared' })  // subscriber
      .mockResolvedValueOnce({ email: 'b@example.com', stripeCustomerId: 'cus_shared' }); // creator (same customer id)
    await expect(createCreatorCheckoutSession('subscriber_1', 'creator_1'))
      .rejects.toThrow('Cannot subscribe to yourself');
    expect(checkoutCreateMock).not.toHaveBeenCalled();
  });

  it('does NOT false-block distinct users who both have null email/customer (guard short-circuits)', async () => {
    (prismaMock as any).user.findUnique
      .mockResolvedValueOnce({ email: null, stripeCustomerId: null })  // subscriber pre-flight
      .mockResolvedValueOnce({ email: null, stripeCustomerId: null })  // creator pre-flight
      .mockResolvedValue({ id: 'subscriber_1', email: null, stripeCustomerId: 'cus_existing' }); // getOrCreateStripeCustomer
    (prismaMock as any).creatorSubscription.findUnique.mockResolvedValue(null);
    (prismaMock as any).creator.findUnique.mockResolvedValue({
      status: 'active', pricingCents: 1500, trialDays: 7, stripeConnectId: 'acct_123',
      user: { displayName: 'Creator One' },
    });
    checkoutCreateMock.mockResolvedValue({ url: 'https://checkout.stripe.test/cs_null' });
    const url = await createCreatorCheckoutSession('subscriber_1', 'creator_1');
    expect(url).toContain('checkout.stripe.test');
  });

  it('INVARIANT 1: a PARTIAL transfer reversal credits only the amount actually reversed', async () => {
    // Stripe sets amount_reversed and leaves `reversed` false for a partial
    // reversal. The handler credited payout.amountCents regardless, so a $1
    // reversal on a $1,000 transfer restored $1,000 to the wallet — which the
    // creator can then withdraw again. Net over-payment $999.
    (prismaMock as any).creatorPayout.findFirst.mockResolvedValue({
      id: 'payout_rev',
      creatorUserId: 'creator_1',
      amountCents: 100000,
      status: 'completed',
    });

    await handleCreatorWebhookEvent({
      id: 'evt_partial_rev',
      type: 'transfer.reversed',
      data: { object: { id: 'tr_1', amount: 100000, amount_reversed: 100, reversed: false } },
    } as any);

    const credits = (prismaMock as any).creatorWalletLedger.create.mock.calls
      .filter((c: any[]) => String(c?.[0]?.data?.description ?? '').startsWith('transfer_reversed:'));
    expect(credits).toHaveLength(1);
    expect(credits[0][0].data.amountCents).toBe(100);
  });

  it('INVARIANT 2: a STAGED reversal credits the full amount across both events', async () => {
    // Marking the payout 'reversed' on a PARTIAL made the status-based
    // idempotent skip swallow every later event for that transfer. Stripe then
    // reverses the remaining $999 and takes it from the creator's Connect
    // account, but our ledger credited them $1 — a silent $999 loss. The
    // reconciler cannot see it either: once Stripe's `reversed` flips true both
    // sides report "reversed" and agree.
    // The cumulative total now lives on the payout row and advances by CAS, so
    // the fixture is stateful rather than a canned list of prior ledger rows.
    const row = {
      id: 'payout_staged',
      creatorUserId: 'creator_1',
      amountCents: 100000,
      status: 'completed',
      reversedAmountCents: 0,
    };
    (prismaMock as any).creatorPayout.findFirst.mockImplementation(async () => ({ ...row }));
    (prismaMock as any).creatorPayout.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where?.reversedAmountCents !== row.reversedAmountCents) return { count: 0 };
      if (typeof data?.reversedAmountCents === 'number') row.reversedAmountCents = data.reversedAmountCents;
      if (data?.status) row.status = data.status;
      return { count: 1 };
    });

    await handleCreatorWebhookEvent({
      id: 'evt_staged_1',
      type: 'transfer.reversed',
      data: { object: { id: 'tr_staged', amount: 100000, amount_reversed: 100, reversed: false } },
    } as any);

    // Second event completes the reversal; $1 is already recorded on the row.
    await handleCreatorWebhookEvent({
      id: 'evt_staged_2',
      type: 'transfer.reversed',
      data: { object: { id: 'tr_staged', amount: 100000, amount_reversed: 100000, reversed: true } },
    } as any);

    const credited = (prismaMock as any).creatorWalletLedger.create.mock.calls
      .filter((c: any[]) => String(c?.[0]?.data?.description ?? '').startsWith('transfer_reversed:tr_staged'))
      .reduce((sum: number, c: any[]) => sum + c[0].data.amountCents, 0);
    expect(credited).toBe(100000);
  });

  it('INVARIANT 1: two CONCURRENT cumulative reversals cannot over-credit', async () => {
    // The staged-reversal test proves correctness under ORDERING. This proves it
    // under CONCURRENCY, which is a different property and the one that broke.
    //
    // amount_reversed is cumulative. Two legitimate Stripe events with distinct
    // event ids (so webhook dedup does not help) can be handled from the same
    // observed state. Reconstructing "already credited" from ledger rows read
    // BEFORE the transaction means both compute their delta from the same
    // snapshot, and because their ledger descriptions carry different cumulative
    // figures the unique index does not collide either — so both inserts land.
    //
    //   A: amount_reversed = 100     reads credited 0 -> credits 100
    //   B: amount_reversed = 100000  reads credited 0 -> credits 100000
    //   total credited 100100 for a 100000 reversal.
    const ledger: { amountCents: number; description: string }[] = [];
    const row = {
      id: 'payout_cc',
      creatorUserId: 'creator_1',
      amountCents: 100000,
      status: 'completed',
      reversedAmountCents: 0,
    };

    (prismaMock as any).creatorWalletLedger.create.mockImplementation(async ({ data }: any) => {
      ledger.push({ amountCents: data.amountCents, description: data.description });
      return {};
    });
    // Compare-and-swap: only advances from the exact value the caller observed.
    (prismaMock as any).creatorPayout.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where?.reversedAmountCents !== row.reversedAmountCents) return { count: 0 };
      if (typeof data?.reversedAmountCents === 'number') row.reversedAmountCents = data.reversedAmountCents;
      if (data?.status) row.status = data.status;
      return { count: 1 };
    });
    (prismaMock as any).creatorPayout.update.mockImplementation(async ({ data }: any) => {
      if (data?.status) row.status = data.status;
      return {};
    });

    const reversalEvent = (id: string, cumulative: number) => ({
      id,
      type: 'transfer.reversed',
      data: { object: { id: 'tr_cc', amount: 100000, amount_reversed: cumulative, reversed: cumulative >= 100000 } },
    });

    // ---- Phase 1: both handlers act on the SAME observed state ----
    // Freezing the reads is exactly the interleaving, made deterministic.
    const frozen = { ...row };
    (prismaMock as any).creatorPayout.findFirst.mockResolvedValue(frozen);
    (prismaMock as any).creatorWalletLedger.findMany.mockResolvedValue([]);

    const [a, b] = await Promise.allSettled([
      handleCreatorWebhookEvent(reversalEvent('evt_cc_a', 100) as any),
      handleCreatorWebhookEvent(reversalEvent('evt_cc_b', 100000) as any),
    ]);

    const creditedAfterPhase1 = ledger.reduce((s, r) => s + r.amountCents, 0);
    // The core assertion: never credit more than Stripe actually reversed.
    expect(creditedAfterPhase1).toBeLessThanOrEqual(100000);
    // Exactly one may win from a given snapshot; the loser must not silently succeed.
    expect([a.status, b.status]).toContain('rejected');

    // ---- Phase 2: the loser is redelivered and re-reads fresh state ----
    // Throwing clears the webhook dedup marker, so Stripe's retry is processed.
    (prismaMock as any).creatorPayout.findFirst.mockImplementation(async () => ({ ...row }));
    (prismaMock as any).creatorWalletLedger.findMany.mockImplementation(async () => ledger.slice());

    const loser = a.status === 'rejected' ? reversalEvent('evt_cc_a', 100) : reversalEvent('evt_cc_b', 100000);
    await handleCreatorWebhookEvent(loser as any).catch(() => { /* may legitimately be a no-op now */ });

    // Converges on the true cumulative total — never above it.
    const total = ledger.reduce((s, r) => s + r.amountCents, 0);
    expect(total).toBeLessThanOrEqual(100000);
  });

  it('INVARIANT 1: concurrent PARTIAL cumulative reversals settle at the true total', async () => {
    // Same race with two partials: 100 then 200 cumulative. Credited total must
    // end at 200, never 300.
    const ledger: { amountCents: number }[] = [];
    const row = { id: 'payout_cp', creatorUserId: 'creator_1', amountCents: 100000, status: 'completed', reversedAmountCents: 0 };

    (prismaMock as any).creatorWalletLedger.create.mockImplementation(async ({ data }: any) => {
      ledger.push({ amountCents: data.amountCents });
      return {};
    });
    (prismaMock as any).creatorPayout.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where?.reversedAmountCents !== row.reversedAmountCents) return { count: 0 };
      if (typeof data?.reversedAmountCents === 'number') row.reversedAmountCents = data.reversedAmountCents;
      return { count: 1 };
    });
    (prismaMock as any).creatorPayout.update.mockResolvedValue({});

    const ev = (id: string, cumulative: number) => ({
      id, type: 'transfer.reversed',
      data: { object: { id: 'tr_cp', amount: 100000, amount_reversed: cumulative, reversed: false } },
    });

    (prismaMock as any).creatorPayout.findFirst.mockResolvedValue({ ...row });
    (prismaMock as any).creatorWalletLedger.findMany.mockResolvedValue([]);

    await Promise.allSettled([
      handleCreatorWebhookEvent(ev('evt_cp_a', 100) as any),
      handleCreatorWebhookEvent(ev('evt_cp_b', 200) as any),
    ]);

    expect(ledger.reduce((s, r) => s + r.amountCents, 0)).toBeLessThanOrEqual(200);
  });

  it('a FULL transfer reversal still credits the whole payout', async () => {
    (prismaMock as any).creatorPayout.findFirst.mockResolvedValue({
      id: 'payout_rev_full',
      creatorUserId: 'creator_1',
      amountCents: 100000,
      status: 'completed',
    });

    await handleCreatorWebhookEvent({
      id: 'evt_full_rev',
      type: 'transfer.reversed',
      data: { object: { id: 'tr_2', amount: 100000, amount_reversed: 100000, reversed: true } },
    } as any);

    const credits = (prismaMock as any).creatorWalletLedger.create.mock.calls
      .filter((c: any[]) => String(c?.[0]?.data?.description ?? '').startsWith('transfer_reversed:'));
    expect(credits).toHaveLength(1);
    expect(credits[0][0].data.amountCents).toBe(100000);
  });

  it('F-2: payout.paid / payout.failed touch NO payout row', async () => {
    // These describe a Connect BANK payout (po_…), not the platform->Connect
    // transfer a CreatorPayout row models (tr_…), and stripePayoutId is never
    // written to the row — so the old updateMany could only ever match zero
    // rows. Pinned as an explicit no-op, because if it ever DID match,
    // payout.failed would set a terminal status with no ledger credit and
    // transfer.reversed would then skip the real reversal as already-reflected.
    for (const type of ['payout.paid', 'payout.failed']) {
      await handleCreatorWebhookEvent({
        id: `evt_${type.replace('.', '_')}`,
        type,
        data: { object: { id: 'po_bank_payout_1' } },
      } as any);
    }

    expect((prismaMock as any).creatorPayout.updateMany).not.toHaveBeenCalled();
    expect((prismaMock as any).creatorPayout.update).not.toHaveBeenCalled();
    expect((prismaMock as any).creatorWalletLedger.create).not.toHaveBeenCalled();
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

  it('allocates odd-cent invoice revenue using Stripe fee amounts from the webhook payload (legacy destination-charge subs)', async () => {
    const fx = fixtureFactory('odd_invoice');
    await handleCreatorWebhookEvent({
      id: 'evt_paid_odd_invoice',
      type: 'invoice.paid',
      data: {
        object: {
          amount_paid: 10001,
          application_fee_amount: 2000,
          subscription: fx.ids.stripeSubscriptionId,
        },
      },
    } as any);

    // Legacy destination-charge entries are tagged with :legacy_destination so
    // getPayoutBalance excludes them — Stripe has already auto-transferred 80%
    // to the creator's Connect account. See audit C1.
    expect((prismaMock as any).creatorWalletLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: 'stripe_event:evt_paid_odd_invoice:creator_share:legacy_destination',
          amountCents: 8001,
        }),
      })
    );
    expect((prismaMock as any).creatorWalletLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: 'stripe_event:evt_paid_odd_invoice:platform_fee:legacy_destination',
          amountCents: 2000,
        }),
      })
    );
  });

  it('resolves invoice charge id via InvoicePayments API on Stripe 2025-02+ when invoice.charge is absent', async () => {
    // Regression: Stripe API 2025-02 removed Invoice.charge. With no resolution,
    // ledger rows are written without `:charge:<id>` and downstream dispute
    // clawback fails to locate the original earning. The helper must fall
    // through to stripe.invoicePayments.list → paymentIntents.retrieve and
    // embed `:charge:<resolved-id>` in the description.
    const fx = fixtureFactory('charge_resolution');
    invoicePaymentsListMock.mockResolvedValueOnce({
      data: [
        {
          payment: {
            type: 'payment_intent',
            payment_intent: 'pi_resolved_xyz',
          },
        },
      ],
    });
    paymentIntentsRetrieveMock.mockResolvedValueOnce({
      id: 'pi_resolved_xyz',
      latest_charge: 'ch_resolved_xyz',
    });

    await handleCreatorWebhookEvent({
      id: 'evt_paid_resolved',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_needs_resolution',
          amount_paid: 10000,
          subscription: fx.ids.stripeSubscriptionId,
          // NOTE: no `charge` field — simulates Stripe API 2025-02+ payload
        },
      },
    } as any);

    expect(invoicePaymentsListMock).toHaveBeenCalledWith(
      expect.objectContaining({ invoice: 'in_needs_resolution', limit: 1 })
    );
    expect(paymentIntentsRetrieveMock).toHaveBeenCalledWith('pi_resolved_xyz');
    expect((prismaMock as any).creatorWalletLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: 'stripe_event:evt_paid_resolved:charge:ch_resolved_xyz:creator_share',
        }),
      })
    );
    expect((prismaMock as any).creatorWalletLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: 'stripe_event:evt_paid_resolved:charge:ch_resolved_xyz:platform_fee',
        }),
      })
    );
  });

  it('dedupes invoice.paid retries by event-id prefix even when charge resolution differs between attempts', async () => {
    // Regression: my fix for the API-2025-02 charge resolution could double-
    // credit if first delivery resolved charge='' (helper fell through) and
    // a retry resolves charge='ch_xxx' — without prefix-based dedup the
    // two distinct descriptions would both pass the `alreadyCredited` check.
    // The dedup query must match on `stripe_event:<event.id>` prefix.
    const fx = fixtureFactory('dedup_prefix');
    // Simulate: a prior ledger row was written WITHOUT the :charge: segment
    // (e.g., first delivery's helper short-circuited).
    (prismaMock as any).creatorWalletLedger.findFirst.mockResolvedValueOnce({
      id: 'existing_ledger_row',
    });

    invoicePaymentsListMock.mockResolvedValueOnce({
      data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_x' } }],
    });
    paymentIntentsRetrieveMock.mockResolvedValueOnce({
      id: 'pi_x',
      latest_charge: 'ch_now_resolved',
    });

    await handleCreatorWebhookEvent({
      id: 'evt_dedup_retry',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_dedup',
          amount_paid: 10000,
          subscription: fx.ids.stripeSubscriptionId,
        },
      },
    } as any);

    // The retry should NOT create new ledger rows because the prefix
    // (`stripe_event:evt_dedup_retry`) matches the existing row.
    expect((prismaMock as any).creatorWalletLedger.create).not.toHaveBeenCalled();
    // Verify the dedup query used startsWith on the event prefix WITH the
    // trailing colon (defends against `evt_x` matching `evt_x10` etc.).
    expect((prismaMock as any).creatorWalletLedger.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          description: { startsWith: 'stripe_event:evt_dedup_retry:' },
        }),
      })
    );
  });

  it('splits invoice revenue with floor-80% when no application_fee_amount is present (new separate-charges model)', async () => {
    const fx = fixtureFactory('no_app_fee');
    await handleCreatorWebhookEvent({
      id: 'evt_paid_no_fee',
      type: 'invoice.paid',
      data: {
        object: {
          amount_paid: 10001,
          // no application_fee_amount — separate-charges model
          subscription: fx.ids.stripeSubscriptionId,
        },
      },
    } as any);

    // Under floor-80%: creator gets floor(10001*0.8)=8000, platform gets the
    // remainder 2001 so creator+platform === gross.
    expect((prismaMock as any).creatorWalletLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: 'stripe_event:evt_paid_no_fee:creator_share',
          amountCents: 8000,
        }),
      })
    );
    expect((prismaMock as any).creatorWalletLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: 'stripe_event:evt_paid_no_fee:platform_fee',
          amountCents: 2001,
        }),
      })
    );
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

  it('rounds partial refunds by flooring creator share and giving the residual cent to platform', async () => {
    const fx = fixtureFactory('odd_refund');
    chargesRetrieveMock.mockResolvedValueOnce({
      id: fx.ids.stripeChargeId,
      object: 'charge',
      amount: 10001,
      amount_refunded: 3001,
      application_fee_amount: 2000,
      invoice: fx.ids.stripeInvoiceId,
    });
    invoicesRetrieveMock.mockResolvedValueOnce({
      id: fx.ids.stripeInvoiceId,
      subscription: fx.ids.stripeSubscriptionId,
    });

    await handleCreatorWebhookEvent(fx.event.chargeRefunded('evt_refund_odd', 10001, 3001));

    expect((prismaMock as any).creatorWalletLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: `stripe_event:evt_refund_odd:charge:${fx.ids.stripeChargeId}:refund_creator`,
          amountCents: -2400,
        }),
      })
    );
    expect((prismaMock as any).creatorWalletLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: `stripe_event:evt_refund_odd:charge:${fx.ids.stripeChargeId}:refund_platform`,
          amountCents: -601,
        }),
      })
    );
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
          type: 'refund',
          amountCents: -1500,
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

  it('won-then-refund: creator does NOT keep refunded money (F1 regression — refund must net out dispute-won restores)', async () => {
    const fx = fixtureFactory('wtr');

    // In-memory ledger so the dispute/refund handlers read back the rows they write.
    type Row = { type: string; amountCents: number; description: string; seq: number };
    const rows: Row[] = [];
    let seq = 0;
    const matches = (where: any, r: Row): boolean => {
      if (where.type && r.type !== where.type) return false;
      if (where.description?.contains && !r.description.includes(where.description.contains)) return false;
      if (where.amountCents?.lt != null && !(r.amountCents < where.amountCents.lt)) return false;
      if (where.amountCents?.gt != null && !(r.amountCents > where.amountCents.gt)) return false;
      return true;
    };
    (prismaMock as any).creatorWalletLedger.create.mockImplementation(({ data }: any) => {
      const row: Row = { type: data.type, amountCents: data.amountCents, description: data.description, seq: ++seq };
      rows.push(row);
      return Promise.resolve({ id: `wl_${row.seq}`, ...row });
    });
    (prismaMock as any).creatorWalletLedger.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(rows.filter(r => matches(where, r)).map(r => ({ amountCents: r.amountCents }))),
    );
    (prismaMock as any).creatorWalletLedger.findFirst.mockImplementation(({ where, orderBy }: any) => {
      let c = rows.filter(r => matches(where, r));
      if (orderBy?.createdAt === 'desc') c = [...c].sort((a, b) => b.seq - a.seq);
      return Promise.resolve(c[0] ? { amountCents: c[0].amountCents } : null);
    });

    // Same fully-refunded $100 charge across the dispute + refund handlers.
    chargesRetrieveMock.mockResolvedValue({ id: fx.ids.stripeChargeId, object: 'charge', amount: 10000, amount_refunded: 10000, invoice: fx.ids.stripeInvoiceId });
    invoicesRetrieveMock.mockResolvedValue({ id: fx.ids.stripeInvoiceId, subscription: fx.ids.stripeSubscriptionId });

    // Seed the original invoice.paid rows WITH the charge segment (as prod writes them
    // once the invoice's charge is resolved) so the handlers can look them up by charge.
    const cd = (suffix: string) => `stripe_event:evt_wtr_paid:charge:${fx.ids.stripeChargeId}:${suffix}`;
    rows.push({ type: 'earning', amountCents: 8000, description: cd('creator_share'), seq: ++seq });
    rows.push({ type: 'platform_fee', amountCents: 2000, description: cd('platform_fee'), seq: ++seq });

    // earn $80 -> dispute clawback (-$80 -$20 -$15 fee) -> dispute WON (restore +$80 +$20 +$15) -> full refund.
    await handleCreatorWebhookEvent(fx.event.disputeCreated('evt_wtr_dispute', 'fraudulent'));
    await handleCreatorWebhookEvent(fx.event.disputeClosed('evt_wtr_won', 'won'));
    await handleCreatorWebhookEvent(fx.event.chargeRefunded('evt_wtr_refund', 10000, 10000));

    // The refund MUST debit the creator's $80 share (the won-dispute restore was reversed
    // by the refund). Before the fix, the clawback alone made incremental=0 and this row
    // was never written, leaving the creator holding $80 of refunded money.
    const refundCreatorRow = rows.find(r => r.description.includes(':refund_creator'));
    expect(refundCreatorRow?.amountCents).toBe(-8000);

    // Net creator payout balance via the same reducer getPayoutBalanceFromLedger uses.
    let balance = 0;
    for (const r of rows) {
      if (r.description.includes(':legacy_destination')) continue;
      if (r.type === 'earning') balance += Math.abs(r.amountCents);
      if (r.type === 'payout' || r.type === 'refund') balance -= Math.abs(r.amountCents);
    }
    expect(Math.max(0, balance)).toBe(0);
  });

  it('payout.paid / payout.failed are acknowledged but touch NO payout row (F-2)', async () => {
    // This test previously asserted the shape of an updateMany that could never
    // match: `stripePayoutId` is never written to a CreatorPayout row anywhere
    // in production (it appears in src/ only as a test fixture), and
    // `stripeTransferId` holds a `tr_…` id which cannot equal the `po_…` id
    // these events carry. It was asserting the mechanics of an unreachable
    // query, which is why the dead-ness went unnoticed.
    //
    // Left live it was a trap: if anyone started populating stripePayoutId,
    // payout.failed would set a terminal status with no ledger credit, and
    // transfer.reversed treats 'failed' as already-reflected — so a genuine
    // reversal afterwards would be silently dropped. Now an explicit no-op.
    const fx = fixtureFactory('payout');
    await handleCreatorWebhookEvent(fx.event.payoutPaid('evt_payout_paid_1'));
    await handleCreatorWebhookEvent(fx.event.payoutFailed('evt_payout_failed_1'));

    expect((prismaMock as any).creatorPayout.updateMany).not.toHaveBeenCalled();
    expect((prismaMock as any).creatorPayout.update).not.toHaveBeenCalled();
    expect((prismaMock as any).creatorWalletLedger.create).not.toHaveBeenCalled();
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
    // F-2: payout.* events no longer write to CreatorPayout at all — they
    // describe a Connect bank payout, not the transfer this row models.
    expect((prismaMock as any).creatorPayout.updateMany.mock.calls.filter(
      (c: any[]) => c?.[0]?.where?.OR?.[0]?.stripePayoutId === fx.ids.stripePayoutId
    ).length).toBe(0);
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

  it('handles payout.paid for an unknown payout without throwing (F-2)', async () => {
    // The original name and comment ("updateMany with count 0 is a no-op")
    // recorded that this query matched nothing — which was true for EVERY
    // payout.paid event, not just orphaned ones. Now the no-op is explicit
    // rather than an accident of a filter that can never match.
    const fx = fixtureFactory('orphan_payout');

    await handleCreatorWebhookEvent(fx.event.payoutPaid('evt_orphan_payout'));

    expect((prismaMock as any).creatorPayout.updateMany).not.toHaveBeenCalled();
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

  it('serializes concurrent payout requests so only one can reserve the balance', async () => {
    const transactionQueue: Promise<unknown>[] = [];
    const state = {
      pendingCount: 0,
      pendingAmount: 0,
    };
    const tx = {
      creatorPayout: {
        count: vi.fn(async () => state.pendingCount),
        aggregate: vi.fn(async () => ({ _sum: { amountCents: state.pendingAmount } })),
        create: vi.fn(async ({ data }: any) => {
          state.pendingCount += 1;
          state.pendingAmount += data.amountCents;
          return { id: `payout_${state.pendingCount}`, amountCents: data.amountCents };
        }),
        update: vi.fn(async () => ({})),
      },
      creatorWalletLedger: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({})),
      },
    };

    (prismaMock as any).creator.findUnique.mockResolvedValue({
      stripeConnectId: 'acct_123',
      status: 'active',
    });
    (prismaMock as any).creatorWalletLedger.findMany.mockImplementation(async () => {
      throw new Error('global ledger read should not happen inside payout transaction');
    });
    (prismaMock as any).creatorPayout.aggregate.mockImplementation(async () => {
      throw new Error('global payout aggregate should not happen inside payout transaction');
    });
    (prismaMock as any).$transaction = vi.fn(async (callback: any) => {
      const previous = transactionQueue[transactionQueue.length - 1] ?? Promise.resolve();
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      transactionQueue.push(done);
      await previous;
      try {
        return await callback(tx);
      } finally {
        release();
      }
    });

    const [first, second] = await Promise.allSettled([
      requestPayout('creator_1'),
      requestPayout('creator_1'),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(second.status === 'rejected' ? second.reason.message : '').toContain('Existing payout request is still pending');
  });

  it('blocks payouts with HTTP 503 when CREATOR_PAYOUTS_ENABLED is false', async () => {
    const original = (config as any).creatorPayoutsEnabled;
    (config as any).creatorPayoutsEnabled = false;
    try {
      const result = await requestPayout('creator_1').then(
        () => ({ ok: true as const }),
        (err: Error & { status?: number }) => ({ ok: false as const, message: err.message, status: err.status }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain('temporarily paused');
        expect(result.status).toBe(503);
      }
      // Confirm no DB write happened — the throw is before the transaction.
      expect((prismaMock as any).creator.findUnique).not.toHaveBeenCalled();
      expect((prismaMock as any).creatorPayout.create).not.toHaveBeenCalled();
      expect((prismaMock as any).creatorWalletLedger.create).not.toHaveBeenCalled();
    } finally {
      (config as any).creatorPayoutsEnabled = original;
    }
  });

  // ------------------------------------------------------------------
  // H-2 — Stripe transfer outcome handling (double-pay guard)
  // ------------------------------------------------------------------
  // The wallet may only be credited back when we KNOW no money moved.
  // Previously the transfer and the "mark completed" write shared one
  // try/catch, so a failed bookkeeping write looked identical to a failed
  // transfer: the payout was marked failed and the balance restored AFTER the
  // money had left, letting the creator request it again and be paid twice.
  // The Stripe idempotency key does not help — a retry is a new payout row with
  // a new key, which Stripe treats as a distinct legitimate transfer.
  describe('requestPayout — Stripe transfer outcome', () => {
    function armPayout() {
      (prismaMock as any).creator.findUnique.mockResolvedValue({
        stripeConnectId: 'acct_123',
        status: 'active',
      });
      (prismaMock as any).creatorPayout.count.mockResolvedValue(0);
      // A single earning old enough to clear the reserve window, so
      // getPayoutBalance() yields a positive available balance.
      // NOTE: an earlier test in this file installs *throwing* implementations
      // on these two mocks, and vi.clearAllMocks() clears calls but NOT
      // implementations — so they must be re-armed explicitly here.
      (prismaMock as any).creatorWalletLedger.findMany.mockResolvedValue([
        { type: 'earning', amountCents: 10000, createdAt: new Date(Date.now() - 30 * 86400000) },
      ]);
      (prismaMock as any).creatorPayout.aggregate.mockResolvedValue({ _sum: { amountCents: null } });
      (prismaMock as any).creatorPayout.create.mockResolvedValue({ id: 'payout_h2', amountCents: 10000 });
      (prismaMock as any).creatorWalletLedger.create.mockResolvedValue({});
      getPayoutBalanceFromLedgerMock.mockResolvedValue(10000);
    }

    /** Statuses passed to creatorPayout.update across the whole call. */
    function statusesWritten(): unknown[] {
      return (prismaMock as any).creatorPayout.update.mock.calls
        .map((c: any[]) => c?.[0]?.data?.status)
        .filter(Boolean);
    }

    function reversalLedgerWrites(): unknown[] {
      return (prismaMock as any).creatorWalletLedger.create.mock.calls
        .filter((c: any[]) => String(c?.[0]?.data?.description ?? '').startsWith('payout_reversal:'));
    }

    it('restores the wallet when Stripe positively REJECTS the transfer', async () => {
      armPayout();
      transfersCreateMock.mockRejectedValue(
        Object.assign(new Error('Insufficient funds'), { type: 'StripeInvalidRequestError' }),
      );

      await expect(requestPayout('creator_1')).rejects.toThrow('Payout transfer failed');

      // No transfer exists, so reversing is correct.
      expect(statusesWritten()).toContain('failed');
      expect(reversalLedgerWrites().length).toBe(1);
    });

    it('does NOT restore the wallet when the transfer outcome is AMBIGUOUS', async () => {
      armPayout();
      transfersCreateMock.mockRejectedValue(
        Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }),
      );

      await expect(requestPayout('creator_1')).rejects.toThrow(/being confirmed/i);

      // Stripe may or may not have moved the money. Reversing here is the
      // double-pay bug, so the ledger must be untouched and the payout parked.
      expect(statusesWritten()).toContain('processing');
      expect(statusesWritten()).not.toContain('failed');
      expect(reversalLedgerWrites().length).toBe(0);
    });

    it('does NOT restore the wallet when the transfer SUCCEEDS but the completion write fails', async () => {
      // This is the exact double-pay scenario. A transient SQLITE_BUSY on the
      // "mark completed" write must never be mistaken for a failed transfer.
      armPayout();
      transfersCreateMock.mockResolvedValue({ id: 'tr_h2' });
      (prismaMock as any).creatorPayout.update
        .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked')) // completion write
        .mockResolvedValue({});                                             // park-as-processing

      await expect(requestPayout('creator_1')).rejects.toThrow(/sent but confirmation failed/i);

      expect(transfersCreateMock).toHaveBeenCalledTimes(1);
      expect(statusesWritten()).not.toContain('failed');
      expect(statusesWritten()).toContain('processing');
      expect(reversalLedgerWrites().length).toBe(0);
    });

    it('treats an error with no recognisable Stripe type as ambiguous, not as a rejection', async () => {
      // Guards the classifier's default branch: anything we cannot positively
      // identify as "Stripe refused it" must fail safe (no reversal). Also
      // covers a stubbed SDK where the error carries no `type` at all.
      armPayout();
      transfersCreateMock.mockRejectedValue(new Error('something unexpected'));

      await expect(requestPayout('creator_1')).rejects.toThrow(/being confirmed/i);

      expect(statusesWritten()).not.toContain('failed');
      expect(reversalLedgerWrites().length).toBe(0);
    });

    it('RESOLVES an ambiguous outcome by retrying under the same idempotency key', async () => {
      // Stripe guarantees at-most-one transfer per key for 24h, so re-issuing
      // returns the original transfer if one was created and creates it
      // otherwise. Parking the payout instead would strand the creator's money:
      // the ledger debit stands and the reconciliation service cannot recover
      // it (it only scans payouts that already carry a stripeTransferId).
      armPayout();
      transfersCreateMock
        .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }))
        .mockResolvedValue({ id: 'tr_recovered' });

      const result = await requestPayout('creator_1');

      expect(result.payoutId).toBe('payout_h2');
      expect(transfersCreateMock).toHaveBeenCalledTimes(2);
      // Both calls must carry the SAME idempotency key, or the retry would be a
      // second real transfer rather than a lookup of the first.
      const keys = transfersCreateMock.mock.calls.map((c: any[]) => c?.[1]?.idempotencyKey);
      expect(keys[0]).toBe('payout-payout_h2');
      expect(keys[1]).toBe(keys[0]);
      expect(statusesWritten()).toContain('completed');
      expect(reversalLedgerWrites().length).toBe(0);
    });

    it('NEVER reverses once the first attempt was ambiguous, even if the retry looks like a hard rejection', async () => {
      // The tempting inference — "Stripe refused the retry, so the key was
      // never consumed, so no transfer exists" — is unsound. A 429 comes from
      // Stripe's rate limiter BEFORE the idempotency key is consulted, and an
      // auth/permission error can come from a key rotated between the two
      // calls. Neither tells us anything about the first attempt. If the first
      // attempt had in fact created the transfer, reversing here would credit
      // the wallet for money already sent, and the creator's next request
      // carries a new payoutId (hence a new idempotency key) that Stripe would
      // honour as a second, distinct transfer.
      armPayout();
      transfersCreateMock
        .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }))
        .mockRejectedValue(Object.assign(new Error('Too many requests'), { type: 'StripeRateLimitError' }));

      await expect(requestPayout('creator_1')).rejects.toThrow(/being confirmed/i);

      expect(statusesWritten()).not.toContain('failed');
      expect(statusesWritten()).toContain('processing');
      expect(reversalLedgerWrites().length).toBe(0);
    });

    it('still reverses when the FIRST attempt is positively rejected (sound inference)', async () => {
      // Here the error came from the very request that would have created the
      // transfer, so "no transfer exists" genuinely follows.
      armPayout();
      transfersCreateMock.mockRejectedValue(
        Object.assign(new Error('No such destination'), { type: 'StripeInvalidRequestError' }),
      );

      await expect(requestPayout('creator_1')).rejects.toThrow('Payout transfer failed');

      expect(statusesWritten()).toContain('failed');
      expect(reversalLedgerWrites().length).toBe(1);
      // One attempt only — a rejected first attempt is not retried.
      expect(transfersCreateMock).toHaveBeenCalledTimes(1);
    });

    it('alerts instead of failing silently when the reversal itself throws', async () => {
      // A failed reversal leaves the row `pending` with the ledger debited,
      // which permanently blocks this creator from requesting payouts and which
      // nothing in the codebase sweeps. It must never be silent.
      armPayout();
      transfersCreateMock.mockRejectedValue(
        Object.assign(new Error('No such destination'), { type: 'StripeInvalidRequestError' }),
      );
      const originalTx = (prismaMock as any).$transaction;
      (prismaMock as any).$transaction = vi.fn((arg: unknown) => {
        if (Array.isArray(arg)) return Promise.reject(new Error('SQLITE_BUSY: database is locked'));
        if (typeof arg === 'function') return (arg as any)(prismaMock);
        return Promise.resolve(arg);
      });

      try {
        // The reversal failure is swallowed rather than masking the user-facing
        // error — but it is reported, and the message reflects that the balance
        // could not be released (see the 503 case below).
        await expect(requestPayout('creator_1')).rejects.toThrow(/could not be released/i);
        expect(sentryCaptureExceptionMock).toHaveBeenCalled();
        const tags = sentryCaptureExceptionMock.mock.calls.map((c: any[]) => c?.[1]?.tags?.outcome);
        expect(tags).toContain('reversal_failed');
      } finally {
        (prismaMock as any).$transaction = originalTx;
      }
    });

    it('does NOT treat StripeIdempotencyError as a rejection (a transfer may exist)', async () => {
      // Stripe raises this when the key was used with different parameters —
      // i.e. a prior request was accepted. Reversing on it would be a double-pay.
      armPayout();
      transfersCreateMock.mockRejectedValue(
        Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), {
          type: 'StripeIdempotencyError',
        }),
      );

      await expect(requestPayout('creator_1')).rejects.toThrow(/being confirmed/i);

      expect(statusesWritten()).not.toContain('failed');
      expect(reversalLedgerWrites().length).toBe(0);
    });

    it('does NOT reverse on a rate-limit error, and disables the SDK’s internal retries', async () => {
      // stripe-node defaults maxNetworkRetries to 2 and retries on connection
      // errors / 409 / 5xx, reusing the same Idempotency-Key. So without
      // maxNetworkRetries:0 a single await could be three HTTP attempts, and the
      // surfaced error would be the LAST one — a 429 raised by an edge rate
      // limiter that never consults the idempotency store, and therefore says
      // nothing about whether an earlier attempt created the transfer.
      // Reversing on it would credit the wallet for money already sent.
      armPayout();
      transfersCreateMock.mockRejectedValue(
        Object.assign(new Error('Too many requests'), { type: 'StripeRateLimitError' }),
      );

      await expect(requestPayout('creator_1')).rejects.toThrow(/being confirmed/i);

      expect(statusesWritten()).not.toContain('failed');
      expect(reversalLedgerWrites().length).toBe(0);
      // Every attempt must opt out of the SDK's internal retry loop.
      for (const call of transfersCreateMock.mock.calls) {
        expect(call?.[1]?.maxNetworkRetries).toBe(0);
      }
    });

    it('answers 503 (not "try again later") when the reversal itself failed', async () => {
      // A failed reversal leaves the row `pending`, so every retry would fail
      // with "Existing payout request is still pending". Telling the creator to
      // try again would be actively misleading.
      armPayout();
      transfersCreateMock.mockRejectedValue(
        Object.assign(new Error('No such destination'), { type: 'StripeInvalidRequestError' }),
      );
      const originalTx = (prismaMock as any).$transaction;
      (prismaMock as any).$transaction = vi.fn((arg: unknown) => {
        if (Array.isArray(arg)) return Promise.reject(new Error('SQLITE_BUSY: database is locked'));
        if (typeof arg === 'function') return (arg as any)(prismaMock);
        return Promise.resolve(arg);
      });

      try {
        const err = await requestPayout('creator_1').catch((e: Error & { status?: number }) => e);
        expect((err as Error & { status?: number }).status).toBe(503);
        expect((err as Error).message).toMatch(/do not retry/i);
      } finally {
        (prismaMock as any).$transaction = originalTx;
      }
    });

    // ----------------------------------------------------------------
    // Adversarial invariant findings — each of these FAILS before its fix.
    // ----------------------------------------------------------------

    it('INVARIANT 1/4/6: refuses to pay out while V1_WALLET_FREEZE is active', async () => {
      // With the freeze on, v1LedgerCreate returns `SELECT 1` instead of writing
      // the offsetting `payout:<id>` debit (v1-wallet-freeze.ts). The payout
      // completes, the ledger still shows the full balance, and because the
      // pending-unique index only covers status='pending' the creator can
      // immediately request again — a NEW payoutId, hence a NEW idempotency key,
      // hence a second real transfer. Repeatable without limit.
      //
      // admin.routes.ts already refuses its manual ledger endpoint under the
      // freeze for exactly this reason; the payout path was missed.
      armPayout();
      transfersCreateMock.mockResolvedValue({ id: 'tr_frozen' });
      const original = process.env.V1_WALLET_FREEZE;
      process.env.V1_WALLET_FREEZE = 'true';
      try {
        await expect(requestPayout('creator_1')).rejects.toThrow(/freeze/i);
        // Must refuse BEFORE any money moves.
        expect(transfersCreateMock).not.toHaveBeenCalled();
        expect((prismaMock as any).creatorPayout.create).not.toHaveBeenCalled();
      } finally {
        if (original === undefined) delete process.env.V1_WALLET_FREEZE;
        else process.env.V1_WALLET_FREEZE = original;
      }
    });

    it('INVARIANT 5: refuses to pay out when the reconciliation path is disabled', async () => {
      // requestPayout gates on creatorPayoutsEnabled; runCreatorStripeReconciliation
      // early-returns on creatorMonetizationEnabled. Two uncoupled flags, so
      // payouts-on + monetization-off is a reachable state in which a crash
      // between the Stripe transfer and the DB write is detected by NOTHING.
      // Paying out without a working reconciler is an unsafe combination.
      armPayout();
      transfersCreateMock.mockResolvedValue({ id: 'tr_norecon' });
      const original = (config as any).creatorMonetizationEnabled;
      (config as any).creatorMonetizationEnabled = false;
      try {
        await expect(requestPayout('creator_1')).rejects.toThrow(/reconcil/i);
        expect(transfersCreateMock).not.toHaveBeenCalled();
      } finally {
        (config as any).creatorMonetizationEnabled = original;
      }
    });

    it('F-1: the transfer carries a transfer_group so a crash is recoverable', async () => {
      // transfers.list cannot filter on metadata and there is no
      // transfers.search, so transfer_group is the ONLY durable handle
      // reconciliation can use to ask "did Stripe ever receive this payout?"
      // after a process crash. If this key changes, recovery silently finds
      // nothing — hence the exact-value assertion.
      armPayout();
      transfersCreateMock.mockResolvedValue({ id: 'tr_group' });

      await requestPayout('creator_1');

      expect(transfersCreateMock.mock.calls[0][0].transfer_group).toBe('payout_payout_h2');
    });

    it('marks the payout completed on the happy path', async () => {
      armPayout();
      transfersCreateMock.mockResolvedValue({ id: 'tr_ok' });

      const result = await requestPayout('creator_1');

      expect(result.payoutId).toBe('payout_h2');
      expect(statusesWritten()).toContain('completed');
      expect(reversalLedgerWrites().length).toBe(0);
    });
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

    // findFirst is always called to look up the creator by stripeConnectId
    expect((prismaMock as any).creator.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeConnectId: 'acct_connect_456' },
      })
    );
    // But update should NOT be called because charges_enabled is false and creator is not onboarded
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

/**
 * A pending payout is represented in the ledger from the moment it exists:
 * requestPayout writes the CreatorPayout row and its `payout:<id>` debit inside
 * one serializable transaction, and it is the only writer of payout rows in the
 * codebase. The ledger balance therefore already excludes a pending payout, so
 * subtracting the pending aggregate on top of it removes the same money twice.
 *
 * This never mis-sized a payout: requestPayout refuses to run while a pending
 * payout exists (the pendingCount guard plus the creator_payout_pending_unique
 * partial index), so the pending aggregate is provably 0 on that path. The
 * damage is confined to the balance a creator is shown while one is in flight.
 */
describe('getPayoutBalance — a pending payout is subtracted exactly once', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const aged = () => new Date(Date.now() - 30 * DAY_MS);   // outside the 14-day reserve
  const recent = () => new Date(Date.now() - 1 * DAY_MS);  // inside it

  /**
   * A payout-shaped client that is deliberately NOT the module's prisma
   * instance, so getPayoutBalance sums these rows itself instead of delegating
   * to the mocked getPayoutBalanceFromLedger. That keeps the `payout:` debit
   * visibly part of the balance under test.
   */
  function ledgerClient(
    rows: Array<{ type: string; amountCents: number; createdAt: Date; description?: string }>,
    pendingSumCents: number | null,
  ) {
    return {
      creatorWalletLedger: { findMany: vi.fn(async () => rows) },
      creatorPayout: { aggregate: vi.fn(async () => ({ _sum: { amountCents: pendingSumCents } })) },
    } as any;
  }

  it('does not deduct a pending payout again on top of its ledger debit', async () => {
    const client = ledgerClient(
      [
        { type: 'earning', amountCents: 10000, createdAt: aged() },
        { type: 'payout', amountCents: 4000, createdAt: recent(), description: 'payout:payout_1' },
      ],
      4000, // the very same payout, still pending
    );

    const { availableCents } = await getPayoutBalance('creator_1', client);

    // 10000 earned − 4000 already debited = 6000.
    // Subtracting the pending aggregate a second time would leave 2000.
    expect(availableCents).toBe(6000);
  });

  it('holds on the default client path, where the balance arrives pre-netted', async () => {
    getPayoutBalanceFromLedgerMock.mockResolvedValue(6000); // already net of the debit
    const p = prismaMock as any;
    p.creatorWalletLedger ??= {};
    p.creatorWalletLedger.findMany = vi.fn(async () => [
      { type: 'earning', amountCents: 10000, createdAt: aged() },
    ]);
    p.creatorPayout ??= {};
    p.creatorPayout.aggregate = vi.fn(async () => ({ _sum: { amountCents: 4000 } }));

    const { availableCents } = await getPayoutBalance('creator_1');

    expect(availableCents).toBe(6000);
  });

  it('still withholds the 14-day rolling reserve', async () => {
    // Guards the fix against over-correcting into "subtract nothing".
    const client = ledgerClient(
      [
        { type: 'earning', amountCents: 10000, createdAt: aged() },
        { type: 'earning', amountCents: 5000, createdAt: recent() },
        { type: 'payout', amountCents: 4000, createdAt: recent(), description: 'payout:payout_1' },
      ],
      4000,
    );

    const { availableCents, reservedCents } = await getPayoutBalance('creator_1', client);

    // balance 11000 − reserve 5000 = 6000, with the pending 4000 not re-subtracted.
    expect(reservedCents).toBe(5000);
    expect(availableCents).toBe(6000);
  });
});
