// Unit tests for the v2 shadow-write of charge.refunded events.
//
// Mirrors the structure of invoice-paid.test.ts. Adds an explicit
// CONVERGENCE TEST that compares shadow-write's payload against the
// MIG-1 G2 mapper's output for the same source event — these MUST
// produce identical INTENT fields (account, eventType, amounts,
// currency, idempotencySuffix) or post-transaction's divergence check
// will throw CRITICAL on cross-writer dedup.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapV1GroupToV2Event, type V1LedgerRow } from '../../migration/v1-to-v2-mapper';

const postTransactionMock = vi.hoisted(() => vi.fn());

vi.mock('../../ledger', () => ({
  postTransaction: postTransactionMock,
}));

import { shadowWriteChargeRefunded } from '../charge-refunded';

const baseArgs = {
  stripeEventId: 'evt_refund_123',
  stripeChargeId: 'ch_refund_456',
  creatorUserId: '11111111-1111-4111-8111-111111111111',
  incrementalCreatorCents: 800,
  incrementalPlatformCents: 200,
  effectiveAt: new Date('2026-05-28T12:00:00Z'),
};

describe('shadowWriteChargeRefunded gating', () => {
  beforeEach(() => {
    postTransactionMock.mockReset();
    postTransactionMock.mockResolvedValue({ eventGroupId: 'x', entries: [], deduplicated: false });
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('is a no-op when env not set', async () => {
    await shadowWriteChargeRefunded(baseArgs);
    expect(postTransactionMock).not.toHaveBeenCalled();
  });

  it('calls postTransaction when env="true"', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWriteChargeRefunded(baseArgs);
    expect(postTransactionMock).toHaveBeenCalledOnce();
  });

  it('skips zero/negative creator increment (v1 already accounted for it)', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWriteChargeRefunded({ ...baseArgs, incrementalCreatorCents: 0 });
    expect(postTransactionMock).not.toHaveBeenCalled();
  });
});

describe('shadowWriteChargeRefunded payload shape', () => {
  beforeEach(() => {
    postTransactionMock.mockReset();
    postTransactionMock.mockResolvedValue({ eventGroupId: 'x', entries: [], deduplicated: false });
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('produces a balanced 3-entry event group', async () => {
    await shadowWriteChargeRefunded(baseArgs);
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
    expect(totalDebit).toBe(1000n);
  });

  it('omits platform entry when incremental platform is zero (2-entry refund)', async () => {
    await shadowWriteChargeRefunded({ ...baseArgs, incrementalPlatformCents: 0 });
    const input = postTransactionMock.mock.calls[0][0];
    expect(input.entries).toHaveLength(2);
    const totalDebit = input.entries.reduce(
      (s: bigint, e: { debitMinorUnits: bigint }) => s + e.debitMinorUnits,
      0n,
    );
    const totalCredit = input.entries.reduce(
      (s: bigint, e: { creditMinorUnits: bigint }) => s + e.creditMinorUnits,
      0n,
    );
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(800n);
  });

  it('uses webhook:charge.refunded postedBy', async () => {
    await shadowWriteChargeRefunded(baseArgs);
    expect(postTransactionMock.mock.calls[0][0].postedBy).toBe('webhook:charge.refunded');
  });

  it('produces deterministic eventGroupId from stripeEventId', async () => {
    await shadowWriteChargeRefunded(baseArgs);
    const id1 = postTransactionMock.mock.calls[0][0].eventGroupId;
    postTransactionMock.mockClear();
    await shadowWriteChargeRefunded(baseArgs);
    const id2 = postTransactionMock.mock.calls[0][0].eventGroupId;
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('uses idempotencySuffix scheme matching MIG-1 G2', async () => {
    await shadowWriteChargeRefunded(baseArgs);
    const input = postTransactionMock.mock.calls[0][0];
    const suffixes = input.entries.map((e: { idempotencySuffix: string }) => e.idempotencySuffix);
    expect(suffixes).toContain('stripe_clearing');
    expect(suffixes).toContain('creator_refund');
    expect(suffixes).toContain('platform_refund');
  });

  it('uses mixed event_types matching MIG-1 G2', async () => {
    await shadowWriteChargeRefunded(baseArgs);
    const input = postTransactionMock.mock.calls[0][0];
    const clearing = input.entries.find((e: { accountScope: string }) => e.accountScope === 'stripe_clearing');
    const creator = input.entries.find((e: { accountScope: string }) => e.accountScope === 'creator');
    const platformRev = input.entries.find((e: { accountScope: string }) => e.accountScope === 'platform_revenue');
    expect(clearing!.eventType).toBe('EARNING_REFUNDED');
    expect(creator!.eventType).toBe('EARNING_REFUNDED');
    expect(platformRev!.eventType).toBe('PLATFORM_FEE_REFUNDED');
  });

  it('clamps backdated effectiveAt to within the 730-day past-window', async () => {
    const farPast = new Date('2022-01-01T00:00:00Z');
    await shadowWriteChargeRefunded({ ...baseArgs, effectiveAt: farPast });
    const input = postTransactionMock.mock.calls[0][0];
    const minAllowed = Date.now() - 730 * 24 * 60 * 60 * 1000;
    expect(input.effectiveAt.getTime()).toBeGreaterThan(minAllowed);
  });

  it('tags every entry with metadata.source for divergence-check filtering', async () => {
    await shadowWriteChargeRefunded(baseArgs);
    const input = postTransactionMock.mock.calls[0][0];
    for (const e of input.entries) {
      expect(e.metadata).toEqual({ source: 'v2-shadow-write' });
    }
  });
});

describe('shadowWriteChargeRefunded failure isolation', () => {
  beforeEach(() => {
    postTransactionMock.mockReset();
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('swallows postTransaction errors — caller unaffected', async () => {
    postTransactionMock.mockRejectedValueOnce(new Error('Postgres connection refused'));
    await expect(shadowWriteChargeRefunded(baseArgs)).resolves.toBeUndefined();
  });
});

describe('CONVERGENCE TEST: shadow-write payload matches MIG-1 G2 mapper for the same event', () => {
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
      amountCents: -800,
      subscriptionId: null,
      description: 'placeholder',
      createdAt: new Date(),
      ...overrides,
    };
  }

  it('eventGroupId matches between writers for the same stripeEventId', async () => {
    // Shadow-write path
    await shadowWriteChargeRefunded(baseArgs);
    const shadowEventGroupId = postTransactionMock.mock.calls[0][0].eventGroupId;

    // MIG-1 path
    const v1Rows = [
      makeV1Row({
        type: 'refund',
        amountCents: -baseArgs.incrementalCreatorCents,
        description: `stripe_event:${baseArgs.stripeEventId}:charge:${baseArgs.stripeChargeId}:refund_creator`,
      }),
      makeV1Row({
        type: 'platform_fee',
        amountCents: -baseArgs.incrementalPlatformCents,
        description: `stripe_event:${baseArgs.stripeEventId}:charge:${baseArgs.stripeChargeId}:refund_platform`,
      }),
    ];
    const groupKey = `stripe_event:${baseArgs.stripeEventId}`;
    const mig1Out = mapV1GroupToV2Event(groupKey, v1Rows);
    if (mig1Out.kind !== 'mapped') throw new Error('expected mig-1 mapped');
    const mig1EventGroupId = mig1Out.event.eventGroupId;

    expect(shadowEventGroupId).toBe(mig1EventGroupId);
  });

  it('emits same entry COUNT for the zero-platform case (regression: critical bug found in blind review)', async () => {
    // BUG: MIG-1 G2 previously always emitted 3 entries; shadow-write
    // emits 2 when platformDebit === 0. When both writers crossed paths
    // for a zero-platform refund, postTransaction would throw
    // CRITICAL: dedup intent divergence due to entry-count mismatch.
    await shadowWriteChargeRefunded({ ...baseArgs, incrementalPlatformCents: 0 });
    const shadowInput = postTransactionMock.mock.calls[0][0];

    const v1Rows = [
      makeV1Row({
        type: 'refund',
        amountCents: -baseArgs.incrementalCreatorCents,
        description: `stripe_event:${baseArgs.stripeEventId}:charge:${baseArgs.stripeChargeId}:refund_creator`,
      }),
      makeV1Row({
        type: 'platform_fee',
        amountCents: 0, // zero platform refund
        description: `stripe_event:${baseArgs.stripeEventId}:charge:${baseArgs.stripeChargeId}:refund_platform`,
      }),
    ];
    const mig1Out = mapV1GroupToV2Event(`stripe_event:${baseArgs.stripeEventId}`, v1Rows);
    if (mig1Out.kind !== 'mapped') throw new Error('expected mapped');

    expect(shadowInput.entries).toHaveLength(mig1Out.event.entries.length);
    expect(shadowInput.entries).toHaveLength(2); // both must agree on 2
  });

  it('INTENT fields (account, eventType, amounts, currency, idempotencySuffix) match between writers', async () => {
    await shadowWriteChargeRefunded(baseArgs);
    const shadowInput = postTransactionMock.mock.calls[0][0];

    const v1Rows = [
      makeV1Row({
        type: 'refund',
        amountCents: -baseArgs.incrementalCreatorCents,
        description: `stripe_event:${baseArgs.stripeEventId}:charge:${baseArgs.stripeChargeId}:refund_creator`,
      }),
      makeV1Row({
        type: 'platform_fee',
        amountCents: -baseArgs.incrementalPlatformCents,
        description: `stripe_event:${baseArgs.stripeEventId}:charge:${baseArgs.stripeChargeId}:refund_platform`,
      }),
    ];
    const mig1Out = mapV1GroupToV2Event(`stripe_event:${baseArgs.stripeEventId}`, v1Rows);
    if (mig1Out.kind !== 'mapped') throw new Error('expected mapped');

    // Compare entry-by-entry, sorted by accountScope for stable ordering.
    const sortByScope = (
      a: { accountScope: string; idempotencySuffix: string },
      b: { accountScope: string; idempotencySuffix: string },
    ) => a.accountScope.localeCompare(b.accountScope) || a.idempotencySuffix.localeCompare(b.idempotencySuffix);
    const shadowSorted = [...shadowInput.entries].sort(sortByScope);
    const mig1Sorted = [...mig1Out.event.entries].sort(sortByScope);
    expect(shadowSorted).toHaveLength(mig1Sorted.length);

    for (let i = 0; i < shadowSorted.length; i++) {
      const s = shadowSorted[i];
      const m = mig1Sorted[i];
      // INTENT fields (the seven compared strictly by post-transaction's divergence check):
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
