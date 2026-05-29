// Unit tests for the v1↔v2 reconciliation logic.
//
// The v2 getBalance and v1 prisma are mocked at the module-level so these
// tests can verify the BALANCE COMPARISON ARITHMETIC without needing
// Postgres or libsql.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getBalanceMock = vi.hoisted(() => vi.fn());
const findManyMock = vi.hoisted(() => vi.fn());

vi.mock('../../ledger', () => ({
  getBalance: getBalanceMock,
}));

vi.mock('../../../utils/prisma', () => ({
  default: {
    creatorWalletLedger: { findMany: findManyMock },
  },
}));

import { reconcileAllCreators, reconcileCreator } from '../v1-vs-v2';

const CREATOR_A = 'a1111111-1111-4111-8111-111111111111';
const CREATOR_B = 'b2222222-2222-4222-8222-222222222222';

describe('reconcileCreator', () => {
  beforeEach(() => {
    getBalanceMock.mockReset();
    findManyMock.mockReset();
  });

  it('returns clean when v1 and v2 balances match', async () => {
    findManyMock.mockResolvedValueOnce([
      { type: 'earning', amountCents: 800 },
      { type: 'earning', amountCents: 800 },
      { type: 'payout', amountCents: 1000 },
    ]);
    // v1 = 800 + 800 - 1000 = 600
    getBalanceMock.mockResolvedValueOnce({
      balanceMinorUnits: 600n,
      exists: true,
      currency: 'USD',
      lastSequenceNo: 5n,
      accountScope: 'creator',
      accountId: CREATOR_A,
    });

    const result = await reconcileCreator(CREATOR_A);
    expect(result.divergent).toBe(false);
    expect(result.diffCents).toBe(0n);
    expect(result.v1BalanceCents).toBe(600);
    expect(result.v2BalanceCents).toBe(600n);
    expect(result.v1RowCount).toBe(3);
    expect(result.v2AccountExists).toBe(true);
  });

  it('returns divergent when v1 > v2', async () => {
    findManyMock.mockResolvedValueOnce([
      { type: 'earning', amountCents: 800 },
    ]);
    getBalanceMock.mockResolvedValueOnce({
      balanceMinorUnits: 500n,
      exists: true,
      currency: 'USD',
      lastSequenceNo: 1n,
      accountScope: 'creator',
      accountId: CREATOR_A,
    });

    const result = await reconcileCreator(CREATOR_A);
    expect(result.divergent).toBe(true);
    expect(result.diffCents).toBe(300n); // 800 - 500
  });

  it('returns divergent with negative diff when v2 > v1', async () => {
    findManyMock.mockResolvedValueOnce([
      { type: 'earning', amountCents: 500 },
    ]);
    getBalanceMock.mockResolvedValueOnce({
      balanceMinorUnits: 800n,
      exists: true,
      currency: 'USD',
      lastSequenceNo: 1n,
      accountScope: 'creator',
      accountId: CREATOR_A,
    });

    const result = await reconcileCreator(CREATOR_A);
    expect(result.divergent).toBe(true);
    expect(result.diffCents).toBe(-300n);
  });

  it('handles refund rows (negative amountCents)', async () => {
    findManyMock.mockResolvedValueOnce([
      { type: 'earning', amountCents: 1000 },
      { type: 'refund', amountCents: -200 }, // refund of $2 was taken back
    ]);
    // v1 = 1000 + (-200) = 800
    getBalanceMock.mockResolvedValueOnce({
      balanceMinorUnits: 800n,
      exists: true,
      currency: 'USD',
      lastSequenceNo: 2n,
      accountScope: 'creator',
      accountId: CREATOR_A,
    });

    const result = await reconcileCreator(CREATOR_A);
    expect(result.divergent).toBe(false);
    expect(result.v1BalanceCents).toBe(800);
  });

  it('marks v2 missing when account does not exist', async () => {
    findManyMock.mockResolvedValueOnce([
      { type: 'earning', amountCents: 500 },
    ]);
    getBalanceMock.mockResolvedValueOnce({
      balanceMinorUnits: 0n,
      exists: false,
      currency: null,
      lastSequenceNo: null,
      accountScope: 'creator',
      accountId: CREATOR_A,
    });

    const result = await reconcileCreator(CREATOR_A);
    expect(result.v2AccountExists).toBe(false);
    expect(result.divergent).toBe(true); // v1=500, v2=0, diff=500
  });

  it('returns 0/0 when creator has no v1 rows', async () => {
    findManyMock.mockResolvedValueOnce([]);
    getBalanceMock.mockResolvedValueOnce({
      balanceMinorUnits: 0n,
      exists: true,
      currency: 'USD',
      lastSequenceNo: null,
      accountScope: 'creator',
      accountId: CREATOR_A,
    });

    const result = await reconcileCreator(CREATOR_A);
    expect(result.divergent).toBe(false);
    expect(result.v1RowCount).toBe(0);
  });
});

describe('reconcileAllCreators', () => {
  const ORIGINAL_V2_URL = process.env.V2_DATABASE_URL;

  beforeEach(() => {
    getBalanceMock.mockReset();
    findManyMock.mockReset();
    process.env.V2_DATABASE_URL = 'postgresql://test:test@localhost/test';
  });

  afterEach(() => {
    if (ORIGINAL_V2_URL === undefined) delete process.env.V2_DATABASE_URL;
    else process.env.V2_DATABASE_URL = ORIGINAL_V2_URL;
  });

  it('throws when V2_DATABASE_URL is missing', async () => {
    delete process.env.V2_DATABASE_URL;
    await expect(reconcileAllCreators()).rejects.toThrow(/V2_DATABASE_URL/);
  });

  it('aggregates clean / divergent / v2-missing buckets', async () => {
    // First findMany: distinct creator ids
    findManyMock.mockResolvedValueOnce([
      { creatorUserId: CREATOR_A },
      { creatorUserId: CREATOR_B },
    ]);
    // For CREATOR_A: v1 = 500, v2 = 500 (clean)
    findManyMock.mockResolvedValueOnce([{ type: 'earning', amountCents: 500 }]);
    getBalanceMock.mockResolvedValueOnce({
      balanceMinorUnits: 500n,
      exists: true,
      currency: 'USD',
      lastSequenceNo: 1n,
      accountScope: 'creator',
      accountId: CREATOR_A,
    });
    // For CREATOR_B: v1 = 800, v2 = 600 (divergent)
    findManyMock.mockResolvedValueOnce([{ type: 'earning', amountCents: 800 }]);
    getBalanceMock.mockResolvedValueOnce({
      balanceMinorUnits: 600n,
      exists: true,
      currency: 'USD',
      lastSequenceNo: 1n,
      accountScope: 'creator',
      accountId: CREATOR_B,
    });

    const report = await reconcileAllCreators();
    expect(report.totalScanned).toBe(2);
    expect(report.cleanCount).toBe(1);
    expect(report.divergent).toHaveLength(1);
    expect(report.divergent[0].creatorUserId).toBe(CREATOR_B);
    expect(report.divergent[0].diffCents).toBe(200n);
    expect(report.v2Missing).toHaveLength(0);
  });

  it('routes v2-missing creators to the v2Missing bucket, not divergent', async () => {
    findManyMock.mockResolvedValueOnce([{ creatorUserId: CREATOR_A }]);
    findManyMock.mockResolvedValueOnce([{ type: 'earning', amountCents: 500 }]);
    getBalanceMock.mockResolvedValueOnce({
      balanceMinorUnits: 0n,
      exists: false, // ← v2 account never created
      currency: null,
      lastSequenceNo: null,
      accountScope: 'creator',
      accountId: CREATOR_A,
    });

    const report = await reconcileAllCreators();
    expect(report.divergent).toHaveLength(0);
    expect(report.v2Missing).toHaveLength(1);
    expect(report.cleanCount).toBe(0);
  });
});
