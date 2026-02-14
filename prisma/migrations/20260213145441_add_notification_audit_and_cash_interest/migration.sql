-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN "cashInterestRate" REAL NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "cashInterestRate" REAL NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "NotificationAuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "channel" TEXT,
    "title" TEXT,
    "message" TEXT,
    "refKey" TEXT,
    "payload" TEXT,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NotificationAuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "NotificationAuditLog_userId_type_sentAt_idx" ON "NotificationAuditLog"("userId", "type", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationAuditLog_userId_type_refKey_key" ON "NotificationAuditLog"("userId", "type", "refKey");
