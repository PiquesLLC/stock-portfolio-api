// Unit tests for the three payout-lifecycle v2 shadow-writes:
//   G5a payout-requested      → PAYOUT_INITIATED, creator_payout suffix
//   G5b payout-failed         → PAYOUT_FAILED, creator_restore suffix
//   G5c transfer-reversed     → PAYOUT_REVERSED, creator_restore suffix
//
// Each helper has its own CONVERGENCE TEST against the corresponding MIG-1
// G5 mapper branch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapV1GroupToV2Event, type V1LedgerRow } from '../../migration/v1-to-v2-mapper';

const postTransactionMock = vi.hoisted(() => vi.fn());

vi.mock('../../ledger', () => ({
  postTransaction: postTransactionMock,
}));

import { shadowWritePayoutRequested } from '../payout-requested';
import { shadowWritePayoutFailed } from '../payout-failed';
import { shadowWriteTransferReversed } from '../transfer-reversed';

const CREATOR_ID = '11111111-1111-4111-8111-111111111111';

function makeV1Row(overrides: Partial<V1LedgerRow>): V1LedgerRow {
  return {
    id: 'row_' + Math.random().toString(36).slice(2, 10),
    creatorUserId: CREATOR_ID,
    type: 'payout',
    amountCents: 0,
    subscriptionId: null,
    description: 'placeholder',
    createdAt: new Date(),
    ...overrides,
  };
}

function sortByScope(
  a: { accountScope: string; idempotencySuffix: string },
  b: { accountScope: string; idempotencySuffix: string },
) {
  return (
    a.accountScope.localeCompare(b.accountScope) ||
    a.idempotencySuffix.localeCompare(b.idempotencySuffix)
  );
}

function assertIntentMatch(
  shadow: Array<Record<string, unknown>>,
  mig1: Array<Record<string, unknown>>,
): void {
  const s = [...shadow].sort(sortByScope as any);
  const m = [...mig1].sort(sortByScope as any);
  expect(s).toHaveLength(m.length);
  for (let i = 0; i < s.length; i++) {
    expect(s[i].accountScope).toBe(m[i].accountScope);
    expect(s[i].accountId).toBe(m[i].accountId);
    expect(s[i].eventType).toBe(m[i].eventType);
    expect(s[i].debitMinorUnits).toBe(m[i].debitMinorUnits);
    expect(s[i].creditMinorUnits).toBe(m[i].creditMinorUnits);
    expect(s[i].currency).toBe(m[i].currency);
    expect(s[i].idempotencySuffix).toBe(m[i].idempotencySuffix);
  }
}

describe('shadowWritePayoutRequested (G5a)', () => {
  const baseArgs = {
    payoutId: 'po_abc123',
    creatorUserId: CREATOR_ID,
    amountCents: 5000,
    effectiveAt: new Date('2026-05-28T12:00:00Z'),
  };

  beforeEach(() => {
    postTransactionMock.mockReset();
    postTransactionMock.mockResolvedValue({ eventGroupId: 'x', entries: [], deduplicated: false });
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('is a no-op when env not set', async () => {
    await shadowWritePayoutRequested(baseArgs);
    expect(postTransactionMock).not.toHaveBeenCalled();
  });

  it('skips zero/negative amount', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWritePayoutRequested({ ...baseArgs, amountCents: 0 });
    expect(postTransactionMock).not.toHaveBeenCalled();
  });

  it('emits 2-entry balanced group: creator debit + stripe_clearing credit', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWritePayoutRequested(baseArgs);
    const input = postTransactionMock.mock.calls[0][0];
    expect(input.entries).toHaveLength(2);
    const creator = input.entries.find((e: any) => e.accountScope === 'creator');
    const clearing = input.entries.find((e: any) => e.accountScope === 'stripe_clearing');
    expect(creator.debitMinorUnits).toBe(5000n);
    expect(clearing.creditMinorUnits).toBe(5000n);
    expect(creator.eventType).toBe('PAYOUT_INITIATED');
    expect(creator.idempotencySuffix).toBe('creator_payout');
    expect(clearing.idempotencySuffix).toBe('stripe_clearing');
  });

  it('uses api:request-payout postedBy', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWritePayoutRequested(baseArgs);
    expect(postTransactionMock.mock.calls[0][0].postedBy).toBe('api:request-payout');
  });

  it('swallows postTransaction errors', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    postTransactionMock.mockRejectedValueOnce(new Error('Postgres down'));
    await expect(shadowWritePayoutRequested(baseArgs)).resolves.toBeUndefined();
  });

  it('CONVERGENCE: shadow-write INTENT matches MIG-1 G5a', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWritePayoutRequested(baseArgs);
    const shadowInput = postTransactionMock.mock.calls[0][0];

    const v1Rows = [
      makeV1Row({
        type: 'payout',
        amountCents: baseArgs.amountCents,
        description: `payout:${baseArgs.payoutId}`,
      }),
    ];
    const mig1Out = mapV1GroupToV2Event(`payout:${baseArgs.payoutId}`, v1Rows);
    if (mig1Out.kind !== 'mapped') throw new Error('expected mapped');

    expect(shadowInput.eventGroupId).toBe(mig1Out.event.eventGroupId);
    assertIntentMatch(shadowInput.entries, mig1Out.event.entries as any);
  });
});

describe('shadowWritePayoutFailed (G5b)', () => {
  const baseArgs = {
    payoutId: 'po_xyz789',
    creatorUserId: CREATOR_ID,
    amountCents: 5000,
    effectiveAt: new Date('2026-05-28T12:00:00Z'),
  };

  beforeEach(() => {
    postTransactionMock.mockReset();
    postTransactionMock.mockResolvedValue({ eventGroupId: 'x', entries: [], deduplicated: false });
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('is a no-op when env not set', async () => {
    await shadowWritePayoutFailed(baseArgs);
    expect(postTransactionMock).not.toHaveBeenCalled();
  });

  it('emits creator credit + stripe_clearing debit (restoring)', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWritePayoutFailed(baseArgs);
    const input = postTransactionMock.mock.calls[0][0];
    const creator = input.entries.find((e: any) => e.accountScope === 'creator');
    const clearing = input.entries.find((e: any) => e.accountScope === 'stripe_clearing');
    expect(creator.creditMinorUnits).toBe(5000n);
    expect(clearing.debitMinorUnits).toBe(5000n);
    expect(creator.eventType).toBe('PAYOUT_FAILED');
    expect(creator.idempotencySuffix).toBe('creator_restore');
  });

  it('CONVERGENCE: shadow-write INTENT matches MIG-1 G5b', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWritePayoutFailed(baseArgs);
    const shadowInput = postTransactionMock.mock.calls[0][0];

    const v1Rows = [
      makeV1Row({
        type: 'earning',
        amountCents: baseArgs.amountCents,
        description: `payout_reversal:${baseArgs.payoutId}`,
      }),
    ];
    const mig1Out = mapV1GroupToV2Event(`payout_reversal:${baseArgs.payoutId}`, v1Rows);
    if (mig1Out.kind !== 'mapped') throw new Error('expected mapped');

    expect(shadowInput.eventGroupId).toBe(mig1Out.event.eventGroupId);
    assertIntentMatch(shadowInput.entries, mig1Out.event.entries as any);
  });
});

describe('shadowWriteTransferReversed (G5c)', () => {
  const baseArgs = {
    stripeTransferId: 'tr_abc999',
    stripeEventId: 'evt_reversed_123',
    creatorUserId: CREATOR_ID,
    amountCents: 5000,
    effectiveAt: new Date('2026-05-28T12:00:00Z'),
  };

  beforeEach(() => {
    postTransactionMock.mockReset();
    postTransactionMock.mockResolvedValue({ eventGroupId: 'x', entries: [], deduplicated: false });
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('is a no-op when env not set', async () => {
    await shadowWriteTransferReversed(baseArgs);
    expect(postTransactionMock).not.toHaveBeenCalled();
  });

  it('emits creator credit + stripe_clearing debit (restoring after reversed transfer)', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWriteTransferReversed(baseArgs);
    const input = postTransactionMock.mock.calls[0][0];
    const creator = input.entries.find((e: any) => e.accountScope === 'creator');
    expect(creator.creditMinorUnits).toBe(5000n);
    expect(creator.eventType).toBe('PAYOUT_REVERSED');
    expect(creator.idempotencySuffix).toBe('creator_restore');
    expect(creator.stripeObjectKind).toBe('transfer');
    expect(creator.stripeObjectId).toBe('tr_abc999');
    expect(creator.stripeEventId).toBe('evt_reversed_123');
  });

  it('uses webhook:transfer.reversed postedBy', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWriteTransferReversed(baseArgs);
    expect(postTransactionMock.mock.calls[0][0].postedBy).toBe('webhook:transfer.reversed');
  });

  it('CONVERGENCE: shadow-write INTENT matches MIG-1 G5c', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWriteTransferReversed(baseArgs);
    const shadowInput = postTransactionMock.mock.calls[0][0];

    const v1Rows = [
      makeV1Row({
        type: 'earning',
        amountCents: baseArgs.amountCents,
        description: `transfer_reversed:${baseArgs.stripeTransferId}`,
      }),
    ];
    const mig1Out = mapV1GroupToV2Event(
      `transfer_reversed:${baseArgs.stripeTransferId}`,
      v1Rows,
    );
    if (mig1Out.kind !== 'mapped') throw new Error('expected mapped');

    expect(shadowInput.eventGroupId).toBe(mig1Out.event.eventGroupId);
    assertIntentMatch(shadowInput.entries, mig1Out.event.entries as any);
  });
});
