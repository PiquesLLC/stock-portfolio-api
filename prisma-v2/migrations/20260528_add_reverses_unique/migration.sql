-- =============================================================================
-- Add partial unique on reverses_entry_id — prevent double clawback
-- =============================================================================
-- Without this, a referent can be reversed multiple times. Realistic abuse
-- scenario: dispute clawback fires; a second concurrent dispute handler also
-- fires (e.g., due to webhook re-delivery hitting a different worker that's
-- racing on its idempotency key). Both reversals have distinct
-- idempotency_keys, so neither conflicts on the existing idempotency
-- constraint. Both reverse the SAME referent. Result: the creator's balance
-- is drained twice for one original debit. Money lost.
--
-- The fix is structural: enforce at-most-one reversal per referent at the DB
-- layer. The partial WHERE clause keeps the index small (NULLs are common —
-- most entries don't reverse anything).
--
-- This DOES NOT block reversal-of-reversal (legitimate when a dispute is
-- resolved in the creator's favor and the clawback itself must be undone):
--   A: original credit ($100).        reverses_entry_id = NULL
--   B: clawback debit reverses A.     reverses_entry_id = A.id
--   C: restore credit reverses B.     reverses_entry_id = B.id  ← different value, OK
-- Each referent (A and B) gets at most one reversal.
-- =============================================================================

CREATE UNIQUE INDEX "ledger_entry_reverses_unique"
  ON "ledger_entry"("reverses_entry_id")
  WHERE "reverses_entry_id" IS NOT NULL;

-- The non-unique partial index on reverses_entry_id (from the initial
-- migration) is redundant now — drop it. The unique index serves both the
-- uniqueness constraint AND the lookup-by-referent query pattern.
DROP INDEX IF EXISTS "ledger_entry_reverses_entry_id";
