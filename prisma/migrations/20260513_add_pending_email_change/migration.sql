-- CreateTable
CREATE TABLE "PendingEmailChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "newEmail" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingEmailChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PendingEmailChange_userId_idx" ON "PendingEmailChange"("userId");

-- CreateIndex
CREATE INDEX "PendingEmailChange_expiresAt_idx" ON "PendingEmailChange"("expiresAt");
