-- Apple IAP authoritative state — additive only.
--
-- Implements docs/apple-authoritative-state-design-2026-08-24.md (FROZEN).
-- Creates four tables and their indexes. Nothing existing is altered or
-- dropped, no data is migrated, and no code path reads these tables yet.
-- APPLE_IAP_ENABLED remains false.
--
-- The generated diff also proposed adding a portfolioId column plus indexes to
-- DividendCredit, DividendReinvestment, Lot and PortfolioTrade. That is
-- PRE-EXISTING drift between schema.prisma and the migration history, unrelated
-- to Apple, and was deliberately excluded from this migration rather than
-- carried along silently.

-- CreateTable
CREATE TABLE "AppleTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environment" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "originalTransactionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "purchaseDate" DATETIME NOT NULL,
    "expiresDate" DATETIME,
    "type" TEXT,
    "appAccountToken" TEXT,
    "lastAppliedSignedDate" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "revocationReason" INTEGER,
    "revocationType" TEXT,
    "revocationPercentage" INTEGER,
    "revokedSource" TEXT,
    "reversedAt" DATETIME,
    "reversedByUUID" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AppleTransaction_environment_check" CHECK ("environment" IN ('Production', 'Sandbox'))
);

-- CreateTable
CREATE TABLE "AppleSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environment" TEXT NOT NULL,
    "originalTransactionId" TEXT NOT NULL,
    "userId" TEXT,
    "productId" TEXT NOT NULL,
    "subscriptionGroupId" TEXT,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "gracePeriodExpiresAt" DATETIME,
    "autoRenewStatus" BOOLEAN,
    "autoRenewProductId" TEXT,
    "appAccountToken" TEXT,
    "currentTransactionId" TEXT,
    "requestedGeneration" INTEGER NOT NULL DEFAULT 0,
    "appliedGeneration" INTEGER NOT NULL DEFAULT 0,
    "lastReconciledAt" DATETIME,
    "snapshotSignedDate" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AppleSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AppleSubscription_environment_check" CHECK ("environment" IN ('Production', 'Sandbox')),
    CONSTRAINT "AppleSubscription_status_check" CHECK ("status" IN ('active', 'expired', 'billing_retry', 'grace', 'revoked'))
);

-- CreateTable
CREATE TABLE "AppleReconciliation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environment" TEXT NOT NULL,
    "originalTransactionId" TEXT NOT NULL,
    "targetGeneration" INTEGER NOT NULL,
    "reconcileState" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL,
    "lastError" TEXT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AppleReconciliation_environment_check" CHECK ("environment" IN ('Production', 'Sandbox')),
    CONSTRAINT "AppleReconciliation_reconcileState_check" CHECK ("reconcileState" IN ('pending', 'running', 'failed', 'done'))
);

-- CreateTable
CREATE TABLE "AppleNotification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environment" TEXT NOT NULL,
    "notificationUUID" TEXT NOT NULL,
    "notificationType" TEXT NOT NULL,
    "subtype" TEXT,
    "signedDate" DATETIME NOT NULL,
    "originalTransactionId" TEXT,
    "transactionId" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" DATETIME,
    CONSTRAINT "AppleNotification_environment_check" CHECK ("environment" IN ('Production', 'Sandbox'))
);

-- CreateIndex
CREATE INDEX "AppleTransaction_environment_originalTransactionId_idx" ON "AppleTransaction"("environment", "originalTransactionId");

-- CreateIndex
CREATE INDEX "AppleTransaction_revokedAt_idx" ON "AppleTransaction"("revokedAt");

-- CreateIndex
CREATE INDEX "AppleTransaction_appAccountToken_idx" ON "AppleTransaction"("appAccountToken");

-- CreateIndex
CREATE UNIQUE INDEX "AppleTransaction_environment_transactionId_key" ON "AppleTransaction"("environment", "transactionId");

-- CreateIndex
CREATE INDEX "AppleSubscription_userId_idx" ON "AppleSubscription"("userId");

-- CreateIndex
CREATE INDEX "AppleSubscription_status_idx" ON "AppleSubscription"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AppleSubscription_environment_originalTransactionId_key" ON "AppleSubscription"("environment", "originalTransactionId");

-- CreateIndex
CREATE INDEX "AppleReconciliation_reconcileState_nextAttemptAt_idx" ON "AppleReconciliation"("reconcileState", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppleReconciliation_environment_originalTransactionId_key" ON "AppleReconciliation"("environment", "originalTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "AppleNotification_notificationUUID_key" ON "AppleNotification"("notificationUUID");

-- CreateIndex
CREATE INDEX "AppleNotification_environment_originalTransactionId_idx" ON "AppleNotification"("environment", "originalTransactionId");

-- CreateIndex
CREATE INDEX "AppleNotification_outcome_idx" ON "AppleNotification"("outcome");


-- CHECK constraints above are the reason this index can be trusted.
--
-- The predicate below matches exact string values. Without a domain constraint
-- on "environment" and "status", a typo or a mapper defect ('billingRetry',
-- 'production') would place a row OUTSIDE the predicate, and the second
-- rail-blocking row for that user would be accepted — silently defeating the
-- backstop this index exists to be. Prisma cannot express CHECK constraints, so
-- they live in this migration; doc comments on the models point here.
--
-- Deliberately NOT constrained: notificationType, subtype, revocationType and
-- similar Apple-controlled fields. Apple can add enum values at any time, and a
-- CHECK there would turn a new Apple value into an intake failure.
-- Partial unique index: at most one BLOCKING Production billing rail per user.
--
-- Prisma's @@unique does not support WHERE clauses, so this is enforced at the
-- DB level only; a doc comment on the AppleSubscription model in
-- prisma/schema.prisma points here. Same pattern as
-- creator_payout_pending_unique (migration 20260527_add_payout_pending_unique).
--
-- Scope is deliberate on both axes:
--   environment = 'Production'  — a tester may hold a Sandbox subscription
--                                 alongside a real one without collision, and
--                                 a Sandbox row must never occupy the rail.
--   status IN (active, grace, billing_retry)
--                               — the rail-blocking set, which is WIDER than
--                                 entitlement. A user in billing retry is not
--                                 entitled, but Apple may still collect for up
--                                 to 60 days, so admitting them to Stripe would
--                                 risk double-billing.
--   userId IS NOT NULL          — SQLite treats NULLs as distinct, but the
--                                 predicate is stated explicitly so the intent
--                                 survives a later reader.
CREATE UNIQUE INDEX "apple_subscription_rail_unique"
  ON "AppleSubscription"("userId")
  WHERE "userId" IS NOT NULL
    AND "environment" = 'Production'
    AND "status" IN ('active', 'grace', 'billing_retry');
