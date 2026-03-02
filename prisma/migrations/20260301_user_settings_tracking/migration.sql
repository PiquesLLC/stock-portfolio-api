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

-- Migrate existing data from global Settings to Jon's UserSettings
INSERT OR IGNORE INTO "UserSettings" ("id", "userId", "cashBalance", "marginDebt", "updatedAt")
SELECT 'migration-seed', 'a7d26fc5-514f-4d80-8f8c-25c8e92d41df', 0, 0, datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM "UserSettings" WHERE "userId" = 'a7d26fc5-514f-4d80-8f8c-25c8e92d41df');

UPDATE "UserSettings"
SET
  "trackingStartDate" = (SELECT "trackingStartDate" FROM "Settings" WHERE "id" = 'default'),
  "baselineTotalValue" = (SELECT "baselineTotalValue" FROM "Settings" WHERE "id" = 'default'),
  "baselineCashBalance" = (SELECT "baselineCashBalance" FROM "Settings" WHERE "id" = 'default'),
  "baselineType" = (SELECT "baselineType" FROM "Settings" WHERE "id" = 'default'),
  "brokerLifetimeDeposits" = (SELECT "brokerLifetimeDeposits" FROM "Settings" WHERE "id" = 'default'),
  "brokerLifetimeWithdrawals" = (SELECT "brokerLifetimeWithdrawals" FROM "Settings" WHERE "id" = 'default'),
  "brokerLifetimeValue" = (SELECT "brokerLifetimeValue" FROM "Settings" WHERE "id" = 'default'),
  "brokerLifetimeAsOf" = (SELECT "brokerLifetimeAsOf" FROM "Settings" WHERE "id" = 'default'),
  "ytdStartEquity" = (SELECT "ytdStartEquity" FROM "Settings" WHERE "id" = 'default'),
  "ytdNetContributions" = (SELECT "ytdNetContributions" FROM "Settings" WHERE "id" = 'default')
WHERE "userId" = 'a7d26fc5-514f-4d80-8f8c-25c8e92d41df';
