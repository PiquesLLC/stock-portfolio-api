-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CreatorVisibility" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "creatorId" TEXT NOT NULL,
    "showHoldings" BOOLEAN NOT NULL DEFAULT true,
    "showTradeHistory" BOOLEAN NOT NULL DEFAULT false,
    "showRationale" BOOLEAN NOT NULL DEFAULT false,
    "showSectors" BOOLEAN NOT NULL DEFAULT true,
    "showRiskMetrics" BOOLEAN NOT NULL DEFAULT false,
    "showWatchlists" BOOLEAN NOT NULL DEFAULT false,
    "tradeDelayHours" INTEGER NOT NULL DEFAULT 0,
    "hideShareCount" BOOLEAN NOT NULL DEFAULT false,
    "discoverable" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "CreatorVisibility_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CreatorVisibility" ("creatorId", "hideShareCount", "id", "showHoldings", "showRationale", "showRiskMetrics", "showSectors", "showTradeHistory", "showWatchlists", "tradeDelayHours") SELECT "creatorId", "hideShareCount", "id", "showHoldings", "showRationale", "showRiskMetrics", "showSectors", "showTradeHistory", "showWatchlists", "tradeDelayHours" FROM "CreatorVisibility";
DROP TABLE "CreatorVisibility";
ALTER TABLE "new_CreatorVisibility" RENAME TO "CreatorVisibility";
CREATE UNIQUE INDEX "CreatorVisibility_creatorId_key" ON "CreatorVisibility"("creatorId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
