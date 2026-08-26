-- Server-issued opaque StoreKit account token.
--
-- ADDITIVE ONLY. "User" is ~1.38 GB in production: ALTER TABLE ... ADD COLUMN is
-- an O(1) metadata change, while a table rebuild would copy every row under an
-- exclusive lock. Nothing here may become a RedefineTables.
--
-- The column is nullable and is NOT backfilled. Production has zero Apple
-- subscribers, so minting 29 unused Apple identifiers would create durable
-- purchase-binding identifiers for accounts that will never use them. The token
-- is generated lazily, on the first authenticated purchase-context request.
--
-- The unique index is what makes token -> user resolution safe: it guarantees a
-- verified appAccountToken can resolve to at most one account, so ownership can
-- never be ambiguous.
ALTER TABLE "User" ADD COLUMN "appleAppAccountToken" TEXT;

CREATE UNIQUE INDEX "User_appleAppAccountToken_key" ON "User"("appleAppAccountToken");
