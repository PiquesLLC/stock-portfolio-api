-- CreateTable
CREATE TABLE "StockFollow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockFollow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "StockFollow_symbol_idx" ON "StockFollow"("symbol");

-- CreateIndex
CREATE INDEX "StockFollow_userId_idx" ON "StockFollow"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StockFollow_userId_symbol_key" ON "StockFollow"("userId", "symbol");
