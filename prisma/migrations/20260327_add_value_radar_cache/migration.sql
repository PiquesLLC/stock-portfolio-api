-- CreateTable
CREATE TABLE "ValueRadarCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "avgPE" REAL,
    "peHistoryJson" TEXT,
    "yearsOfData" INTEGER,
    "lastFetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ValueRadarCache_ticker_key" ON "ValueRadarCache"("ticker");

-- CreateIndex
CREATE INDEX "ValueRadarCache_ticker_idx" ON "ValueRadarCache"("ticker");

-- CreateIndex
CREATE INDEX "ValueRadarCache_lastFetchedAt_idx" ON "ValueRadarCache"("lastFetchedAt");
