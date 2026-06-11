-- H1 fix: single-purpose email OTP codes.
-- Adds EmailOtpCode.purpose so every issuer stamps the flow that minted the
-- code and every consumer filters on it (an email-verification code can no
-- longer be replayed against the unauthenticated password reset, etc.).
-- Existing rows get purpose 'legacy', which no consumer accepts.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EmailOtpCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'legacy',
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailOtpCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_EmailOtpCode" ("codeHash", "createdAt", "expiresAt", "id", "usedAt", "userId") SELECT "codeHash", "createdAt", "expiresAt", "id", "usedAt", "userId" FROM "EmailOtpCode";
DROP TABLE "EmailOtpCode";
ALTER TABLE "new_EmailOtpCode" RENAME TO "EmailOtpCode";
CREATE INDEX "EmailOtpCode_userId_purpose_idx" ON "EmailOtpCode"("userId", "purpose");
CREATE INDEX "EmailOtpCode_expiresAt_idx" ON "EmailOtpCode"("expiresAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Belt-and-braces: pre-migration codes have unknown purpose, so retire any
-- that are still unconsumed rather than guessing what they were issued for.
-- ('legacy' purpose already makes them unmatchable; this makes it explicit.)
UPDATE "EmailOtpCode" SET "usedAt" = CURRENT_TIMESTAMP WHERE "usedAt" IS NULL;
