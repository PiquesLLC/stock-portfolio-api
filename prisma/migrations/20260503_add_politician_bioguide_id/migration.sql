-- CreateTable
CREATE TABLE "Politician" (
    "bioguideId" TEXT NOT NULL PRIMARY KEY,
    "canonicalName" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "chamber" TEXT,
    "party" TEXT,
    "state" TEXT,
    "nameAliases" TEXT NOT NULL DEFAULT '[]',
    "refreshedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Politician_canonicalName_key" ON "Politician"("canonicalName");
CREATE INDEX "Politician_lastName_idx" ON "Politician"("lastName");

-- AlterTable
ALTER TABLE "CongressTrade" ADD COLUMN "politicianBioguideId" TEXT REFERENCES "Politician"("bioguideId") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "CongressTrade_politicianBioguideId_idx" ON "CongressTrade"("politicianBioguideId");
