-- CreateTable: DevicePushToken
CREATE TABLE "DevicePushToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DevicePushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "DevicePushToken_token_key" ON "DevicePushToken"("token");

-- CreateIndex
CREATE INDEX "DevicePushToken_userId_idx" ON "DevicePushToken"("userId");

-- AlterTable: User - add Apple IAP fields
ALTER TABLE "User" ADD COLUMN "appleOriginalTransactionId" TEXT;
ALTER TABLE "User" ADD COLUMN "applePurchaseSource" TEXT;

-- CreateTable: AppleIAPWebhookEvent
CREATE TABLE "AppleIAPWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "notificationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "AppleIAPWebhookEvent_notificationId_key" ON "AppleIAPWebhookEvent"("notificationId");

-- CreateIndex: unique constraint on appleOriginalTransactionId (prevents transaction replay)
CREATE UNIQUE INDEX "User_appleOriginalTransactionId_key" ON "User"("appleOriginalTransactionId");
