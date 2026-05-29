// Pure-function unit tests for application-layer invariants.
//
// Locks in the seven hardening passes' worth of invariant logic in
// `src/v2/ledger/invariants.ts`. No DB, no Stripe, no async — these run
// in milliseconds and catch any future regression in:
//   INV-1   per-entry XOR + non-negative
//   INV-2   per-event-per-currency balance
//   INV-5   reversal shape (metadata.reversalReason)
//   idempotency suffix rules (regex + uniqueness within one call)

import { describe, expect, it } from 'vitest';
import {
  assertInv1,
  assertInv2,
  assertInv5Shape,
  assertUniqueIdempotencySuffixes,
} from '../invariants';
import { LedgerEntryInput, LedgerInvariantViolation, PostTransactionInput } from '../types';

const UUID_OK = '11111111-1111-4111-8111-111111111111';
const CREATOR_ID = '22222222-2222-4222-8222-222222222222';

function makeEntry(overrides: Partial<LedgerEntryInput> = {}): LedgerEntryInput {
  return {
    accountScope: 'creator',
    accountId: CREATOR_ID,
    eventType: 'EARNING_GROSS',
    debitMinorUnits: 0n,
    creditMinorUnits: 1000n,
    currency: 'USD',
    idempotencySuffix: 'share',
    ...overrides,
  };
}

function makeInput(entries: LedgerEntryInput[]): PostTransactionInput {
  return {
    eventGroupId: UUID_OK,
    effectiveAt: new Date('2026-01-15T00:00:00Z'),
    postedBy: 'webhook:invoice.paid',
    entries,
  };
}

describe('assertInv1 (per-entry XOR)', () => {
  it('passes when debit-only', () => {
    expect(() => assertInv1(makeEntry({ debitMinorUnits: 500n, creditMinorUnits: 0n }), 0)).not.toThrow();
  });

  it('passes when credit-only', () => {
    expect(() => assertInv1(makeEntry({ debitMinorUnits: 0n, creditMinorUnits: 500n }), 0)).not.toThrow();
  });

  it('rejects negative debit', () => {
    expect(() => assertInv1(makeEntry({ debitMinorUnits: -1n, creditMinorUnits: 100n }), 0))
      .toThrow(LedgerInvariantViolation);
  });

  it('rejects negative credit', () => {
    expect(() => assertInv1(makeEntry({ debitMinorUnits: 100n, creditMinorUnits: -1n }), 0))
      .toThrow(LedgerInvariantViolation);
  });

  it('rejects both-zero entry', () => {
    expect(() => assertInv1(makeEntry({ debitMinorUnits: 0n, creditMinorUnits: 0n }), 0))
      .toThrow(/both debit and credit are zero/);
  });

  it('rejects both-non-zero (XOR violation)', () => {
    expect(() => assertInv1(makeEntry({ debitMinorUnits: 500n, creditMinorUnits: 500n }), 0))
      .toThrow(/XOR violation/);
  });

  it('error message includes the entry index for debugging', () => {
    expect(() => assertInv1(makeEntry({ debitMinorUnits: 0n, creditMinorUnits: 0n }), 7))
      .toThrow(/Entry 7/);
  });
});

describe('assertInv2 (per-event-per-currency balance)', () => {
  it('passes when single-currency event balances', () => {
    const input = makeInput([
      makeEntry({ accountScope: 'creator', accountId: CREATOR_ID, debitMinorUnits: 0n, creditMinorUnits: 800n, idempotencySuffix: 'creator_share' }),
      makeEntry({ accountScope: 'stripe_clearing', accountId: 'platform', debitMinorUnits: 800n, creditMinorUnits: 0n, idempotencySuffix: 'stripe_clearing' }),
    ]);
    expect(() => assertInv2(input)).not.toThrow();
  });

  it('rejects single-currency unbalanced event', () => {
    const input = makeInput([
      makeEntry({ debitMinorUnits: 0n, creditMinorUnits: 800n }),
      makeEntry({ accountScope: 'platform_revenue', accountId: 'platform', debitMinorUnits: 200n, creditMinorUnits: 0n, idempotencySuffix: 'platform' }),
    ]);
    expect(() => assertInv2(input))
      .toThrow(/unbalanced for currency USD/);
  });

  it('rejects cross-currency "balance" (USD debit cannot offset EUR credit)', () => {
    const input = makeInput([
      makeEntry({ currency: 'USD', debitMinorUnits: 1000n, creditMinorUnits: 0n }),
      makeEntry({ accountScope: 'platform_revenue', accountId: 'platform', currency: 'EUR', debitMinorUnits: 0n, creditMinorUnits: 1000n, idempotencySuffix: 'other' }),
    ]);
    // Should fail USD AND EUR separately.
    expect(() => assertInv2(input)).toThrow(/unbalanced for currency/);
  });

  it('passes when each currency independently balances', () => {
    const input = makeInput([
      makeEntry({ currency: 'USD', debitMinorUnits: 0n, creditMinorUnits: 1000n, idempotencySuffix: 'a' }),
      makeEntry({ accountScope: 'stripe_clearing', accountId: 'platform', currency: 'USD', debitMinorUnits: 1000n, creditMinorUnits: 0n, idempotencySuffix: 'b' }),
      makeEntry({ accountScope: 'platform_revenue', accountId: 'platform', currency: 'EUR', debitMinorUnits: 0n, creditMinorUnits: 500n, idempotencySuffix: 'c' }),
      makeEntry({ accountScope: 'platform_fee', accountId: 'platform', currency: 'EUR', debitMinorUnits: 500n, creditMinorUnits: 0n, idempotencySuffix: 'd' }),
    ]);
    expect(() => assertInv2(input)).not.toThrow();
  });

  it('error message names the unbalanced currency and the delta', () => {
    const input = makeInput([
      makeEntry({ debitMinorUnits: 0n, creditMinorUnits: 800n }),
      makeEntry({ accountScope: 'platform_revenue', accountId: 'platform', debitMinorUnits: 100n, creditMinorUnits: 0n, idempotencySuffix: 'platform' }),
    ]);
    let caught: Error | null = null;
    try { assertInv2(input); } catch (e) { caught = e as Error; }
    expect(caught?.message).toMatch(/currency USD/);
    expect(caught?.message).toMatch(/Difference=-?\d+ minor units/);
  });

  it('returns silently on empty entries (caller is expected to guard length)', () => {
    // postTransaction itself guards `entries.length === 0` upfront. assertInv2
    // is meaningful only on populated input, but it MUST NOT throw on empty
    // — the empty totals map iterates over nothing, which is correct.
    const input = makeInput([]);
    expect(() => assertInv2(input)).not.toThrow();
  });

  it('rejects single-entry event (cannot balance by itself)', () => {
    // One entry can only be debit-only OR credit-only (INV-1), so by
    // definition it can't satisfy Σdebit == Σcredit unless both are zero
    // (rejected by INV-1). INV-2 catches this independently.
    const input = makeInput([
      makeEntry({ debitMinorUnits: 0n, creditMinorUnits: 1000n }),
    ]);
    expect(() => assertInv2(input)).toThrow(/unbalanced for currency USD/);
  });
});

describe('assertInv5Shape (reversal must document reason)', () => {
  it('passes when entry has no reversesEntryId', () => {
    expect(() => assertInv5Shape(makeEntry(), 0)).not.toThrow();
  });

  it('rejects reversal with no metadata at all', () => {
    expect(() => assertInv5Shape(
      makeEntry({ reversesEntryId: 'ref_xyz', metadata: undefined }), 0
    )).toThrow(/no metadata.reversalReason/);
  });

  it('rejects reversal with metadata but no reversalReason key', () => {
    expect(() => assertInv5Shape(
      makeEntry({ reversesEntryId: 'ref_xyz', metadata: { other: 'data' } }), 0
    )).toThrow(/no metadata.reversalReason/);
  });

  it('rejects reversal with empty-string reversalReason', () => {
    expect(() => assertInv5Shape(
      makeEntry({ reversesEntryId: 'ref_xyz', metadata: { reversalReason: '' } }), 0
    )).toThrow(/no metadata.reversalReason/);
  });

  it('rejects reversal with non-string reversalReason', () => {
    expect(() => assertInv5Shape(
      makeEntry({ reversesEntryId: 'ref_xyz', metadata: { reversalReason: 42 as unknown as string } }), 0
    )).toThrow(/no metadata.reversalReason/);
  });

  it('passes with a documented reversal reason', () => {
    expect(() => assertInv5Shape(
      makeEntry({ reversesEntryId: 'ref_xyz', metadata: { reversalReason: 'dispute_won' } }), 0
    )).not.toThrow();
  });
});

describe('assertUniqueIdempotencySuffixes (shape + uniqueness)', () => {
  it('passes with unique single-call suffixes', () => {
    const input = makeInput([
      makeEntry({ idempotencySuffix: 'creator_share' }),
      makeEntry({ accountScope: 'stripe_clearing', accountId: 'platform', idempotencySuffix: 'stripe_clearing' }),
    ]);
    expect(() => assertUniqueIdempotencySuffixes(input)).not.toThrow();
  });

  it('rejects empty idempotencySuffix', () => {
    const input = makeInput([makeEntry({ idempotencySuffix: '' })]);
    expect(() => assertUniqueIdempotencySuffixes(input)).toThrow(/idempotencySuffix '' is invalid/);
  });

  it('rejects uppercase chars in suffix', () => {
    const input = makeInput([makeEntry({ idempotencySuffix: 'CreatorShare' })]);
    expect(() => assertUniqueIdempotencySuffixes(input)).toThrow(/is invalid/);
  });

  it('rejects special chars (colon, dot, hyphen, whitespace, control) in suffix', () => {
    for (const bad of ['a:b', 'a.b', 'a-b', 'a b', 'a@b', 'a/b', 'share\n', 'share\t', 'share ', ' share', 'a\rb']) {
      const input = makeInput([makeEntry({ idempotencySuffix: bad })]);
      expect(() => assertUniqueIdempotencySuffixes(input)).toThrow(/is invalid/);
    }
  });

  it('rejects suffix longer than 64 chars', () => {
    const input = makeInput([makeEntry({ idempotencySuffix: 'a'.repeat(65) })]);
    expect(() => assertUniqueIdempotencySuffixes(input)).toThrow(/is invalid/);
  });

  it('accepts exactly 64-char suffix', () => {
    const input = makeInput([makeEntry({ idempotencySuffix: 'a'.repeat(64) })]);
    expect(() => assertUniqueIdempotencySuffixes(input)).not.toThrow();
  });

  it('accepts underscores and digits', () => {
    const input = makeInput([makeEntry({ idempotencySuffix: 'event_1_share_v2' })]);
    expect(() => assertUniqueIdempotencySuffixes(input)).not.toThrow();
  });

  it('rejects duplicate (scope, accountId, suffix) within one call', () => {
    const input = makeInput([
      makeEntry({ idempotencySuffix: 'share' }),
      makeEntry({ idempotencySuffix: 'share' }), // same scope+accountId+suffix
    ]);
    expect(() => assertUniqueIdempotencySuffixes(input)).toThrow(/duplicate \(accountScope, accountId, idempotencySuffix\)/);
  });

  it('allows same suffix across different accounts', () => {
    // The DB unique is (scope, accountId, idempotency_key) — different
    // accounts CAN share the same suffix legitimately.
    const input = makeInput([
      makeEntry({ accountScope: 'creator', accountId: CREATOR_ID, idempotencySuffix: 'share' }),
      makeEntry({ accountScope: 'platform_revenue', accountId: 'platform', idempotencySuffix: 'share' }),
    ]);
    expect(() => assertUniqueIdempotencySuffixes(input)).not.toThrow();
  });

  it('error message includes the offending triple for debugging', () => {
    const input = makeInput([
      makeEntry({ idempotencySuffix: 'share' }),
      makeEntry({ idempotencySuffix: 'share' }),
    ]);
    let caught: Error | null = null;
    try { assertUniqueIdempotencySuffixes(input); } catch (e) { caught = e as Error; }
    expect(caught?.message).toMatch(/creator:.+:share/);
  });
});

describe('LedgerInvariantViolation error class', () => {
  it('preserves the invariant tag on thrown errors', () => {
    try {
      assertInv1(makeEntry({ debitMinorUnits: 0n, creditMinorUnits: 0n }), 0);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LedgerInvariantViolation);
      expect((e as LedgerInvariantViolation).invariant).toBe('INV-1');
    }
  });

  it('tags INV-2 violations correctly', () => {
    const input = makeInput([
      makeEntry({ debitMinorUnits: 0n, creditMinorUnits: 800n }),
      makeEntry({ accountScope: 'platform_revenue', accountId: 'platform', debitMinorUnits: 100n, creditMinorUnits: 0n, idempotencySuffix: 'p' }),
    ]);
    try {
      assertInv2(input);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LedgerInvariantViolation);
      expect((e as LedgerInvariantViolation).invariant).toBe('INV-2');
    }
  });

  it('tags INV-5 violations correctly', () => {
    try {
      assertInv5Shape(makeEntry({ reversesEntryId: 'r', metadata: undefined }), 0);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LedgerInvariantViolation);
      expect((e as LedgerInvariantViolation).invariant).toBe('INV-5');
    }
  });
});
