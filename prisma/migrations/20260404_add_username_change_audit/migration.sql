CREATE TABLE "UsernameChangeAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "oldUsername" TEXT NOT NULL,
    "newUsername" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsernameChangeAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "UsernameChangeAudit_userId_createdAt_idx" ON "UsernameChangeAudit"("userId", "createdAt");
CREATE INDEX "UsernameChangeAudit_newUsername_idx" ON "UsernameChangeAudit"("newUsername");
