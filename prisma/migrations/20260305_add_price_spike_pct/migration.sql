-- AlterTable: Add user-configurable price spike threshold
ALTER TABLE "UserSettings" ADD COLUMN "priceSpikePct" REAL NOT NULL DEFAULT 3.0;
