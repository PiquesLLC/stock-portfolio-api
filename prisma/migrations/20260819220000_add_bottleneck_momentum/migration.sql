-- Weekly ranking for Discover > Bottlenecks.
--
-- One row per catalog entry per ISO week. Scores live here rather than in the
-- catalog JSONs on purpose: those files are owned by the weekly editorial cloud
-- routine, which commits them via the GitHub Contents API, so an app-side write
-- would collide with the editor's commits.
--
-- Purely additive — no existing table is touched, so this is safe to deploy
-- ahead of the feature being switched on. Until the job first runs the table is
-- empty and the endpoint serves the unranked catalog exactly as before.

-- CreateTable
CREATE TABLE "BottleneckMomentum" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entryId" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "isoWeek" TEXT NOT NULL,
    "momentum" REAL NOT NULL,
    "editorial" REAL NOT NULL,
    "score" REAL NOT NULL,
    "rank" INTEGER NOT NULL,
    "prevRank" INTEGER,
    "rankDelta" INTEGER,
    "prevIsoWeek" TEXT,
    "tickersUsed" TEXT NOT NULL DEFAULT '[]',
    "tickersMissed" TEXT NOT NULL DEFAULT '[]',
    -- No DEFAULT CURRENT_TIMESTAMP on purpose. SQLite emits
    -- 'YYYY-MM-DD HH:MM:SS', not the ISO+00:00 canonical form this database was
    -- normalised to, so an out-of-band INSERT relying on the default would
    -- reintroduce the mixed DateTime-storage bug class. The app always supplies
    -- computedAt explicitly. (Kept free of semicolons: scripts/ensure-dev-db.js
    -- splits this file on ';' with a naive regex.)
    "computedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "BottleneckMomentum_entryId_isoWeek_key" ON "BottleneckMomentum"("entryId", "isoWeek");

-- CreateIndex
CREATE INDEX "BottleneckMomentum_isoWeek_sector_idx" ON "BottleneckMomentum"("isoWeek", "sector");

-- CreateIndex
CREATE INDEX "BottleneckMomentum_entryId_idx" ON "BottleneckMomentum"("entryId");
