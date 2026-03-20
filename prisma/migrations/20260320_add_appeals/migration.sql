-- CreateTable
CREATE TABLE "Appeal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "strikeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "adminNotes" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Appeal_strikeId_fkey" FOREIGN KEY ("strikeId") REFERENCES "ContentStrike" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Appeal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Appeal_strikeId_key" ON "Appeal"("strikeId");
CREATE INDEX "Appeal_userId_idx" ON "Appeal"("userId");
CREATE INDEX "Appeal_status_idx" ON "Appeal"("status");

-- CHECK constraints for Appeal.status
CREATE TRIGGER appeal_status_check
BEFORE INSERT ON "Appeal"
BEGIN
  SELECT CASE
    WHEN NEW."status" NOT IN ('pending', 'reviewing', 'upheld', 'overturned')
    THEN RAISE(ABORT, 'Invalid appeal status')
  END;
END;

CREATE TRIGGER appeal_status_check_update
BEFORE UPDATE ON "Appeal"
BEGIN
  SELECT CASE
    WHEN NEW."status" NOT IN ('pending', 'reviewing', 'upheld', 'overturned')
    THEN RAISE(ABORT, 'Invalid appeal status')
  END;
END;
