import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

/**
 * F-1 — recovery of payouts stranded by a process crash.
 *
 * requestPayout commits the payout row (status 'pending') and its
 * `payout:<id>` ledger debit in one transaction, THEN calls Stripe. If the
 * process dies in that window the resting state is:
 *
 *     status = 'pending', stripeTransferId = null, ledger debited, no transfer
 *
 * Nothing detected it. The existing scan only loads rows WHERE
 * stripeTransferId IS NOT NULL, and the ghost-transfer scan needs a Stripe-side
 * transfer that was never created. No catch block ran, so no alert fired. And
 * the pending row blocks every future payout for that creator through the
 * partial unique index.
 *
 * Recovery belongs here rather than in requestPayout: the payout path itself
 * has converged and should not be redesigned again.
 */

const { transfersListMock, balanceTxListMock } = vi.hoisted(() => ({
  transfersListMock: vi.fn(),
  balanceTxListMock: vi.fn(),
}));

vi.mock('stripe', () => {
  class StripeMock {
    transfers = { list: transfersListMock };
    balanceTransactions = { list: balanceTxListMock };
    constructor(_k: string) {}
  }
  return { default: StripeMock };
});

vi.mock('../config', () => ({
  config: {
    stripeSecretKey: 'sk_test_123',
    creatorMonetizationEnabled: true,
  },
}));

import { runCreatorStripeReconciliation } from '../services/creator-stripe-reconciliation.service';

const HOUR = 60 * 60 * 1000;

/** An async-iterable list result, matching how the window scan consumes it. */
function asIterable(items: unknown[]) {
  return { [Symbol.asyncIterator]: async function* () { for (const i of items) yield i; }, data: items };
}

function strandedPayout(over: Record<string, unknown> = {}) {
  return {
    id: 'payout_stranded',
    creatorUserId: 'creator_1',
    amountCents: 100000,
    status: 'pending',
    stripeTransferId: null,
    createdAt: new Date(Date.now() - 6 * HOUR), // aged well past the threshold
    ...over,
  };
}

/** Route findMany by its where-clause so scan order cannot make tests brittle. */
function arm(opts: { stranded?: unknown[]; stripeTransfers?: unknown[] } = {}) {
  const p = prismaMock as any;
  p.creatorPayout ??= {};
  p.creatorPayout.findMany = vi.fn(async ({ where }: any) => {
    if (where?.stripeTransferId === null) return opts.stranded ?? [];
    return []; // the existing stripeTransferId-NOT-NULL scan
  });
  p.creatorPayout.update ??= vi.fn();
  p.creatorPayout.update.mockResolvedValue({});
  p.creatorWalletLedger ??= {};
  p.creatorWalletLedger.create ??= vi.fn();
  p.creatorWalletLedger.create.mockResolvedValue({});
  p.creatorWalletLedger.findMany ??= vi.fn();
  p.creatorWalletLedger.findMany.mockResolvedValue([]);
  p.creator ??= {};
  p.creator.findUnique ??= vi.fn();
  p.creator.findUnique.mockResolvedValue({ stripeConnectId: 'acct_1' });
  p.monitoringReport ??= {};
  p.monitoringReport.create ??= vi.fn();
  p.monitoringReport.create.mockResolvedValue({});
  p.$transaction = vi.fn((arg: unknown) => {
    if (typeof arg === 'function') return (arg as any)(prismaMock);
    if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
    return Promise.resolve(arg);
  });

  // Window scan yields nothing unless a test says otherwise; a transfer_group
  // lookup resolves to whatever that test seeded.
  transfersListMock.mockImplementation((params: any) =>
    params?.transfer_group
      ? Promise.resolve(asIterable(opts.stripeTransfers ?? []))
      : asIterable([]),
  );
  balanceTxListMock.mockImplementation(() => asIterable([]));
}

/** Every ledger credit written with a payout_reversal description. */
function reversalCredits() {
  return (prismaMock as any).creatorWalletLedger.create.mock.calls
    .filter((c: any[]) => String(c?.[0]?.data?.description ?? '').startsWith('payout_reversal:'));
}
function payoutStatusWrites() {
  return (prismaMock as any).creatorPayout.update.mock.calls.map((c: any[]) => c?.[0]?.data?.status);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('F-1 stranded pending payout recovery', () => {
  it('RELEASES an aged pending payout that Stripe never received', async () => {
    // Stripe proves no transfer exists for this payout's transfer_group, so the
    // creator's balance must be given back and the pending slot freed.
    arm({ stranded: [strandedPayout()], stripeTransfers: [] });

    await runCreatorStripeReconciliation();

    expect(payoutStatusWrites()).toContain('failed');
    expect(reversalCredits()).toHaveLength(1);
    expect(reversalCredits()[0][0].data.amountCents).toBe(100000);
  });

  it('ADOPTS the transfer when Stripe proves one exists, and never credits', async () => {
    // The crash happened AFTER Stripe accepted. Money moved: record the id and
    // complete it. Crediting here would be a double-pay.
    arm({
      stranded: [strandedPayout()],
      stripeTransfers: [{ id: 'tr_found', amount: 100000, reversed: false }],
    });

    await runCreatorStripeReconciliation();

    const updates = (prismaMock as any).creatorPayout.update.mock.calls.map((c: any[]) => c[0].data);
    expect(updates.some((d: any) => d.stripeTransferId === 'tr_found' && d.status === 'completed')).toBe(true);
    expect(reversalCredits()).toHaveLength(0);
  });

  it('leaves an AMBIGUOUS lookup pending, credits nothing, issues nothing', async () => {
    arm({ stranded: [strandedPayout()] });
    transfersListMock.mockImplementation((params: any) => {
      if (params?.transfer_group) return Promise.reject(new Error('stripe unavailable'));
      return asIterable([]);
    });

    await runCreatorStripeReconciliation();

    // Must not release (that would be a guess) and must not complete.
    expect(payoutStatusWrites()).not.toContain('failed');
    expect(payoutStatusWrites()).not.toContain('completed');
    expect(reversalCredits()).toHaveLength(0);
  });

  it('does NOT touch a recently-created pending payout', async () => {
    // Still in flight in a live request — reconciliation must not race it.
    arm({ stranded: [] });
    const p = prismaMock as any;
    p.creatorPayout.findMany = vi.fn(async ({ where }: any) => {
      if (where?.stripeTransferId === null) {
        // The age filter is the service's job; assert it asks for one.
        expect(where.createdAt).toBeDefined();
        return [];
      }
      return [];
    });

    await runCreatorStripeReconciliation();

    expect(payoutStatusWrites()).toHaveLength(0);
    expect(reversalCredits()).toHaveLength(0);
  });

  it('preserves the pending-uniqueness guard: a released payout frees the slot', async () => {
    // Releasing to 'failed' (not deleting) is what frees the partial unique
    // index slot while keeping the audit row.
    arm({ stranded: [strandedPayout()], stripeTransfers: [] });

    await runCreatorStripeReconciliation();

    const updates = (prismaMock as any).creatorPayout.update.mock.calls.map((c: any[]) => c[0]);
    const release = updates.find((u: any) => u.data.status === 'failed');
    expect(release).toBeDefined();
    expect(release.where).toMatchObject({ id: 'payout_stranded' });
  });
});
