-- CreateTable
CREATE TABLE "CongressTrade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "politician" TEXT NOT NULL,
    "chamber" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "transactionType" TEXT NOT NULL,
    "amountFrom" REAL NOT NULL,
    "amountTo" REAL NOT NULL,
    "tradeDate" DATETIME NOT NULL,
    "filingDate" DATETIME NOT NULL,
    "assetName" TEXT,
    "ownerType" TEXT,
    "source" TEXT NOT NULL DEFAULT 'finnhub',
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "CongressTrade_ticker_idx" ON "CongressTrade"("ticker");

-- CreateIndex
CREATE INDEX "CongressTrade_tradeDate_idx" ON "CongressTrade"("tradeDate");

-- CreateIndex
CREATE INDEX "CongressTrade_fetchedAt_idx" ON "CongressTrade"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CongressTrade_politician_ticker_tradeDate_transactionType_key" ON "CongressTrade"("politician", "ticker", "tradeDate", "transactionType");
