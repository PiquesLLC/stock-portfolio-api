// Unit tests for the v1 wallet freeze helper.
//
// The helper is tiny but operationally load-bearing: cutover day relies on
// `V1_WALLET_FREEZE=true` being a 1-line flip that suppresses ALL v1 writes.
// These tests assert the contract:
//   1. Default (env unset): pass-through to creatorWalletLedger.create.
//   2. Frozen (env=true): no-op SELECT 1 via $queryRaw; the create method
//      is NEVER called.
//   3. Frozen: cooldown-throttled log line surfaces at least once per process.
//   4. Frozen → unfrozen: subsequent calls go back to pass-through.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isV1WalletFrozen, v1LedgerCreate } from '../v1-wallet-freeze';

const ORIGINAL = process.env.V1_WALLET_FREEZE;

function mockClient() {
  return {
    creatorWalletLedger: { create: vi.fn(() => 'CREATE_RESULT') },
    $queryRaw: vi.fn(() => 'SELECT_1_RESULT'),
  };
}

describe('isV1WalletFrozen', () => {
  beforeEach(() => {
    delete process.env.V1_WALLET_FREEZE;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.V1_WALLET_FREEZE;
    else process.env.V1_WALLET_FREEZE = ORIGINAL;
  });

  it('returns false by default', () => {
    expect(isV1WalletFrozen()).toBe(false);
  });

  it('returns true when env is exactly "true"', () => {
    process.env.V1_WALLET_FREEZE = 'true';
    expect(isV1WalletFrozen()).toBe(true);
  });

  it('treats other truthy-ish strings as NOT frozen (strict opt-in)', () => {
    for (const val of ['1', 'TRUE', 'True', 'yes', 'on']) {
      process.env.V1_WALLET_FREEZE = val;
      expect(isV1WalletFrozen()).toBe(false);
    }
  });
});

describe('v1LedgerCreate', () => {
  beforeEach(() => {
    delete process.env.V1_WALLET_FREEZE;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T00:00:00Z'));
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.V1_WALLET_FREEZE;
    else process.env.V1_WALLET_FREEZE = ORIGINAL;
    vi.useRealTimers();
  });

  it('passes through to creatorWalletLedger.create when not frozen', () => {
    const client = mockClient();
    const args = { data: { creatorUserId: 'u1', type: 'earning', amountCents: 100, description: 'x' } } as never;

    const result = v1LedgerCreate(client as never, args);

    expect(client.creatorWalletLedger.create).toHaveBeenCalledTimes(1);
    expect(client.creatorWalletLedger.create).toHaveBeenCalledWith(args);
    expect(client.$queryRaw).not.toHaveBeenCalled();
    expect(result).toBe('CREATE_RESULT');
  });

  it('suppresses to SELECT 1 when frozen', () => {
    process.env.V1_WALLET_FREEZE = 'true';
    const client = mockClient();
    const args = { data: { creatorUserId: 'u1', type: 'earning', amountCents: 100, description: 'x' } } as never;

    const result = v1LedgerCreate(client as never, args);

    expect(client.creatorWalletLedger.create).not.toHaveBeenCalled();
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result).toBe('SELECT_1_RESULT');
  });

  it('throttles the suppression log to once per 60s', () => {
    process.env.V1_WALLET_FREEZE = 'true';
    const client = mockClient();
    const args = { data: { creatorUserId: 'u1', type: 'earning', amountCents: 100, description: 'x' } } as never;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // First call within the cooldown window — should log.
    v1LedgerCreate(client as never, args);
    const firstLogCount = logSpy.mock.calls.filter((c) => c[0].includes?.('[V1 Freeze]')).length;

    // 30 calls in quick succession — should still only have one freeze log.
    for (let i = 0; i < 30; i++) v1LedgerCreate(client as never, args);
    const inCooldownCount = logSpy.mock.calls.filter((c) => c[0].includes?.('[V1 Freeze]')).length;
    expect(inCooldownCount).toBe(firstLogCount);

    // Advance past the 60s cooldown — next call logs again.
    vi.advanceTimersByTime(61_000);
    v1LedgerCreate(client as never, args);
    const afterCooldownCount = logSpy.mock.calls.filter((c) => c[0].includes?.('[V1 Freeze]')).length;
    expect(afterCooldownCount).toBe(firstLogCount + 1);

    logSpy.mockRestore();
  });

  it('toggles cleanly when env flips back to unset mid-process', () => {
    process.env.V1_WALLET_FREEZE = 'true';
    const client = mockClient();
    const args = { data: { creatorUserId: 'u1', type: 'earning', amountCents: 100, description: 'x' } } as never;

    v1LedgerCreate(client as never, args);
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);

    delete process.env.V1_WALLET_FREEZE;
    v1LedgerCreate(client as never, args);
    expect(client.creatorWalletLedger.create).toHaveBeenCalledTimes(1);
    expect(client.$queryRaw).toHaveBeenCalledTimes(1); // unchanged
  });

  it('propagates errors thrown by the underlying create when not frozen', async () => {
    const client = {
      creatorWalletLedger: {
        create: vi.fn(() => Promise.reject(new Error('P2002: unique constraint violation'))),
      },
      $queryRaw: vi.fn(),
    };
    const args = { data: { creatorUserId: 'u1', type: 'earning', amountCents: 100, description: 'x' } } as never;

    await expect(v1LedgerCreate(client as never, args)).rejects.toThrow(/P2002/);
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });

  it('accepts an interactive transaction client (tx) the same way', () => {
    // Prisma's interactive transaction passes a `tx` client with the same
    // shape as the top-level prisma instance for the operations we care
    // about. The helper's generic accepts either.
    const tx = mockClient();
    const args = { data: { creatorUserId: 'u2', type: 'payout', amountCents: 500, description: 'payout:p1' } } as never;

    const result = v1LedgerCreate(tx as never, args);

    expect(tx.creatorWalletLedger.create).toHaveBeenCalledTimes(1);
    expect(result).toBe('CREATE_RESULT');
  });
});
