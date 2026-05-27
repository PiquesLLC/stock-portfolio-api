-- Partial unique index: at most one pending payout per creator.
-- Physically prevents the TOCTOU double-spend that the Serializable
-- transaction in requestPayout was supposed to guard against. libsql
-- silently no-ops the Prisma isolation-level setting, so the
-- application-level pendingCount check has a race window between read
-- and write. With this partial unique index, the second concurrent
-- payout INSERT deterministically hits P2002 — which the controller
-- surfaces as 4xx. The first payout proceeds normally.
--
-- Prisma's @@unique does not support WHERE clauses; this is enforced
-- at the DB level only. A doc comment in prisma/schema.prisma's
-- CreatorPayout model points readers here.
CREATE UNIQUE INDEX "creator_payout_pending_unique"
  ON "CreatorPayout"("creatorUserId")
  WHERE "status" = 'pending';
