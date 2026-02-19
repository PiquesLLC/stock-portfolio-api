-- CreateTable
CREATE TABLE "BillingWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "planExpiresAt" DATETIME,
    "planStartedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trackingActive" BOOLEAN NOT NULL DEFAULT false,
    "trackingStartAt" DATETIME,
    "leaderboardEligible" BOOLEAN NOT NULL DEFAULT false,
    "leaderboardEligibleAt" DATETIME,
    "profilePublic" BOOLEAN NOT NULL DEFAULT true,
    "region" TEXT,
    "showRegion" BOOLEAN NOT NULL DEFAULT true,
    "holdingsVisibility" TEXT NOT NULL DEFAULT 'all',
    "bio" TEXT,
    "email" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_User" ("bio", "createdAt", "displayName", "email", "emailVerified", "holdingsVisibility", "id", "leaderboardEligible", "leaderboardEligibleAt", "passwordHash", "profilePublic", "region", "showRegion", "trackingActive", "trackingStartAt", "username") SELECT "bio", "createdAt", "displayName", "email", "emailVerified", "holdingsVisibility", "id", "leaderboardEligible", "leaderboardEligibleAt", "passwordHash", "profilePublic", "region", "showRegion", "trackingActive", "trackingStartAt", "username" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "BillingWebhookEvent_eventId_key" ON "BillingWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "BillingWebhookEvent_processedAt_idx" ON "BillingWebhookEvent"("processedAt");
