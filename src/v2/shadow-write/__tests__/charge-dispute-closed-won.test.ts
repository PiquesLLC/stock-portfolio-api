// Unit tests for the v2 shadow-write of charge.dispute.closed (won) events.
// Mirror of charge-dispute-created.test.ts in the restoring direction.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapV1GroupToV2Event, type V1LedgerRow } from '../../migration/v1-to-v2-mapper';

const postTransactionMock = vi.hoisted(() => vi.fn());

vi.mock('../../ledger', () => ({
  postTransaction: postTransactionMock,
}));

import { shadowWriteChargeDisputeClosedWon } from '../charge-dispute-closed-won';

const baseArgs = {
  stripeEventId: 'evt_won_123',
  stripeChargeId: 'ch_won_456',
  creatorUserId: '11111111-1111-4111-8111-111111111111',
  feeReversalCents: 1500,
  creatorRestoreCents: 800,
  platformRestoreCents: 200,
  effectiveAt: new Date('2026-05-28T12:00:00Z'),
};

describe('shadowWriteChargeDisputeClosedWon gating', () => {
  beforeEach(() => {
    postTransactionMock.mockReset();
    postTransactionMock.mockResolvedValue({ eventGroupId: 'x', entries: [], deduplicated: false });
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('is a no-op when env not set', async () => {
    await shadowWriteChargeDisputeClosedWon(baseArgs);
    expect(postTransactionMock).not.toHaveBeenCalled();
  });

  it('calls postTransaction when env="true"', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWriteChargeDisputeClosedWon(baseArgs);
    expect(postTransactionMock).toHaveBeenCalledOnce();
  });
});

describe('shadowWriteChargeDisputeClosedWon payload shape', () => {
  beforeEach(() => {
    postTransactionMock.mockReset();
    postTransactionMock.mockResolvedValue({ eventGroupId: 'x', entries: [], deduplicated: false });
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('produces a balanced 3-entry group when all components present', async () => {
    await shadowWriteChargeDisputeClosedWon(baseArgs);
    const input = postTransactionMock.mock.calls[0][0];
    expect(input.entries).toHaveLength(3);
    const totalDebit = input.entries.reduce(
      (s: bigint, e: { debitMinorUnits: bigint }) => s + e.debitMinorUnits,
      0n,
    );
    const totalCredit = input.entries.reduce(
      (s: bigint, e: { creditMinorUnits: bigint }) => s + e.creditMinorUnits,
      0n,
    );
    expect(totalDebit).toBe(totalCredit);
    // stripe_clearing debit = fee + creator + platform = 2500
    expect(totalDebit).toBe(2500n);
  });

  it('omits platform entry when platformRestoreCents is zero', async () => {
    await shadowWriteChargeDisputeClosedWon({ ...baseArgs, platformRestoreCents: 0 });
    const input = postTransactionMock.mock.calls[0][0];
    expect(input.entries).toHaveLength(2);
  });

  it('uses RESTORE_AFTER_DISPUTE_WON + restore suffixes', async () => {
    await shadowWriteChargeDisputeClosedWon(baseArgs);
    const input = postTransactionMock.mock.calls[0][0];
    for (const e of input.entries) {
      expect(e.eventType).toBe('RESTORE_AFTER_DISPUTE_WON');
    }
    const suffixes = input.entries.map((e: { idempotencySuffix: string }) => e.idempotencySuffix);
    expect(suffixes).toContain('stripe_clearing');
    expect(suffixes).toContain('creator_restore');
    expect(suffixes).toContain('platform_restore');
  });

  it('uses webhook:charge.dispute.closed postedBy', async () => {
    await shadowWriteChargeDisputeClosedWon(baseArgs);
    expect(postTransactionMock.mock.calls[0][0].postedBy).toBe('webhook:charge.dispute.closed');
  });
});

describe('shadowWriteChargeDisputeClosedWon failure isolation', () => {
  beforeEach(() => {
    postTransactionMock.mockReset();
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('swallows postTransaction errors', async () => {
    postTransactionMock.mockRejectedValueOnce(new Error('Postgres down'));
    await expect(shadowWriteChargeDisputeClosedWon(baseArgs)).resolves.toBeUndefined();
  });
});

describe('CONVERGENCE TEST: shadow-write matches MIG-1 G4 mapper', () => {
  beforeEach(() => {
    postTransactionMock.mockReset();
    postTransactionMock.mockResolvedValue({ eventGroupId: 'x', entries: [], deduplicated: false });
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  function makeV1Row(overrides: Partial<V1LedgerRow>): V1LedgerRow {
    return {
      id: 'row_' + Math.random().toString(36).slice(2, 10),
      creatorUserId: baseArgs.creatorUserId,
      type: 'earning',
      amountCents: 0,
      subscriptionId: null,
      description: 'placeholder',
      createdAt: new Date(),
      ...overrides,
    };
  }

  it('INTENT fields match between writers (3-entry case)', async () => {
    await shadowWriteChargeDisputeClosedWon(baseArgs);
    const shadowInput = postTransactionMock.mock.calls[0][0];

    const v1Rows = [
      makeV1Row({
        type: 'earning',
        amountCents: baseArgs.feeReversalCents,
        description: `stripe_event:${baseArgs.stripeEventId}:dispute_fee_reversal`,
      }),
      makeV1Row({
        type: 'earning',
        amountCents: baseArgs.creatorRestoreCents,
        description: `stripe_event:${baseArgs.stripeEventId}:charge:${baseArgs.stripeChargeId}:dispute_won_restore_creator`,
      }),
      makeV1Row({
        type: 'platform_fee',
        amountCents: baseArgs.platformRestoreCents,
        description: `stripe_event:${baseArgs.stripeEventId}:charge:${baseArgs.stripeChargeId}:dispute_won_restore_platform`,
      }),
    ];
    const mig1Out = mapV1GroupToV2Event(`stripe_event:${baseArgs.stripeEventId}`, v1Rows);
    if (mig1Out.kind !== 'mapped') throw new Error('expected mapped');

    const sortByScope = (
      a: { accountScope: string; idempotencySuffix: string },
      b: { accountScope: string; idempotencySuffix: string },
    ) =>
      a.accountScope.localeCompare(b.accountScope) ||
      a.idempotencySuffix.localeCompare(b.idempotencySuffix);
    const shadowSorted = [...shadowInput.entries].sort(sortByScope);
    const mig1Sorted = [...mig1Out.event.entries].sort(sortByScope);
    expect(shadowSorted).toHaveLength(mig1Sorted.length);

    for (let i = 0; i < shadowSorted.length; i++) {
      const s = shadowSorted[i];
      const m = mig1Sorted[i];
      expect(s.accountScope).toBe(m.accountScope);
      expect(s.accountId).toBe(m.accountId);
      expect(s.eventType).toBe(m.eventType);
      expect(s.debitMinorUnits).toBe(m.debitMinorUnits);
      expect(s.creditMinorUnits).toBe(m.creditMinorUnits);
      expect(s.currency).toBe(m.currency);
      expect(s.idempotencySuffix).toBe(m.idempotencySuffix);
    }
  });

  it('INTENT fields match for the fee-reversal-only case', async () => {
    // Reviewer-flagged gap: 2-entry-path regressions (wrong event_type,
    // flipped debit/credit, suffix drift) would have slipped past the
    // length-only check. Per-entry intent comparison locks the contract.
    await shadowWriteChargeDisputeClosedWon({
      ...baseArgs,
      creatorRestoreCents: 0,
      platformRestoreCents: 0,
    });
    const shadowInput = postTransactionMock.mock.calls[0][0];

    const v1Rows = [
      makeV1Row({
        type: 'earning',
        amountCents: baseArgs.feeReversalCents,
        description: `stripe_event:${baseArgs.stripeEventId}:dispute_fee_reversal`,
      }),
    ];
    const mig1Out = mapV1GroupToV2Event(`stripe_event:${baseArgs.stripeEventId}`, v1Rows);
    if (mig1Out.kind !== 'mapped') throw new Error('expected mapped');

    expect(shadowInput.entries).toHaveLength(mig1Out.event.entries.length);
    expect(shadowInput.entries).toHaveLength(2);

    const sortByScope = (
      a: { accountScope: string; idempotencySuffix: string },
      b: { accountScope: string; idempotencySuffix: string },
    ) =>
      a.accountScope.localeCompare(b.accountScope) ||
      a.idempotencySuffix.localeCompare(b.idempotencySuffix);
    const shadowSorted = [...shadowInput.entries].sort(sortByScope);
    const mig1Sorted = [...mig1Out.event.entries].sort(sortByScope);

    for (let i = 0; i < shadowSorted.length; i++) {
      const s = shadowSorted[i];
      const m = mig1Sorted[i];
      expect(s.accountScope).toBe(m.accountScope);
      expect(s.accountId).toBe(m.accountId);
      expect(s.eventType).toBe(m.eventType);
      expect(s.debitMinorUnits).toBe(m.debitMinorUnits);
      expect(s.creditMinorUnits).toBe(m.creditMinorUnits);
      expect(s.currency).toBe(m.currency);
      expect(s.idempotencySuffix).toBe(m.idempotencySuffix);
    }
  });
});
