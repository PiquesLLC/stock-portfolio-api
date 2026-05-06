-- Add archived flag + timestamp to DeepResearchJob so users can soft-hide
-- finished reports without losing the data. Default false keeps every existing
-- row visible. The (userId, archived) index keeps the default list query
-- (`WHERE userId = ? AND archived = false`) on a covering index.

-- AlterTable
ALTER TABLE "DeepResearchJob" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DeepResearchJob" ADD COLUMN "archivedAt" DATETIME;

-- CreateIndex
CREATE INDEX "DeepResearchJob_userId_archived_idx" ON "DeepResearchJob"("userId", "archived");
