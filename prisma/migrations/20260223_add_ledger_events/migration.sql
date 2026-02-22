-- CreateTable
CREATE TABLE "LedgerEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "effectiveDate" DATETIME NOT NULL,
    "settleDate" DATETIME,
    "ticker" TEXT,
    "shares" REAL,
    "price" REAL,
    "amount" REAL NOT NULL,
    "fees" REAL NOT NULL DEFAULT 0,
    "rowIndex" INTEGER NOT NULL DEFAULT 0,
    "sourceBroker" TEXT,
    "sourceFileId" TEXT,
    "rawAction" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEvent_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,

    -- DB-level enum enforcement (SQLite CHECK constraints)
    CONSTRAINT "LedgerEvent_eventType_check"
      CHECK ("eventType" IN (
        'DEPOSIT','WITHDRAWAL','CASH_DIVIDEND','DIV_REINVEST',
        'INTEREST','FEE','MARGIN_BORROW','MARGIN_REPAY'
      )),

    CONSTRAINT "LedgerEvent_sourceBroker_check"
      CHECK ("sourceBroker" IS NULL OR "sourceBroker" IN (
        'robinhood','schwab','mapped','plaid','unknown'
      ))
);

-- CreateIndex
CREATE INDEX "LedgerEvent_userId_effectiveDate_rowIndex_createdAt_id_idx"
  ON "LedgerEvent"("userId", "effectiveDate", "rowIndex", "createdAt", "id");

-- CreateIndex
CREATE INDEX "LedgerEvent_userId_eventType_idx"
  ON "LedgerEvent"("userId", "eventType");

-- CreateIndex
CREATE INDEX "LedgerEvent_sourceFileId_idx"
  ON "LedgerEvent"("sourceFileId");
