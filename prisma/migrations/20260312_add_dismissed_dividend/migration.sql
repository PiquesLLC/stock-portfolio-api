-- CreateTable
CREATE TABLE "DismissedDividend" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "dividendEventId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DismissedDividend_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DismissedDividend_dividendEventId_fkey" FOREIGN KEY ("dividendEventId") REFERENCES "DividendEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DismissedDividend_userId_idx" ON "DismissedDividend"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DismissedDividend_userId_dividendEventId_key" ON "DismissedDividend"("userId", "dividendEventId");
