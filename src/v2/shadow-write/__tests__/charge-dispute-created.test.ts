// Unit tests for the v2 shadow-write of charge.dispute.created events.
//
// Includes a CONVERGENCE TEST that asserts shadow-write's payload INTENT
// fields match the MIG-1 G3 mapper's output for the same source event.
// Any drift between the two writers would throw CRITICAL in production.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapV1GroupToV2Event, type V1LedgerRow } from '../../migration/v1-to-v2-mapper';

const postTransactionMock = vi.hoisted(() => vi.fn());

vi.mock('../../ledger', () => ({
  postTransaction: postTransactionMock,
}));

import { shadowWriteChargeDisputeCreated } from '../charge-dispute-created';

const baseArgs = {
  stripeEventId: 'evt_dispute_123',
  stripeChargeId: 'ch_disputed_456',
  creatorUserId: '11111111-1111-4111-8111-111111111111',
  feeAmountCents: 1500,
  creatorClawbackCents: 800,
  platformClawbackCents: 200,
  effectiveAt: new Date('2026-05-28T12:00:00Z'),
};

describe('shadowWriteChargeDisputeCreated gating', () => {
  beforeEach(() => {
    postTransactionMock.mockReset();
    postTransactionMock.mockResolvedValue({ eventGroupId: 'x', entries: [], deduplicated: false });
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('is a no-op when env not set', async () => {
    await shadowWriteChargeDisputeCreated(baseArgs);
    expect(postTransactionMock).not.toHaveBeenCalled();
  });

  it('calls postTransaction when env="true"', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWriteChargeDisputeCreated(baseArgs);
    expect(postTransactionMock).toHaveBeenCalledOnce();
  });

  it('skips when feeAmountCents <= 0 (defensive)', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWriteChargeDisputeCreated({ ...baseArgs, feeAmountCents: 0 });
    expect(postTransactionMock).not.toHaveBeenCalled();
  });
});

describe('shadowWriteChargeDisputeCreated payload shape', () => {
  beforeEach(() => {
    postTransactionMock.mockReset();
    postTransactionMock.mockResolvedValue({ eventGroupId: 'x', entries: [], deduplicated: false });
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('produces a balanced 3-entry group when all components present', async () => {
    await shadowWriteChargeDisputeCreated(baseArgs);
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
    // stripe_clearing credit = fee + creator_clawback + platform_clawback = 2500
    expect(totalCredit).toBe(2500n);
  });

  it('omits platform entry when platformClawbackCents is zero (2-entry group)', async () => {
    await shadowWriteChargeDisputeCreated({ ...baseArgs, platformClawbackCents: 0 });
    const input = postTransactionMock.mock.calls[0][0];
    expect(input.entries).toHaveLength(2);
  });

  it('produces 2-entry group when creator clawback is also zero (fee only)', async () => {
    await shadowWriteChargeDisputeCreated({
      ...baseArgs,
      creatorClawbackCents: 0,
      platformClawbackCents: 0,
    });
    const input = postTransactionMock.mock.calls[0][0];
    expect(input.entries).toHaveLength(2);
    // creator debit equals just the fee
    const creator = input.entries.find((e: { accountScope: string }) => e.accountScope === 'creator');
    expect(creator!.debitMinorUnits).toBe(1500n);
  });

  it('uses DISPUTE_LOST event type and clawback idempotency suffixes', async () => {
    await shadowWriteChargeDisputeCreated(baseArgs);
    const input = postTransactionMock.mock.calls[0][0];
    for (const e of input.entries) {
      expect(e.eventType).toBe('DISPUTE_LOST');
    }
    const suffixes = input.entries.map((e: { idempotencySuffix: string }) => e.idempotencySuffix);
    expect(suffixes).toContain('stripe_clearing');
    expect(suffixes).toContain('creator_clawback');
    expect(suffixes).toContain('platform_clawback');
  });

  it('includes component breakdown in metadata', async () => {
    await shadowWriteChargeDisputeCreated(baseArgs);
    const input = postTransactionMock.mock.calls[0][0];
    for (const e of input.entries) {
      expect(e.metadata).toMatchObject({
        dispute_fee_cents: 1500,
        creator_clawback_cents: 800,
        platform_clawback_cents: 200,
      });
    }
  });

  it('uses webhook:charge.dispute.created postedBy', async () => {
    await shadowWriteChargeDisputeCreated(baseArgs);
    expect(postTransactionMock.mock.calls[0][0].postedBy).toBe('webhook:charge.dispute.created');
  });
});

describe('shadowWriteChargeDisputeCreated failure isolation', () => {
  beforeEach(() => {
    postTransactionMock.mockReset();
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('swallows postTransaction errors — caller unaffected', async () => {
    postTransactionMock.mockRejectedValueOnce(new Error('Postgres down'));
    await expect(shadowWriteChargeDisputeCreated(baseArgs)).resolves.toBeUndefined();
  });
});

describe('CONVERGENCE TEST: shadow-write payload matches MIG-1 G3 mapper for the same event', () => {
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
      type: 'refund',
      amountCents: 0,
      subscriptionId: null,
      description: 'placeholder',
      createdAt: new Date(),
      ...overrides,
    };
  }

  it('eventGroupId matches between writers', async () => {
    await shadowWriteChargeDisputeCreated(baseArgs);
    const shadowEventGroupId = postTransactionMock.mock.calls[0][0].eventGroupId;

    const v1Rows = [
      makeV1Row({
        type: 'refund',
        amountCents: -baseArgs.feeAmountCents,
        description: `stripe_event:${baseArgs.stripeEventId}:dispute_fee:fraudulent`,
      }),
      makeV1Row({
        type: 'refund',
        amountCents: -baseArgs.creatorClawbackCents,
        description: `stripe_event:${baseArgs.stripeEventId}:charge:${baseArgs.stripeChargeId}:dispute_clawback_creator`,
      }),
      makeV1Row({
        type: 'platform_fee',
        amountCents: -baseArgs.platformClawbackCents,
        description: `stripe_event:${baseArgs.stripeEventId}:charge:${baseArgs.stripeChargeId}:dispute_clawback_platform`,
      }),
    ];
    const mig1Out = mapV1GroupToV2Event(`stripe_event:${baseArgs.stripeEventId}`, v1Rows);
    if (mig1Out.kind !== 'mapped') throw new Error('expected mapped');
    expect(shadowEventGroupId).toBe(mig1Out.event.eventGroupId);
  });

  it('INTENT fields match between writers (3-entry case)', async () => {
    await shadowWriteChargeDisputeCreated(baseArgs);
    const shadowInput = postTransactionMock.mock.calls[0][0];

    const v1Rows = [
      makeV1Row({
        type: 'refund',
        amountCents: -baseArgs.feeAmountCents,
        description: `stripe_event:${baseArgs.stripeEventId}:dispute_fee:fraudulent`,
      }),
      makeV1Row({
        type: 'refund',
        amountCents: -baseArgs.creatorClawbackCents,
        description: `stripe_event:${baseArgs.stripeEventId}:charge:${baseArgs.stripeChargeId}:dispute_clawback_creator`,
      }),
      makeV1Row({
        type: 'platform_fee',
        amountCents: -baseArgs.platformClawbackCents,
        description: `stripe_event:${baseArgs.stripeEventId}:charge:${baseArgs.stripeChargeId}:dispute_clawback_platform`,
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

  it('entry counts match for the fee-only case (no clawback rows)', async () => {
    await shadowWriteChargeDisputeCreated({
      ...baseArgs,
      creatorClawbackCents: 0,
      platformClawbackCents: 0,
    });
    const shadowInput = postTransactionMock.mock.calls[0][0];

    const v1Rows = [
      makeV1Row({
        type: 'refund',
        amountCents: -baseArgs.feeAmountCents,
        description: `stripe_event:${baseArgs.stripeEventId}:dispute_fee:fraudulent`,
      }),
    ];
    const mig1Out = mapV1GroupToV2Event(`stripe_event:${baseArgs.stripeEventId}`, v1Rows);
    if (mig1Out.kind !== 'mapped') throw new Error('expected mapped');

    expect(shadowInput.entries).toHaveLength(mig1Out.event.entries.length);
    expect(shadowInput.entries).toHaveLength(2);
  });
});
