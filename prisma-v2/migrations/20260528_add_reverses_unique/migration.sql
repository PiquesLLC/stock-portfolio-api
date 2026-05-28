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

-- ── Pre-flight: refuse to apply if duplicates already exist ──────────────
-- If a prior version of the code allowed double-clawback before this index
-- was added, the table may contain multiple rows with the same
-- reverses_entry_id. Building a unique index over such data would fail
-- mid-migration with a generic 23505 error and leave the deploy
-- half-applied. Instead, scan first and abort with a remediation message
-- so operators can manually net the duplicate reversals (via ledger_admin
-- break-glass + audit log) before re-running.
--
-- For fresh deployments (no rows yet) this is a no-op.
DO $$
DECLARE
  duplicate_count INT;
  sample_referent UUID;
BEGIN
  SELECT COUNT(*), MIN(reverses_entry_id)
    INTO duplicate_count, sample_referent
    FROM (
      SELECT reverses_entry_id
        FROM ledger_entry
       WHERE reverses_entry_id IS NOT NULL
       GROUP BY reverses_entry_id
      HAVING COUNT(*) > 1
    ) dups;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'Cannot create ledger_entry_reverses_unique: % referent(s) have multiple reversals (sample: %). These are evidence of prior double-clawback bugs. Resolve by netting the redundant reversals via the ledger_admin role (insert compensating restores referencing the duplicate reversal rows, NOT the original referent) and document each in admin_audit_log before re-running this migration.',
      duplicate_count, sample_referent;
  END IF;
END $$;

-- ── Create the unique partial index ──────────────────────────────────────
-- Postgres treats NULL as distinct, so a regular unique index would
-- semantically work too — but the partial WHERE clause keeps the index
-- small (most rows have reverses_entry_id IS NULL, so they don't belong
-- in the index at all).
--
-- NOTE for production: this CREATE UNIQUE INDEX takes an
-- ACCESS-EXCLUSIVE-like lock on ledger_entry during build. For a
-- populated production table, the next iteration of this migration
-- should switch to `CREATE UNIQUE INDEX CONCURRENTLY` (requires running
-- outside a transaction block — split the migration so Prisma doesn't
-- wrap it in BEGIN). Acceptable here because the v2 ledger is empty at
-- this point in the rollout.
CREATE UNIQUE INDEX "ledger_entry_reverses_unique"
  ON "ledger_entry"("reverses_entry_id")
  WHERE "reverses_entry_id" IS NOT NULL;

-- The non-unique partial index on reverses_entry_id (from the initial
-- migration) is redundant now — drop it. The unique index serves both the
-- uniqueness constraint AND the lookup-by-referent query pattern.
DROP INDEX IF EXISTS "ledger_entry_reverses_entry_id";
