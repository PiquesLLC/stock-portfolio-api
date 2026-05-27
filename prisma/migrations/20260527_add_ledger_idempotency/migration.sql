-- Backfill payout descriptions that previously collided on the constant string.
-- 'Payout requested' was used for every payout regardless of payout id, so any
-- creator with >1 payout would block the unique index. Rewriting to
-- 'payout:<rowid>' makes each one distinct.
UPDATE "CreatorWalletLedger"
SET description = 'payout:' || rowid
WHERE type = 'payout' AND description = 'Payout requested';

-- Backfill admin_fix descriptions (admin/fix-creator-ledger used constant
-- strings; same collision risk if the endpoint was used more than once for the
-- same creator).
UPDATE "CreatorWalletLedger"
SET description = description || ':' || rowid
WHERE description IN ('admin_fix:initial_payment', 'admin_fix:platform_fee');

-- Safety net: any other (creatorUserId, description) duplicates get a rowid
-- suffix on all but the first row. Should be no-op in practice; defends
-- against unknown historical writes.
UPDATE "CreatorWalletLedger"
SET description = description || ':dup:' || rowid
WHERE id IN (
  SELECT l1.id FROM "CreatorWalletLedger" l1
  JOIN "CreatorWalletLedger" l2
    ON l1."creatorUserId" = l2."creatorUserId"
   AND l1.description     = l2.description
   AND l1.description IS NOT NULL
   AND l1.rowid > l2.rowid
);

-- The unique index. If any duplicate survived the backfills above, this
-- statement fails and the migration is marked failed by Prisma; the data
-- updates above will need to be inspected and the migration re-run.
CREATE UNIQUE INDEX "creator_wallet_ledger_creator_desc_unique"
  ON "CreatorWalletLedger"("creatorUserId", "description");
