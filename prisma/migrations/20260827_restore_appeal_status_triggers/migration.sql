-- Restore the two Appeal.status enforcement triggers.
--
-- 20260320_add_appeals defines both. Production has neither: that migration
-- failed partway, was marked rolled back, and scripts/start.sh then resolved it
-- as applied on every boot WITHOUT re-executing its SQL. The table and its three
-- indexes exist (the startup fallback block creates those), so the gap was
-- invisible to a table/column/index audit — triggers were never enumerated.
--
-- Net effect: Appeal.status has had no database-level enforcement in production.
-- Appeal currently holds zero rows, so nothing needs cleaning up; this restores
-- the intended constraint only.
--
-- IF NOT EXISTS makes this a no-op on any database where 20260320_add_appeals
-- did execute, including a fresh replay of the full migration history.
-- The bodies below are character-for-character the definitions in
-- 20260320_add_appeals, so a repaired database and a fresh replay agree.

CREATE TRIGGER IF NOT EXISTS appeal_status_check
BEFORE INSERT ON "Appeal"
BEGIN
  SELECT CASE
    WHEN NEW."status" NOT IN ('pending', 'reviewing', 'upheld', 'overturned')
    THEN RAISE(ABORT, 'Invalid appeal status')
  END;
END;

CREATE TRIGGER IF NOT EXISTS appeal_status_check_update
BEFORE UPDATE ON "Appeal"
BEGIN
  SELECT CASE
    WHEN NEW."status" NOT IN ('pending', 'reviewing', 'upheld', 'overturned')
    THEN RAISE(ABORT, 'Invalid appeal status')
  END;
END;
