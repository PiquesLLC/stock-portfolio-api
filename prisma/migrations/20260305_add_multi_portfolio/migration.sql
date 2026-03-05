-- CreateTable: Portfolio
CREATE TABLE "Portfolio" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'general',
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "cashBalance" REAL NOT NULL DEFAULT 0,
    "marginDebt" REAL NOT NULL DEFAULT 0,
    "dripEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Portfolio_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Backfill: create a default portfolio for every user who has holdings or UserSettings
INSERT INTO "Portfolio" ("id", "userId", "name", "type", "isDefault", "cashBalance", "marginDebt", "dripEnabled", "createdAt", "updatedAt")
SELECT
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
    u."id",
    'Default',
    'general',
    1,
    COALESCE(us."cashBalance", 0),
    COALESCE(us."marginDebt", 0),
    COALESCE(us."dripEnabled", 0),
    COALESCE(u."createdAt", CURRENT_TIMESTAMP),
    CURRENT_TIMESTAMP
FROM "User" u
LEFT JOIN "UserSettings" us ON us."userId" = u."id"
WHERE u."id" IN (
    SELECT DISTINCT "userId" FROM "Holding" WHERE "userId" IS NOT NULL
    UNION
    SELECT "userId" FROM "UserSettings"
);

-- CreateIndex: Portfolio unique and index
CREATE UNIQUE INDEX "Portfolio_userId_name_key" ON "Portfolio"("userId", "name");
CREATE INDEX "Portfolio_userId_idx" ON "Portfolio"("userId");

-- Recreate Holding table with new schema (portfolioId column, new unique constraint)
CREATE TABLE "new_Holding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "shares" REAL NOT NULL,
    "averageCost" REAL NOT NULL,
    "source" TEXT DEFAULT 'manual',
    "holdingType" TEXT NOT NULL DEFAULT 'equity',
    "optionUnderlying" TEXT,
    "optionStrike" REAL,
    "optionExpiry" TEXT,
    "optionType" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT,
    "portfolioId" TEXT,
    CONSTRAINT "Holding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Holding_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Copy holdings, setting portfolioId from the user's default portfolio
INSERT INTO "new_Holding" ("id", "ticker", "shares", "averageCost", "source", "holdingType", "optionUnderlying", "optionStrike", "optionExpiry", "optionType", "createdAt", "updatedAt", "userId", "portfolioId")
SELECT
    h."id", h."ticker", h."shares", h."averageCost", h."source", h."holdingType",
    h."optionUnderlying", h."optionStrike", h."optionExpiry", h."optionType",
    h."createdAt", h."updatedAt", h."userId",
    p."id"
FROM "Holding" h
LEFT JOIN "Portfolio" p ON p."userId" = h."userId" AND p."isDefault" = 1;

-- Drop old table and rename
DROP TABLE "Holding";
ALTER TABLE "new_Holding" RENAME TO "Holding";

-- Recreate indexes with new unique constraint
CREATE UNIQUE INDEX "Holding_portfolioId_ticker_key" ON "Holding"("portfolioId", "ticker");
CREATE INDEX "Holding_userId_idx" ON "Holding"("userId");
