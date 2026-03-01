-- CreateTable
CREATE TABLE "ScreenerCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "eps" REAL,
    "annualDividend" REAL,
    "beta" REAL,
    "week52High" REAL,
    "week52Low" REAL,
    "lastFetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ScreenerCache_ticker_key" ON "ScreenerCache"("ticker");

-- CreateIndex
CREATE INDEX "ScreenerCache_ticker_idx" ON "ScreenerCache"("ticker");

-- CreateIndex
CREATE INDEX "ScreenerCache_lastFetchedAt_idx" ON "ScreenerCache"("lastFetchedAt");
