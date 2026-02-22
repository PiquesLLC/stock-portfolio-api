-- CreateTable
CREATE TABLE "Holding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "shares" REAL NOT NULL,
    "averageCost" REAL NOT NULL,
    "source" TEXT DEFAULT 'manual',
    "holdingType" TEXT NOT NULL DEFAULT 'equity',
    "optionUnderlying" TEXT,
    "optionStrike" REAL,
    "optionExpiry" TEXT,
    "optionType" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT,
    CONSTRAINT "Holding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalValue" REAL NOT NULL,
    "cashBalance" REAL NOT NULL,
    "dailyPL" REAL NOT NULL,
    "dailyPLPercent" REAL NOT NULL,
    "totalPL" REAL NOT NULL,
    "totalPLPercent" REAL NOT NULL,
    "netEquity" REAL,
    "userId" TEXT,
    CONSTRAINT "PortfolioSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PortfolioCompositionChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "reason" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PortfolioCompositionChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
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
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "googleId" TEXT,
    "appleId" TEXT,
    "avatarUrl" TEXT,
    "referredBy" TEXT,
    CONSTRAINT "User_referredBy_fkey" FOREIGN KEY ("referredBy") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Watchlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#00C805',
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Watchlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WatchlistHolding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "watchlistId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "shares" REAL NOT NULL,
    "averageCost" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WatchlistHolding_watchlistId_fkey" FOREIGN KEY ("watchlistId") REFERENCES "Watchlist" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "family" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "consentedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsentRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MfaMethod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "secretCiphertext" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MfaMethod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MfaChallenge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MfaChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MfaBackupCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MfaBackupCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EmailOtpCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailOtpCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "cashBalance" REAL NOT NULL DEFAULT 0,
    "marginDebt" REAL NOT NULL DEFAULT 0,
    "dripEnabled" BOOLEAN NOT NULL DEFAULT false,
    "cashInterestRate" REAL NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "cashBalance" REAL NOT NULL DEFAULT 0,
    "marginDebt" REAL NOT NULL DEFAULT 0,
    "cashInterestRate" REAL NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    "trackingStartDate" DATETIME,
    "baselineTotalValue" REAL,
    "baselineCashBalance" REAL,
    "baselineType" TEXT,
    "brokerLifetimeDeposits" REAL,
    "brokerLifetimeWithdrawals" REAL,
    "brokerLifetimeValue" REAL,
    "brokerLifetimeAsOf" DATETIME,
    "ytdStartEquity" REAL,
    "ytdNetContributions" REAL,
    "dripEnabled" BOOLEAN NOT NULL DEFAULT false
);

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

-- CreateTable
CREATE TABLE "HoldingSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "shares" REAL NOT NULL,
    "price" REAL NOT NULL,
    "marketValue" REAL NOT NULL,
    "dayPL" REAL NOT NULL,
    "dayPLPercent" REAL NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DividendEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "exDate" DATETIME NOT NULL,
    "recordDate" DATETIME,
    "payDate" DATETIME NOT NULL,
    "amountPerShare" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "dividendType" TEXT NOT NULL DEFAULT 'regular',
    "source" TEXT NOT NULL DEFAULT 'yahoo',
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DividendCredit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "ticker" TEXT NOT NULL,
    "dividendEventId" TEXT NOT NULL,
    "sharesEligible" REAL NOT NULL,
    "amountGross" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "creditedAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DividendCredit_dividendEventId_fkey" FOREIGN KEY ("dividendEventId") REFERENCES "DividendEvent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DividendCredit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DividendReinvestment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "dividendCreditId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "sharesPurchased" REAL NOT NULL,
    "pricePerShare" REAL NOT NULL,
    "totalAmount" REAL NOT NULL,
    "fillDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DividendReinvestment_dividendCreditId_fkey" FOREIGN KEY ("dividendCreditId") REFERENCES "DividendCredit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DividendReinvestment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Lot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "ticker" TEXT NOT NULL,
    "shares" REAL NOT NULL,
    "costPerShare" REAL NOT NULL,
    "totalCost" REAL NOT NULL,
    "acquiredAt" DATETIME NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Lot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetValue" REAL NOT NULL,
    "monthlyContribution" REAL NOT NULL DEFAULT 0,
    "deadline" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Goal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Follow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "followerId" TEXT NOT NULL,
    "followingId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Follow_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockFollow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockFollow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActivityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "date" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "threshold" REAL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Alert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "alertId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AlertEvent_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LeaderboardCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "twrPct" REAL,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flagReason" TEXT,
    "isNew" BOOLEAN NOT NULL DEFAULT false,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaderboardCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PriceAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "ticker" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "targetPrice" REAL,
    "percentChange" REAL,
    "referencePrice" REAL,
    "referencePriceType" TEXT,
    "repeatAlert" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" DATETIME,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "triggered" BOOLEAN NOT NULL DEFAULT false,
    "triggeredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PriceAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PriceAlertEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "priceAlertId" TEXT NOT NULL,
    "triggerPrice" REAL NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceAlertEvent_priceAlertId_fkey" FOREIGN KEY ("priceAlertId") REFERENCES "PriceAlert" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnalystSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "targetHigh" REAL,
    "targetLow" REAL,
    "targetMean" REAL,
    "targetMedian" REAL,
    "strongBuy" INTEGER,
    "buy" INTEGER,
    "hold" INTEGER,
    "sell" INTEGER,
    "strongSell" INTEGER,
    "lastUpdated" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AnalystEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "changePct" REAL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FundamentalsCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "overviewJson" TEXT,
    "incomeJson" TEXT,
    "balanceJson" TEXT,
    "cashFlowJson" TEXT,
    "earningsJson" TEXT,
    "lastFetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EconomicIndicatorCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "indicator" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "latestValue" REAL,
    "latestDate" TEXT,
    "historyJson" TEXT NOT NULL DEFAULT '[]',
    "lastFetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AVDailyUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "tickers" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MilestoneEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "currentPrice" REAL NOT NULL,
    "thresholdPrice" REAL NOT NULL,
    "isNewRecord" BOOLEAN NOT NULL DEFAULT false,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MilestoneEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnomalyEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "ticker" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "analysis" TEXT,
    "citations" TEXT,
    "value" REAL,
    "threshold" REAL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnomalyEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlaidItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "plaidItemId" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "institutionId" TEXT,
    "institutionName" TEXT,
    "consentExpiresAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'active',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlaidItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlaidAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "plaidItemId" TEXT NOT NULL,
    "plaidAccountId" TEXT NOT NULL,
    "name" TEXT,
    "officialName" TEXT,
    "type" TEXT,
    "subtype" TEXT,
    "mask" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlaidAccount_plaidItemId_fkey" FOREIGN KEY ("plaidItemId") REFERENCES "PlaidItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BillingWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Creator" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "pitch" TEXT,
    "pricingCents" INTEGER NOT NULL DEFAULT 500,
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "stripeConnectId" TEXT,
    "stripeConnectOnboarded" BOOLEAN NOT NULL DEFAULT false,
    "complianceAcceptedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Creator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CreatorVisibility" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "creatorId" TEXT NOT NULL,
    "showHoldings" BOOLEAN NOT NULL DEFAULT true,
    "showTradeHistory" BOOLEAN NOT NULL DEFAULT false,
    "showRationale" BOOLEAN NOT NULL DEFAULT false,
    "showSectors" BOOLEAN NOT NULL DEFAULT true,
    "showRiskMetrics" BOOLEAN NOT NULL DEFAULT false,
    "showWatchlists" BOOLEAN NOT NULL DEFAULT false,
    "tradeDelayHours" INTEGER NOT NULL DEFAULT 0,
    "hideShareCount" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "CreatorVisibility_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CreatorSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subscriberUserId" TEXT NOT NULL,
    "creatorUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "stripeSubscriptionId" TEXT,
    "currentPeriodEnd" DATETIME,
    "trialEnd" DATETIME,
    "disputedAt" DATETIME,
    "canceledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CreatorSubscription_subscriberUserId_fkey" FOREIGN KEY ("subscriberUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CreatorSubscription_creatorUserId_fkey" FOREIGN KEY ("creatorUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CreatorSubscriptionEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subscriptionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreatorSubscriptionEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "CreatorSubscription" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CreatorWalletLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "creatorUserId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "subscriptionId" TEXT,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreatorWalletLedger_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "CreatorSubscription" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CreatorPayout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "creatorUserId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stripeTransferId" TEXT,
    "stripePayoutId" TEXT,
    "paidAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CreatorReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reporterUserId" TEXT NOT NULL,
    "creatorUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CreatorReport_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CreatorWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UserReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reporterUserId" TEXT NOT NULL,
    "reportedUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "context" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserReport_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UserReport_reportedUserId_fkey" FOREIGN KEY ("reportedUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PortfolioTrade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "ticker" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "shares" REAL NOT NULL,
    "price" REAL NOT NULL DEFAULT 0,
    "rowIndex" INTEGER NOT NULL DEFAULT 0,
    "sourceFileId" TEXT,
    "sourceBroker" TEXT,
    "rawAction" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PortfolioTrade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "referrerUserId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'signed_up',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Referral_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Referral_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Holding_userId_ticker_key" ON "Holding"("userId", "ticker");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_timestamp_idx" ON "PortfolioSnapshot"("timestamp");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_userId_timestamp_idx" ON "PortfolioSnapshot"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "PortfolioCompositionChange_userId_timestamp_idx" ON "PortfolioCompositionChange"("userId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "User_appleId_key" ON "User"("appleId");

-- CreateIndex
CREATE UNIQUE INDEX "Watchlist_userId_name_key" ON "Watchlist"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistHolding_watchlistId_ticker_key" ON "WatchlistHolding"("watchlistId", "ticker");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- CreateIndex
CREATE INDEX "RefreshToken_family_idx" ON "RefreshToken"("family");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_token_idx" ON "RefreshToken"("token");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_userId_idx" ON "ConsentRecord"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentRecord_userId_policyVersion_key" ON "ConsentRecord"("userId", "policyVersion");

-- CreateIndex
CREATE INDEX "MfaMethod_userId_idx" ON "MfaMethod"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MfaMethod_userId_type_key" ON "MfaMethod"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "MfaChallenge_token_key" ON "MfaChallenge"("token");

-- CreateIndex
CREATE INDEX "MfaChallenge_token_idx" ON "MfaChallenge"("token");

-- CreateIndex
CREATE INDEX "MfaChallenge_userId_idx" ON "MfaChallenge"("userId");

-- CreateIndex
CREATE INDEX "MfaChallenge_expiresAt_idx" ON "MfaChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "MfaBackupCode_userId_idx" ON "MfaBackupCode"("userId");

-- CreateIndex
CREATE INDEX "EmailOtpCode_userId_idx" ON "EmailOtpCode"("userId");

-- CreateIndex
CREATE INDEX "EmailOtpCode_expiresAt_idx" ON "EmailOtpCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");

-- CreateIndex
CREATE INDEX "NotificationAuditLog_userId_type_sentAt_idx" ON "NotificationAuditLog"("userId", "type", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationAuditLog_userId_type_refKey_key" ON "NotificationAuditLog"("userId", "type", "refKey");

-- CreateIndex
CREATE INDEX "HoldingSnapshot_ticker_timestamp_idx" ON "HoldingSnapshot"("ticker", "timestamp");

-- CreateIndex
CREATE INDEX "HoldingSnapshot_snapshotId_idx" ON "HoldingSnapshot"("snapshotId");

-- CreateIndex
CREATE INDEX "DividendEvent_ticker_idx" ON "DividendEvent"("ticker");

-- CreateIndex
CREATE INDEX "DividendEvent_payDate_idx" ON "DividendEvent"("payDate");

-- CreateIndex
CREATE INDEX "DividendEvent_exDate_idx" ON "DividendEvent"("exDate");

-- CreateIndex
CREATE UNIQUE INDEX "DividendEvent_ticker_exDate_amountPerShare_key" ON "DividendEvent"("ticker", "exDate", "amountPerShare");

-- CreateIndex
CREATE INDEX "DividendCredit_userId_idx" ON "DividendCredit"("userId");

-- CreateIndex
CREATE INDEX "DividendCredit_ticker_idx" ON "DividendCredit"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "DividendCredit_userId_dividendEventId_key" ON "DividendCredit"("userId", "dividendEventId");

-- CreateIndex
CREATE UNIQUE INDEX "DividendReinvestment_dividendCreditId_key" ON "DividendReinvestment"("dividendCreditId");

-- CreateIndex
CREATE INDEX "DividendReinvestment_userId_idx" ON "DividendReinvestment"("userId");

-- CreateIndex
CREATE INDEX "DividendReinvestment_ticker_idx" ON "DividendReinvestment"("ticker");

-- CreateIndex
CREATE INDEX "Lot_userId_ticker_idx" ON "Lot"("userId", "ticker");

-- CreateIndex
CREATE INDEX "Lot_ticker_idx" ON "Lot"("ticker");

-- CreateIndex
CREATE INDEX "Goal_userId_idx" ON "Goal"("userId");

-- CreateIndex
CREATE INDEX "Follow_followerId_idx" ON "Follow"("followerId");

-- CreateIndex
CREATE INDEX "Follow_followingId_idx" ON "Follow"("followingId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followingId_key" ON "Follow"("followerId", "followingId");

-- CreateIndex
CREATE INDEX "StockFollow_symbol_idx" ON "StockFollow"("symbol");

-- CreateIndex
CREATE INDEX "StockFollow_userId_idx" ON "StockFollow"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StockFollow_userId_symbol_key" ON "StockFollow"("userId", "symbol");

-- CreateIndex
CREATE INDEX "ActivityEvent_userId_createdAt_idx" ON "ActivityEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_createdAt_idx" ON "ActivityEvent"("createdAt");

-- CreateIndex
CREATE INDEX "Transaction_userId_date_idx" ON "Transaction"("userId", "date");

-- CreateIndex
CREATE INDEX "Alert_userId_idx" ON "Alert"("userId");

-- CreateIndex
CREATE INDEX "AlertEvent_alertId_createdAt_idx" ON "AlertEvent"("alertId", "createdAt");

-- CreateIndex
CREATE INDEX "LeaderboardCache_window_twrPct_idx" ON "LeaderboardCache"("window", "twrPct");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardCache_userId_window_key" ON "LeaderboardCache"("userId", "window");

-- CreateIndex
CREATE INDEX "PriceAlert_ticker_idx" ON "PriceAlert"("ticker");

-- CreateIndex
CREATE INDEX "PriceAlert_enabled_triggered_idx" ON "PriceAlert"("enabled", "triggered");

-- CreateIndex
CREATE INDEX "PriceAlertEvent_priceAlertId_idx" ON "PriceAlertEvent"("priceAlertId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalystSnapshot_ticker_key" ON "AnalystSnapshot"("ticker");

-- CreateIndex
CREATE INDEX "AnalystSnapshot_ticker_idx" ON "AnalystSnapshot"("ticker");

-- CreateIndex
CREATE INDEX "AnalystEvent_ticker_idx" ON "AnalystEvent"("ticker");

-- CreateIndex
CREATE INDEX "AnalystEvent_read_idx" ON "AnalystEvent"("read");

-- CreateIndex
CREATE INDEX "AnalystEvent_createdAt_idx" ON "AnalystEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FundamentalsCache_ticker_key" ON "FundamentalsCache"("ticker");

-- CreateIndex
CREATE INDEX "FundamentalsCache_ticker_idx" ON "FundamentalsCache"("ticker");

-- CreateIndex
CREATE INDEX "FundamentalsCache_lastFetchedAt_idx" ON "FundamentalsCache"("lastFetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EconomicIndicatorCache_indicator_key" ON "EconomicIndicatorCache"("indicator");

-- CreateIndex
CREATE INDEX "EconomicIndicatorCache_indicator_idx" ON "EconomicIndicatorCache"("indicator");

-- CreateIndex
CREATE UNIQUE INDEX "AVDailyUsage_date_key" ON "AVDailyUsage"("date");

-- CreateIndex
CREATE INDEX "MilestoneEvent_userId_idx" ON "MilestoneEvent"("userId");

-- CreateIndex
CREATE INDEX "MilestoneEvent_ticker_idx" ON "MilestoneEvent"("ticker");

-- CreateIndex
CREATE INDEX "MilestoneEvent_read_idx" ON "MilestoneEvent"("read");

-- CreateIndex
CREATE INDEX "MilestoneEvent_createdAt_idx" ON "MilestoneEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AnomalyEvent_userId_idx" ON "AnomalyEvent"("userId");

-- CreateIndex
CREATE INDEX "AnomalyEvent_ticker_createdAt_idx" ON "AnomalyEvent"("ticker", "createdAt");

-- CreateIndex
CREATE INDEX "AnomalyEvent_read_createdAt_idx" ON "AnomalyEvent"("read", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlaidItem_plaidItemId_key" ON "PlaidItem"("plaidItemId");

-- CreateIndex
CREATE INDEX "PlaidItem_userId_idx" ON "PlaidItem"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaidAccount_plaidAccountId_key" ON "PlaidAccount"("plaidAccountId");

-- CreateIndex
CREATE INDEX "PlaidAccount_plaidItemId_idx" ON "PlaidAccount"("plaidItemId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingWebhookEvent_eventId_key" ON "BillingWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "BillingWebhookEvent_processedAt_idx" ON "BillingWebhookEvent"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Creator_userId_key" ON "Creator"("userId");

-- CreateIndex
CREATE INDEX "Creator_status_idx" ON "Creator"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorVisibility_creatorId_key" ON "CreatorVisibility"("creatorId");

-- CreateIndex
CREATE INDEX "CreatorSubscription_subscriberUserId_idx" ON "CreatorSubscription"("subscriberUserId");

-- CreateIndex
CREATE INDEX "CreatorSubscription_creatorUserId_idx" ON "CreatorSubscription"("creatorUserId");

-- CreateIndex
CREATE INDEX "CreatorSubscription_status_idx" ON "CreatorSubscription"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorSubscription_subscriberUserId_creatorUserId_key" ON "CreatorSubscription"("subscriberUserId", "creatorUserId");

-- CreateIndex
CREATE INDEX "CreatorSubscriptionEvent_subscriptionId_idx" ON "CreatorSubscriptionEvent"("subscriptionId");

-- CreateIndex
CREATE INDEX "CreatorSubscriptionEvent_createdAt_idx" ON "CreatorSubscriptionEvent"("createdAt");

-- CreateIndex
CREATE INDEX "CreatorWalletLedger_creatorUserId_idx" ON "CreatorWalletLedger"("creatorUserId");

-- CreateIndex
CREATE INDEX "CreatorWalletLedger_creatorUserId_type_idx" ON "CreatorWalletLedger"("creatorUserId", "type");

-- CreateIndex
CREATE INDEX "CreatorWalletLedger_subscriptionId_idx" ON "CreatorWalletLedger"("subscriptionId");

-- CreateIndex
CREATE INDEX "CreatorWalletLedger_createdAt_idx" ON "CreatorWalletLedger"("createdAt");

-- CreateIndex
CREATE INDEX "CreatorPayout_creatorUserId_idx" ON "CreatorPayout"("creatorUserId");

-- CreateIndex
CREATE INDEX "CreatorPayout_status_idx" ON "CreatorPayout"("status");

-- CreateIndex
CREATE INDEX "CreatorReport_creatorUserId_idx" ON "CreatorReport"("creatorUserId");

-- CreateIndex
CREATE INDEX "CreatorReport_status_idx" ON "CreatorReport"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorWebhookEvent_eventId_key" ON "CreatorWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "CreatorWebhookEvent_processedAt_idx" ON "CreatorWebhookEvent"("processedAt");

-- CreateIndex
CREATE INDEX "UserReport_reporterUserId_idx" ON "UserReport"("reporterUserId");

-- CreateIndex
CREATE INDEX "UserReport_reportedUserId_idx" ON "UserReport"("reportedUserId");

-- CreateIndex
CREATE INDEX "UserReport_status_idx" ON "UserReport"("status");

-- CreateIndex
CREATE INDEX "PortfolioTrade_userId_date_idx" ON "PortfolioTrade"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_referredUserId_key" ON "Referral"("referredUserId");

-- CreateIndex
CREATE INDEX "Referral_referrerUserId_idx" ON "Referral"("referrerUserId");

-- CreateIndex
CREATE INDEX "Referral_referredUserId_idx" ON "Referral"("referredUserId");

-- CreateIndex
CREATE INDEX "Referral_status_idx" ON "Referral"("status");

-- CreateIndex
CREATE INDEX "Referral_createdAt_idx" ON "Referral"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_referrerUserId_referredUserId_key" ON "Referral"("referrerUserId", "referredUserId");

