-- CreateTable
CREATE TABLE "ScreenerUniverse" (
    "ticker" TEXT NOT NULL PRIMARY KEY,
    "themesJson" TEXT,
    "source" TEXT NOT NULL DEFAULT 'finviz',
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ScreenerUniverse_source_idx" ON "ScreenerUniverse"("source");
