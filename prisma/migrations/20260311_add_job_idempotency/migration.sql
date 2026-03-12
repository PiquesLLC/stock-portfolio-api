-- CreateTable
CREATE TABLE "JobIdempotencyKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "duplicateHits" INTEGER NOT NULL DEFAULT 0,
    "lastRunStatus" TEXT,
    "lastRunAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "JobIdempotencyKey_key_key" ON "JobIdempotencyKey"("key");

-- CreateIndex
CREATE INDEX "JobIdempotencyKey_jobName_idx" ON "JobIdempotencyKey"("jobName");

-- CreateIndex
CREATE INDEX "JobIdempotencyKey_expiresAt_idx" ON "JobIdempotencyKey"("expiresAt");

-- CreateIndex
CREATE INDEX "JobIdempotencyKey_updatedAt_idx" ON "JobIdempotencyKey"("updatedAt");
