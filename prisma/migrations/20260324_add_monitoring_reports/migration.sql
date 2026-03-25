CREATE TABLE IF NOT EXISTS "MonitoringReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "data" TEXT NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'scheduled-agent',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "MonitoringReport_type_createdAt_idx" ON "MonitoringReport"("type", "createdAt");
CREATE INDEX IF NOT EXISTS "MonitoringReport_createdAt_idx" ON "MonitoringReport"("createdAt");
