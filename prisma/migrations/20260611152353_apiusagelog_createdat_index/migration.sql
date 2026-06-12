-- M6: index ApiUsageLog.createdAt so the AI spend breaker's rolling-24h
-- aggregate (and the 30-day retention sweep) don't table-scan.
CREATE INDEX IF NOT EXISTS "ApiUsageLog_createdAt_idx" ON "ApiUsageLog"("createdAt");
