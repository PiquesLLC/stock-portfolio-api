-- Enforce case-insensitive uniqueness on User.username at the DB level.
-- This closes a race window where two concurrent signups/renames with
-- case-variant usernames (e.g., "alice" and "Alice") could both succeed
-- because the existing `username @unique` constraint is case-sensitive.
--
-- If this migration fails due to pre-existing case-duplicates, investigate
-- via: SELECT LOWER(username) AS k, COUNT(*) FROM "User" GROUP BY k HAVING COUNT(*) > 1;
-- and resolve duplicates before re-running.
CREATE UNIQUE INDEX "User_username_lower_idx" ON "User"(LOWER("username"));
