-- CreateTable
CREATE TABLE "Billionaire" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "photoUrl" TEXT,
    "company" TEXT NOT NULL,
    "title" TEXT,
    "country" TEXT NOT NULL DEFAULT 'US',
    "industry" TEXT,
    "baseNetWorthUsd" REAL NOT NULL,
    "holdings" TEXT NOT NULL,
    "computedNetWorth" REAL,
    "dayChange" REAL,
    "dayChangePct" REAL,
    "weekChange" REAL,
    "monthChange" REAL,
    "ytdChange" REAL,
    "computedAt" DATETIME,
    "rank" INTEGER,
    "previousRank" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "lastVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BillionaireSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "billionaireId" TEXT NOT NULL,
    "netWorth" REAL NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillionaireSnapshot_billionaireId_fkey" FOREIGN KEY ("billionaireId") REFERENCES "Billionaire" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WealthDistribution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "percentile" TEXT NOT NULL,
    "netWorthUsd" REAL NOT NULL,
    "date" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'fred',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Billionaire_name_key" ON "Billionaire"("name");
CREATE UNIQUE INDEX "Billionaire_slug_key" ON "Billionaire"("slug");
CREATE INDEX "Billionaire_rank_idx" ON "Billionaire"("rank");
CREATE INDEX "Billionaire_computedNetWorth_idx" ON "Billionaire"("computedNetWorth");
CREATE INDEX "BillionaireSnapshot_billionaireId_timestamp_idx" ON "BillionaireSnapshot"("billionaireId", "timestamp");
CREATE UNIQUE INDEX "WealthDistribution_percentile_date_key" ON "WealthDistribution"("percentile", "date");
