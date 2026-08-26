-- CATEGORY A — production defect. Production is MISSING objects that both the
-- migration history and schema.prisma already define, and that application code
-- actively uses:
--
--   MonitoringReport   written by admin.routes.ts and
--                      creator-stripe-reconciliation.service.ts. A call against
--                      production today fails with "no such table". It is latent
--                      only because creator monetization is disabled.
--
--   four indexes       declared in schema.prisma; absent in production.
--
-- HOW THIS HAPPENED. 20260324_add_monitoring_reports and 20260324_add_stripe_indexes
-- are recorded as applied in production, but their objects were never created —
-- the marker was written without the SQL having run.
--
-- EVERY STATEMENT IS IDEMPOTENT, and that is load-bearing in BOTH directions:
--   on production      the objects are absent, so this creates them;
--   on a fresh replay  the two 20260324 migrations already created them, so this
--                      is a no-op. A plain CREATE would repair production and
--                      then break every fresh replay.
--
-- The DDL is copied verbatim from those two historical migrations rather than
-- improvised, so a repaired production is byte-identical to a fresh replay.

-- From 20260324_add_monitoring_reports
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

-- From 20260324_add_stripe_indexes
CREATE INDEX IF NOT EXISTS "CreatorSubscription_stripeSubscriptionId_idx" ON "CreatorSubscription"("stripeSubscriptionId");
CREATE INDEX IF NOT EXISTS "CreatorPayout_stripeTransferId_idx" ON "CreatorPayout"("stripeTransferId");
CREATE INDEX IF NOT EXISTS "CreatorPayout_stripePayoutId_idx" ON "CreatorPayout"("stripePayoutId");

-- From 20260323_add_content_strikes (ContentStrike_createdAt_idx)
CREATE INDEX IF NOT EXISTS "ContentStrike_createdAt_idx" ON "ContentStrike"("createdAt");
