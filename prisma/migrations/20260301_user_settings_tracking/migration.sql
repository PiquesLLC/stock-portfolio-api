-- AlterTable: Add per-user tracking fields to UserSettings (migrated from global Settings singleton)
ALTER TABLE "UserSettings" ADD COLUMN "baselineCashBalance" REAL;
ALTER TABLE "UserSettings" ADD COLUMN "baselineTotalValue" REAL;
ALTER TABLE "UserSettings" ADD COLUMN "baselineType" TEXT;
ALTER TABLE "UserSettings" ADD COLUMN "brokerLifetimeAsOf" DATETIME;
ALTER TABLE "UserSettings" ADD COLUMN "brokerLifetimeDeposits" REAL;
ALTER TABLE "UserSettings" ADD COLUMN "brokerLifetimeValue" REAL;
ALTER TABLE "UserSettings" ADD COLUMN "brokerLifetimeWithdrawals" REAL;
ALTER TABLE "UserSettings" ADD COLUMN "trackingStartDate" DATETIME;
ALTER TABLE "UserSettings" ADD COLUMN "ytdNetContributions" REAL;
ALTER TABLE "UserSettings" ADD COLUMN "ytdStartEquity" REAL;

-- Migrate existing data from global Settings to ALL users who have a UserSettings row.
-- If the global Settings singleton exists, copy its values to every user's settings.
-- This is idempotent — columns default to NULL, and this UPDATE only overwrites NULLs
-- for users who haven't already been migrated.
UPDATE "UserSettings"
SET
  "trackingStartDate" = COALESCE("trackingStartDate", (SELECT "trackingStartDate" FROM "Settings" WHERE "id" = 'default')),
  "baselineTotalValue" = COALESCE("baselineTotalValue", (SELECT "baselineTotalValue" FROM "Settings" WHERE "id" = 'default')),
  "baselineCashBalance" = COALESCE("baselineCashBalance", (SELECT "baselineCashBalance" FROM "Settings" WHERE "id" = 'default')),
  "baselineType" = COALESCE("baselineType", (SELECT "baselineType" FROM "Settings" WHERE "id" = 'default')),
  "brokerLifetimeDeposits" = COALESCE("brokerLifetimeDeposits", (SELECT "brokerLifetimeDeposits" FROM "Settings" WHERE "id" = 'default')),
  "brokerLifetimeWithdrawals" = COALESCE("brokerLifetimeWithdrawals", (SELECT "brokerLifetimeWithdrawals" FROM "Settings" WHERE "id" = 'default')),
  "brokerLifetimeValue" = COALESCE("brokerLifetimeValue", (SELECT "brokerLifetimeValue" FROM "Settings" WHERE "id" = 'default')),
  "brokerLifetimeAsOf" = COALESCE("brokerLifetimeAsOf", (SELECT "brokerLifetimeAsOf" FROM "Settings" WHERE "id" = 'default')),
  "ytdStartEquity" = COALESCE("ytdStartEquity", (SELECT "ytdStartEquity" FROM "Settings" WHERE "id" = 'default')),
  "ytdNetContributions" = COALESCE("ytdNetContributions", (SELECT "ytdNetContributions" FROM "Settings" WHERE "id" = 'default'))
WHERE EXISTS (SELECT 1 FROM "Settings" WHERE "id" = 'default');
