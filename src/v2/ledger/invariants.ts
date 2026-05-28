// Application-level invariant checks.
//
// These produce friendly error messages BEFORE the DB round-trip. The DB
// CHECK constraints + triggers also enforce these (defense in depth), but
// catching them here keeps stack traces clean and avoids burning a DB
// connection on a guaranteed-to-fail insert.
//
// Coverage per invariant (architecture §3.5):
//   INV-1  per-entry XOR        → assertInv1 (here)         + DB CHECK (migration.sql)
//   INV-2  per-event balance     → assertInv2 (here)
//   INV-3  per-charge fee split  → per-handler in caller (event-type-specific; not generic)
//   INV-4  no negative balance   → read-side check in eligibility code (not here)
//   INV-5  reversal symmetry     → assertInv5Shape (here, shape only)
//                                  + DB referent lookup (in postTransaction)
//   INV-6  append-only           → DB triggers only (can't be enforced at app layer)
//   INV-7  Stripe-anchor         → reconciliation cron
//   INV-8  reconciliation parity → reconciliation cron

import { LedgerEntryInput, LedgerInvariantViolation, PostTransactionInput } from './types';

/**
 * INV-1: per-entry XOR. Exactly one of (debit, credit) must be > 0. Both
 * zero means a no-op entry (forbidden — facts that move zero money don't
 * belong in the ledger). Both non-zero is structurally ambiguous.
 */
export function assertInv1(entry: LedgerEntryInput, index: number): void {
  if (entry.debitMinorUnits < 0n || entry.creditMinorUnits < 0n) {
    throw new LedgerInvariantViolation(
      'INV-1',
      `Entry ${index}: amounts must be non-negative. Got debit=${entry.debitMinorUnits}, credit=${entry.creditMinorUnits}.`,
    );
  }
  const debitZero = entry.debitMinorUnits === 0n;
  const creditZero = entry.creditMinorUnits === 0n;
  if (debitZero && creditZero) {
    throw new LedgerInvariantViolation(
      'INV-1',
      `Entry ${index}: both debit and credit are zero. Each entry must move exactly one side.`,
    );
  }
  if (!debitZero && !creditZero) {
    throw new LedgerInvariantViolation(
      'INV-1',
      `Entry ${index}: both debit (${entry.debitMinorUnits}) and credit (${entry.creditMinorUnits}) are non-zero. XOR violation.`,
    );
  }
}

/**
 * INV-2: per-event balance. Σdebit = Σcredit across all entries in this
 * postTransaction call. This is the foundational double-entry guarantee:
 * every event MUST balance to zero across the books.
 *
 * If this throws, the caller built the event group wrong. Common bugs:
 * forgot a leg (e.g. wrote only the creator credit without the stripe_clearing
 * debit), or computed shares with rounding that left a residual cent.
 */
export function assertInv2(input: PostTransactionInput): void {
  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const entry of input.entries) {
    totalDebit += entry.debitMinorUnits;
    totalCredit += entry.creditMinorUnits;
  }
  if (totalDebit !== totalCredit) {
    throw new LedgerInvariantViolation(
      'INV-2',
      `Event group ${input.eventGroupId} unbalanced: Σdebit=${totalDebit} ≠ Σcredit=${totalCredit}. ` +
        `Difference=${totalDebit - totalCredit} minor units. ` +
        `Every event must balance to zero across the books.`,
    );
  }
}

/**
 * INV-5 (shape): if an entry has `reversesEntryId` set, it must document
 * why via `metadata.reversalReason`. The full referent-lookup check (does
 * the referenced entry actually exist and have the inverse shape?) happens
 * in postTransaction with a DB read.
 *
 * This shape check protects against accidental reversals — a reversal
 * without a documented reason is almost always a bug.
 */
export function assertInv5Shape(entry: LedgerEntryInput, index: number): void {
  if (!entry.reversesEntryId) return;
  const reason = entry.metadata?.reversalReason;
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new LedgerInvariantViolation(
      'INV-5',
      `Entry ${index} reverses ${entry.reversesEntryId} but has no metadata.reversalReason. ` +
        `Reversals MUST document why — set metadata.reversalReason to a string explaining ` +
        `(e.g. 'dispute_won', 'transfer_failed_at_stripe', 'ops_correction_ticket_12345').`,
    );
  }
}

// idempotencySuffix shape rules (enforced here, NOT at the DB level):
//   - Non-empty (empty would silently collide via the implicit `${uuid}:`
//     idempotency_key for different intents).
//   - Lowercase ASCII letters, digits, and underscores only. Forbidding
//     other characters keeps log/grep-ability sane and avoids any quoting
//     surprises in error messages or SQL string interpolation downstream.
//   - 1-64 chars (idempotency_key column is 128 chars; uuid prefix is 37
//     including the colon; suffix gets the remaining 91 — cap at 64 to
//     leave headroom and reject unrealistically long inputs).
const IDEMPOTENCY_SUFFIX_REGEX = /^[a-z0-9_]{1,64}$/;

/**
 * Sanity check that the input's entries all share consistent idempotency
 * suffixes (no duplicates within one call) AND each suffix matches the
 * allowed shape. The (account_scope, account_id, idempotency_key) DB unique
 * constraint would catch duplicates, but only AFTER a partial transaction
 * commit attempt — so we pre-check both shape and uniqueness here.
 */
export function assertUniqueIdempotencySuffixes(input: PostTransactionInput): void {
  const seen = new Set<string>();
  for (let i = 0; i < input.entries.length; i++) {
    const e = input.entries[i];
    if (!IDEMPOTENCY_SUFFIX_REGEX.test(e.idempotencySuffix)) {
      throw new Error(
        `Entry ${i}: idempotencySuffix '${e.idempotencySuffix}' is invalid. ` +
          `Must be 1-64 chars of [a-z0-9_]. Empty strings and special chars are rejected ` +
          `to prevent silent collisions and downstream quoting surprises.`,
      );
    }
    const key = `${e.accountScope}:${e.accountId}:${e.idempotencySuffix}`;
    if (seen.has(key)) {
      throw new Error(
        `Entry ${i} has duplicate (accountScope, accountId, idempotencySuffix) within this call: ${key}. ` +
          `Each entry's idempotencySuffix must be unique within one event group.`,
      );
    }
    seen.add(key);
  }
}
