-- SEC compliance: change tradeDelayHours default from 0 to 24
-- Also fixes ApiUsageLog/Portfolio defaults drift

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- Recreate CreatorVisibility with tradeDelayHours default 24 (was 0)
CREATE TABLE "new_CreatorVisibility" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "creatorId" TEXT NOT NULL,
    "showHoldings" BOOLEAN NOT NULL DEFAULT true,
    "showTradeHistory" BOOLEAN NOT NULL DEFAULT false,
    "showRationale" BOOLEAN NOT NULL DEFAULT false,
    "showSectors" BOOLEAN NOT NULL DEFAULT true,
    "showRiskMetrics" BOOLEAN NOT NULL DEFAULT false,
    "showWatchlists" BOOLEAN NOT NULL DEFAULT false,
    "tradeDelayHours" INTEGER NOT NULL DEFAULT 24,
    "hideShareCount" BOOLEAN NOT NULL DEFAULT false,
    "discoverable" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "CreatorVisibility_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CreatorVisibility" ("creatorId", "discoverable", "hideShareCount", "id", "showHoldings", "showRationale", "showRiskMetrics", "showSectors", "showTradeHistory", "showWatchlists", "tradeDelayHours") SELECT "creatorId", "discoverable", "hideShareCount", "id", "showHoldings", "showRationale", "showRiskMetrics", "showSectors", "showTradeHistory", "showWatchlists", "tradeDelayHours" FROM "CreatorVisibility";
DROP TABLE "CreatorVisibility";
ALTER TABLE "new_CreatorVisibility" RENAME TO "CreatorVisibility";
CREATE UNIQUE INDEX "CreatorVisibility_creatorId_key" ON "CreatorVisibility"("creatorId");

-- Migrate any existing creators with delay=0 to 24 (SEC compliance)
UPDATE "CreatorVisibility" SET "tradeDelayHours" = 24 WHERE "tradeDelayHours" = 0;

-- Fix ApiUsageLog id default (Prisma v7 uuid format)
CREATE TABLE "new_ApiUsageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsdEstimate" REAL NOT NULL DEFAULT 0,
    "userId" TEXT,
    "ticker" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_ApiUsageLog" ("costUsdEstimate", "createdAt", "durationMs", "feature", "id", "inputTokens", "model", "outputTokens", "provider", "ticker", "userId") SELECT "costUsdEstimate", "createdAt", "durationMs", "feature", "id", "inputTokens", "model", "outputTokens", "provider", "ticker", "userId" FROM "ApiUsageLog";
DROP TABLE "ApiUsageLog";
ALTER TABLE "new_ApiUsageLog" RENAME TO "ApiUsageLog";

-- Fix Portfolio isDefault default (false, not true)
CREATE TABLE "new_Portfolio" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'general',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "cashBalance" REAL NOT NULL DEFAULT 0,
    "marginDebt" REAL NOT NULL DEFAULT 0,
    "dripEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Portfolio_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Portfolio" ("cashBalance", "createdAt", "dripEnabled", "id", "isDefault", "marginDebt", "name", "type", "updatedAt", "userId") SELECT "cashBalance", "createdAt", "dripEnabled", "id", "isDefault", "marginDebt", "name", "type", "updatedAt", "userId" FROM "Portfolio";
DROP TABLE "Portfolio";
ALTER TABLE "new_Portfolio" RENAME TO "Portfolio";
CREATE INDEX "Portfolio_userId_idx" ON "Portfolio"("userId");
CREATE UNIQUE INDEX "Portfolio_userId_name_key" ON "Portfolio"("userId", "name");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
