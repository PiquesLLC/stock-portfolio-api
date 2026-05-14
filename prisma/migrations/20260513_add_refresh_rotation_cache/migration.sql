-- CreateTable
CREATE TABLE "RefreshRotationCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "oldTokenHash" TEXT NOT NULL,
    "newTokenCipher" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefreshRotationCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "RefreshRotationCache_oldTokenHash_key" ON "RefreshRotationCache"("oldTokenHash");

-- CreateIndex
CREATE INDEX "RefreshRotationCache_userId_idx" ON "RefreshRotationCache"("userId");

-- CreateIndex
CREATE INDEX "RefreshRotationCache_createdAt_idx" ON "RefreshRotationCache"("createdAt");
