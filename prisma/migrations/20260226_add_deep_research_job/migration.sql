-- CreateTable
CREATE TABLE "DeepResearchJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "ticker" TEXT,
    "prompt" TEXT NOT NULL,
    "researchType" TEXT NOT NULL DEFAULT 'stock',
    "clientRequestId" TEXT,
    "geminiInteractionId" TEXT,
    "parentInteractionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "resultJson" TEXT,
    "resultText" TEXT,
    "rawResultPayload" TEXT,
    "parseError" TEXT,
    "errorMessage" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "searchCalls" INTEGER,
    "costUsdEstimate" REAL,
    "modelUsed" TEXT,
    "polledBy" TEXT,
    "leaseUntil" DATETIME,
    "pollCount" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeepResearchJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DeepResearchJob_userId_createdAt_idx" ON "DeepResearchJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "DeepResearchJob_userId_status_idx" ON "DeepResearchJob"("userId", "status");

-- CreateIndex
CREATE INDEX "DeepResearchJob_status_idx" ON "DeepResearchJob"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DeepResearchJob_userId_clientRequestId_key" ON "DeepResearchJob"("userId", "clientRequestId");
