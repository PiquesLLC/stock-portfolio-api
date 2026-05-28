-- =============================================================================
-- Nala v2 ledger — initial schema
-- =============================================================================
-- Encodes the double-entry ledger from the v2 architecture (sections 3 + 8).
-- The Prisma schema at ../../schema.prisma generates the table shape; this
-- migration adds the Postgres-specific constructs Prisma can't express:
--   - CHECK constraints (INV-1, non-negative amounts, XOR debit/credit)
--   - BEFORE INSERT trigger (sequence_no allocator, currency match,
--     running balance computation)
--   - BEFORE UPDATE/DELETE/TRUNCATE triggers (INV-6 append-only)
--   - Partial indexes (WHERE clauses on stripe_event_id, stripe_object_id,
--     reverses_entry_id)
--   - search_path hardening on trigger functions
-- =============================================================================

-- pgcrypto for gen_random_uuid(). Aurora 16 has this available; alpine ships it too.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- accounts
-- =============================================================================
CREATE TABLE "accounts" (
  "account_scope"     TEXT        NOT NULL,
  "account_id"        TEXT        NOT NULL,
  "currency"          CHAR(3)     NOT NULL,
  "next_sequence_no"  BIGINT      NOT NULL DEFAULT 1,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "accounts_pkey" PRIMARY KEY ("account_scope", "account_id")
);

-- =============================================================================
-- ledger_entry
-- =============================================================================
CREATE TABLE "ledger_entry" (
  "id"                          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "sequence_no"                 BIGINT      NOT NULL,
  "account_scope"               TEXT        NOT NULL,
  "account_id"                  TEXT        NOT NULL,
  "event_type"                  TEXT        NOT NULL,
  "event_group_id"              UUID        NOT NULL,
  "debit_minor_units"           BIGINT      NOT NULL DEFAULT 0,
  "credit_minor_units"          BIGINT      NOT NULL DEFAULT 0,
  "currency"                    CHAR(3)     NOT NULL,
  "stripe_object_kind"          TEXT,
  "stripe_object_id"            TEXT,
  "stripe_event_id"             TEXT,
  "idempotency_key"             TEXT        NOT NULL,
  "reverses_entry_id"           UUID,
  "running_balance_minor_units" BIGINT      NOT NULL,
  "posted_at"                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "effective_at"                TIMESTAMPTZ NOT NULL,
  "posted_by"                   TEXT        NOT NULL,
  "metadata"                    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id"),

  -- INV-1: per-entry XOR (debit XOR credit). Exactly one of the two must
  -- be non-zero. Zero-amount entries are forbidden — if a fact has zero
  -- monetary effect, it doesn't belong in the ledger.
  CONSTRAINT "ledger_entry_xor_debit_credit"
    CHECK ((debit_minor_units = 0) <> (credit_minor_units = 0)),

  -- Defensive: amounts are stored as unsigned magnitudes. The XOR check
  -- means only one is non-zero per row, and the non-zero one must be > 0.
  CONSTRAINT "ledger_entry_debit_non_negative"  CHECK (debit_minor_units  >= 0),
  CONSTRAINT "ledger_entry_credit_non_negative" CHECK (credit_minor_units >= 0)
);

-- ── Uniqueness constraints (load-bearing) ────────────────────────────────────
CREATE UNIQUE INDEX "ledger_entry_seq_unique"
  ON "ledger_entry"("account_scope", "account_id", "sequence_no");

CREATE UNIQUE INDEX "ledger_entry_idempotency_unique"
  ON "ledger_entry"("account_scope", "account_id", "idempotency_key");

CREATE UNIQUE INDEX "ledger_entry_eventgroup_type_unique"
  ON "ledger_entry"("event_group_id", "account_scope", "event_type");

-- ── Performance indexes ──────────────────────────────────────────────────────
-- Primary read path
CREATE INDEX "ledger_entry_account_seq_desc"
  ON "ledger_entry"("account_scope", "account_id", "sequence_no" DESC);

CREATE INDEX "ledger_entry_event_group_id"
  ON "ledger_entry"("event_group_id");

-- Partial indexes (only non-null rows — much smaller index size)
CREATE INDEX "ledger_entry_stripe_event_id"
  ON "ledger_entry"("stripe_event_id")
  WHERE "stripe_event_id" IS NOT NULL;

CREATE INDEX "ledger_entry_stripe_object"
  ON "ledger_entry"("stripe_object_kind", "stripe_object_id")
  WHERE "stripe_object_id" IS NOT NULL;

CREATE INDEX "ledger_entry_reverses_entry_id"
  ON "ledger_entry"("reverses_entry_id")
  WHERE "reverses_entry_id" IS NOT NULL;

-- BTREE on effective_at for reconciliation date-range scans. NOTE: a BRIN
-- index here would be wrong — BRIN requires physical-order correlation with
-- the indexed column, and `effective_at` is Stripe's event.created (which
-- can be backdated on replay). Physical order tracks `posted_at` instead.
CREATE INDEX "ledger_entry_effective_at"
  ON "ledger_entry"("effective_at");

-- ── Foreign keys ─────────────────────────────────────────────────────────────
ALTER TABLE "ledger_entry"
  ADD CONSTRAINT "ledger_entry_account_fkey"
  FOREIGN KEY ("account_scope", "account_id")
  REFERENCES "accounts"("account_scope", "account_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ledger_entry"
  ADD CONSTRAINT "ledger_entry_reverses_fkey"
  FOREIGN KEY ("reverses_entry_id")
  REFERENCES "ledger_entry"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- TRIGGERS — enforce what schema syntax can't
-- =============================================================================

-- Allocate monotonic per-account sequence_no and compute running balance.
--
-- The UPDATE...RETURNING on accounts.next_sequence_no is the canonical
-- per-account serialization pattern: it takes a row-level lock on the
-- accounts row that's held until the transaction commits. Two concurrent
-- inserts for the same account serialize at this step.
--
-- ISOLATION LEVEL REQUIREMENT: this trigger is correct under Postgres'
-- default READ COMMITTED. It is NOT correct under SERIALIZABLE /
-- REPEATABLE READ — those snapshot the transaction at start, which can
-- prevent the SELECT below from seeing a predecessor entry committed by
-- another transaction during this one's lifetime. The trigger would then
-- compute running_balance starting from a stale predecessor and silently
-- produce wrong totals (the seq_no would still be unique, so the UNIQUE
-- constraint wouldn't catch it).
--
-- The application-level postTransaction service MUST NOT issue
-- `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` around ledger writes.
-- If a future requirement needs SERIALIZABLE semantics (e.g. cross-account
-- atomic operations), refactor this trigger to use `SELECT ... FOR UPDATE`
-- on the predecessor row and handle 40001 serialization_failure with
-- retry at the application layer.
--
-- (v1 lesson: libsql silently no-op'd Serializable. v2's protection is the
-- UPDATE-RETURNING row lock under READ COMMITTED, NOT the isolation level.)
CREATE OR REPLACE FUNCTION ledger_entry_assign_sequence() RETURNS TRIGGER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  prev_running_balance BIGINT;
  allocated_seq        BIGINT;
  account_currency     CHAR(3);
BEGIN
  -- Allocate sequence + read account currency in one statement.
  UPDATE accounts
     SET next_sequence_no = next_sequence_no + 1
   WHERE account_scope = NEW.account_scope
     AND account_id    = NEW.account_id
  RETURNING next_sequence_no - 1, currency
       INTO allocated_seq, account_currency;

  IF allocated_seq IS NULL THEN
    RAISE EXCEPTION 'Account %:% does not exist. Chart of accounts must be seeded; per-creator accounts must be created on first earning via application code.',
      NEW.account_scope, NEW.account_id;
  END IF;

  -- Currency match: the account is in a single currency; entries must
  -- agree. Cross-currency operations require explicit FX entries via a
  -- dedicated FX clearing account, never inline.
  IF NEW.currency <> account_currency THEN
    RAISE EXCEPTION 'Ledger entry currency % does not match account %:% currency %. Cross-currency entries are not permitted; use a dedicated FX clearing account.',
      NEW.currency, NEW.account_scope, NEW.account_id, account_currency;
  END IF;

  NEW.sequence_no := allocated_seq;

  -- Look up the previous entry's running balance. The
  -- (account_scope, account_id, sequence_no) UNIQUE index makes this an
  -- O(log n) lookup. For the very first entry (allocated_seq = 1), prev is
  -- NULL and we treat it as zero.
  SELECT running_balance_minor_units INTO prev_running_balance
    FROM public.ledger_entry
   WHERE account_scope = NEW.account_scope
     AND account_id    = NEW.account_id
     AND sequence_no   = allocated_seq - 1;

  NEW.running_balance_minor_units :=
    COALESCE(prev_running_balance, 0)
      + NEW.credit_minor_units
      - NEW.debit_minor_units;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entry_before_insert
  BEFORE INSERT ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_assign_sequence();

-- INV-6: append-only enforcement.
--
-- ledger_entry rows are immutable facts. To "modify" history, insert a
-- compensating entry with reverses_entry_id set. The DB role separation
-- (app_writer has INSERT only; ledger_admin has UPDATE/DELETE for
-- break-glass) is the primary defense; this trigger is defense-in-depth
-- against future role-grant mistakes.
CREATE OR REPLACE FUNCTION ledger_entry_reject_mutation() RETURNS TRIGGER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entry is append-only. To reverse a fact, INSERT a compensating entry with reverses_entry_id set. (Attempted operation: %)', TG_OP
    USING HINT = 'If you genuinely need to modify history (e.g. GDPR redaction), use the ledger_admin role with explicit documentation in admin_audit_log.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entry_reject_update
  BEFORE UPDATE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_reject_mutation();

CREATE TRIGGER ledger_entry_reject_delete
  BEFORE DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_reject_mutation();

-- TRUNCATE bypasses BEFORE DELETE FOR EACH ROW. A separate
-- BEFORE TRUNCATE FOR EACH STATEMENT trigger is required to make
-- append-only enforcement complete.
CREATE TRIGGER ledger_entry_reject_truncate
  BEFORE TRUNCATE ON ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entry_reject_mutation();

-- =============================================================================
-- Notes for future migrations
-- =============================================================================
-- 1. When adding new accountScope values, no schema change is needed — the
--    column is TEXT and accepts any value. Update seed.ts to add system
--    accounts, or rely on application code for per-creator accounts.
--
-- 2. When the first partition is approaching ~10M rows, partition by
--    effective_at month (see architecture §8.5). This is a non-trivial
--    migration; coordinate with downtime planning.
--
-- 3. For GDPR redaction, do NOT update ledger_entry rows. Instead, INSERT a
--    tombstone in a separate ledger_redaction table and use a view to mask
--    the underlying metadata. The underlying row stays intact for audit.
--
-- 4. Role separation: app_writer GRANT INSERT, SELECT only. Never grant
--    UPDATE or DELETE outside the ledger_admin break-glass role.
