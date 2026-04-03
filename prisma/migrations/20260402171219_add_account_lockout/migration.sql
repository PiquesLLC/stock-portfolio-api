-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
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
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "googleId" TEXT,
    "appleId" TEXT,
    "avatarUrl" TEXT,
    "referredBy" TEXT,
    "appleOriginalTransactionId" TEXT,
    "applePurchaseSource" TEXT,
    "kycVerified" BOOLEAN NOT NULL DEFAULT false,
    "kycVerifiedAt" DATETIME,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "suspendedAt" DATETIME,
    CONSTRAINT "User_referredBy_fkey" FOREIGN KEY ("referredBy") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_User" ("appleId", "appleOriginalTransactionId", "applePurchaseSource", "avatarUrl", "bio", "createdAt", "displayName", "email", "emailVerified", "googleId", "holdingsVisibility", "id", "kycVerified", "kycVerifiedAt", "leaderboardEligible", "leaderboardEligibleAt", "passwordHash", "plan", "planExpiresAt", "planStartedAt", "profilePublic", "referredBy", "region", "showRegion", "stripeCustomerId", "stripeSubscriptionId", "suspended", "suspendedAt", "trackingActive", "trackingStartAt", "username") SELECT "appleId", "appleOriginalTransactionId", "applePurchaseSource", "avatarUrl", "bio", "createdAt", "displayName", "email", "emailVerified", "googleId", "holdingsVisibility", "id", "kycVerified", "kycVerifiedAt", "leaderboardEligible", "leaderboardEligibleAt", "passwordHash", "plan", "planExpiresAt", "planStartedAt", "profilePublic", "referredBy", "region", "showRegion", "stripeCustomerId", "stripeSubscriptionId", "suspended", "suspendedAt", "trackingActive", "trackingStartAt", "username" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
CREATE UNIQUE INDEX "User_appleId_key" ON "User"("appleId");
CREATE UNIQUE INDEX "User_appleOriginalTransactionId_key" ON "User"("appleOriginalTransactionId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
