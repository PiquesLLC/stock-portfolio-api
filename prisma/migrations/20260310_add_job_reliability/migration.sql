-- CreateTable
CREATE TABLE "BackgroundJobRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "error" TEXT,
    "durationMs" INTEGER,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "DeadLetterEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobName" TEXT NOT NULL,
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "context" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "BackgroundJobRun_jobName_idx" ON "BackgroundJobRun"("jobName");

-- CreateIndex
CREATE INDEX "BackgroundJobRun_status_idx" ON "BackgroundJobRun"("status");

-- CreateIndex
CREATE INDEX "BackgroundJobRun_startedAt_idx" ON "BackgroundJobRun"("startedAt");

-- CreateIndex
CREATE INDEX "DeadLetterEntry_jobName_idx" ON "DeadLetterEntry"("jobName");

-- CreateIndex
CREATE INDEX "DeadLetterEntry_resolved_idx" ON "DeadLetterEntry"("resolved");

-- CreateIndex
CREATE INDEX "DeadLetterEntry_createdAt_idx" ON "DeadLetterEntry"("createdAt");
