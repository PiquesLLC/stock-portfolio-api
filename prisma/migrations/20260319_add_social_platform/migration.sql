-- CreateTable
CREATE TABLE "PerformanceBadge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "badge" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "earnedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    CONSTRAINT "PerformanceBadge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProfileStatsCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "winRate" REAL,
    "totalTrades" INTEGER,
    "avgHoldDays" REAL,
    "profitFactor" REAL,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProfileStatsCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Post" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "ticker" TEXT,
    "type" TEXT NOT NULL DEFAULT 'thought',
    "attachmentType" TEXT,
    "attachmentData" TEXT,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Post_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Like" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Like_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Like_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialNotification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "postId" TEXT,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SocialNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialNotification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable: Add kycVerified and kycVerifiedAt to User
ALTER TABLE "User" ADD COLUMN "kycVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "kycVerifiedAt" DATETIME;

-- CHECK constraints for Post.type
CREATE TRIGGER post_type_check
BEFORE INSERT ON "Post"
BEGIN
  SELECT CASE
    WHEN NEW."type" NOT IN ('thought', 'analysis', 'trade_idea')
    THEN RAISE(ABORT, 'Invalid post type')
  END;
END;

CREATE TRIGGER post_type_check_update
BEFORE UPDATE ON "Post"
BEGIN
  SELECT CASE
    WHEN NEW."type" NOT IN ('thought', 'analysis', 'trade_idea')
    THEN RAISE(ABORT, 'Invalid post type')
  END;
END;

-- CHECK constraints for SocialNotification.type
CREATE TRIGGER social_notif_type_check
BEFORE INSERT ON "SocialNotification"
BEGIN
  SELECT CASE
    WHEN NEW."type" NOT IN ('new_follower', 'comment', 'like', 'mention')
    THEN RAISE(ABORT, 'Invalid social notification type')
  END;
END;

CREATE TRIGGER social_notif_type_check_update
BEFORE UPDATE ON "SocialNotification"
BEGIN
  SELECT CASE
    WHEN NEW."type" NOT IN ('new_follower', 'comment', 'like', 'mention')
    THEN RAISE(ABORT, 'Invalid social notification type')
  END;
END;

-- CreateIndex
CREATE INDEX "PerformanceBadge_userId_idx" ON "PerformanceBadge"("userId");
CREATE UNIQUE INDEX "PerformanceBadge_userId_badge_window_key" ON "PerformanceBadge"("userId", "badge", "window");
CREATE UNIQUE INDEX "ProfileStatsCache_userId_key" ON "ProfileStatsCache"("userId");
CREATE INDEX "ProfileStatsCache_userId_idx" ON "ProfileStatsCache"("userId");
CREATE INDEX "Post_userId_createdAt_idx" ON "Post"("userId", "createdAt");
CREATE INDEX "Post_ticker_createdAt_idx" ON "Post"("ticker", "createdAt");
CREATE INDEX "Post_createdAt_idx" ON "Post"("createdAt");
CREATE INDEX "Comment_postId_createdAt_idx" ON "Comment"("postId", "createdAt");
CREATE INDEX "Comment_userId_idx" ON "Comment"("userId");
CREATE INDEX "Like_postId_idx" ON "Like"("postId");
CREATE INDEX "Like_userId_idx" ON "Like"("userId");
CREATE UNIQUE INDEX "Like_postId_userId_key" ON "Like"("postId", "userId");
CREATE INDEX "SocialNotification_userId_read_createdAt_idx" ON "SocialNotification"("userId", "read", "createdAt");
CREATE INDEX "SocialNotification_userId_createdAt_idx" ON "SocialNotification"("userId", "createdAt");
