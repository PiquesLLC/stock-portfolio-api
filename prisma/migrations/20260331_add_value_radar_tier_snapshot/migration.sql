-- CreateTable
CREATE TABLE "ValueRadarTierSnapshot" (
    "ticker" TEXT NOT NULL PRIMARY KEY,
    "tier" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
