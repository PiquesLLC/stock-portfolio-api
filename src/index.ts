import app from './app';
import { config } from './config';
import { ensureBenchmarksCached } from './utils/candle-cache';
import { createSnapshotIfNeeded, refreshLeaderboardSnapshots } from './services/snapshot.service';
import { backfillLeaderboardDemoData } from './services/demo-data.service';
import { syncAllHeldTickers } from './services/dividend-fetch.service';
import { postDividendsForDate } from './services/dividend-post.service';
import { evaluatePriceAlerts } from './services/priceAlert.service';
import { checkAnalystUpdates } from './services/analyst.service';
import { checkMilestoneAlerts } from './services/milestone.service';
import { detectAnomalies, detectDividendChanges } from './services/anomaly-detection.service';
import { getMarketSession } from './utils/market-hours';
import prisma, { initSqlitePragmas } from './utils/prisma';
import { refreshEconomicIndicators, refreshInternationalIndicators } from './services/economic.service';
import { refreshFundamentalsForTicker } from './services/polygon-fundamentals.service';
import { backfillHeatmapFundamentals } from './services/market-heatmap-fundamentals.service';
import { backfillPolygonScreenerData } from './services/polygon-screener.service';
import { sendEarningsAlerts } from './services/notifications.service';
import { assertBillingDeploySafety } from './services/billing.service';
import { runCreatorLedgerReconciliation } from './services/creator-reconciliation.service';
import { pollActiveResearchJobs } from './services/deep-research.service';
import { warmHoldingsCache } from './services/market.service';
import { startQuoteRefresh, stopQuoteRefresh } from './services/quote-refresh.service';
import { evaluateWebhookThresholds } from './utils/webhook-metrics';
import { startFundamentalsPrefetch, stopFundamentalsPrefetch } from './services/fundamentals-prefetch.service';
import { runJob, pruneOldJobRuns, healOrphanedJobs, pruneExpiredIdempotencyKeys, registerJobHandler } from './services/job-runner.service';
import { preGenerateDailyReports } from './services/perplexity-daily-report.service';
import { cleanupOldEvents as cleanupOldAnalyticsEvents } from './services/analytics.service';
import { checkCongressTradeAlerts } from './services/alert.service';
import { syncLatestCongressTrades } from './services/congress.service';
import { refreshProfileStats } from './services/profile-stats.service';
import { refreshAllBillionaires, snapshotBillionaires } from './services/billionaire.service';

// Dedicated seed/system user — must NOT collide with any real user account.
// Previously this was Jon's real Piques account which caused his account to be
// renamed to '_system' during DB rebuilds. Changed 2026-03-01 to a dedicated UUID.
const DEFAULT_USER_ID = '515d3ef4-2b46-4133-8c08-84327b420eba';

/** Returns true on Saturday/Sunday ET — used to skip notification-generating jobs on weekends */
function isWeekendET(): boolean {
  const etDay = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return etDay === 'Sat' || etDay === 'Sun';
}

// Ensure the seed/demo user exists (used only for leaderboard exclusion and demo data seeding).
// Real users authenticate via JWT — portfolio data is stored per-user, never shared.
async function ensureSeedUser(): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { id: DEFAULT_USER_ID }, select: { id: true } });
  if (!existing) {
    await prisma.user.create({
      data: {
        id: DEFAULT_USER_ID,
        username: '_system',
        displayName: 'System (Seed)',
        profilePublic: false,
      },
      select: { id: true },
    });
    console.log('[Init] Created seed user (demo/leaderboard exclusion only)');
  }
}

// Ensure the system user participates in leaderboard rankings
async function ensureDefaultUserLeaderboard(): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: DEFAULT_USER_ID },
    select: { id: true, leaderboardEligible: true, profilePublic: true, trackingStartAt: true },
  });

  if (!user) return;

  let trackingStartAt = user.trackingStartAt;
  if (!trackingStartAt) {
    const firstSnapshot = await prisma.portfolioSnapshot.findFirst({
      where: { userId: DEFAULT_USER_ID },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true },
    });
    trackingStartAt = firstSnapshot?.timestamp ?? new Date();
  }

  // NEVER auto-flip profilePublic — leaderboard eligibility is independent of profile visibility.
  // Users must explicitly choose to make their profile public.
  const updates: { leaderboardEligible?: boolean; trackingStartAt?: Date } = {};
  if (!user.leaderboardEligible) updates.leaderboardEligible = true;
  if (user.trackingStartAt?.getTime() !== trackingStartAt.getTime()) {
    updates.trackingStartAt = trackingStartAt;
  }

  if (Object.keys(updates).length > 0) {
    await prisma.user.update({ where: { id: DEFAULT_USER_ID }, data: updates, select: { id: true } });
    console.log('[Init] Enabled leaderboard for system user');
  }
}

// One-time cleanup: remove migrated holdings from non-system users.
// Disabled by default to preserve demo users; enable via CLEANUP_MIGRATED_HOLDINGS=true if needed.
async function cleanupMigratedHoldings(): Promise<void> {
  if (process.env.CLEANUP_MIGRATED_HOLDINGS !== 'true') return;
  const result = await prisma.holding.deleteMany({
    where: { userId: { not: DEFAULT_USER_ID } },
  });
  if (result.count > 0) {
    console.log(`[Cleanup] Removed ${result.count} migrated holdings from non-system users`);
  }
}

async function ensureTesterFeatureAccess(): Promise<void> {
  const usernames = config.testerFeatureAccessUsernames;
  if (usernames.length === 0) return;

  const expiresAt = new Date('2100-01-01T00:00:00.000Z');
  const users = await prisma.user.findMany({
    where: { username: { in: usernames } },
    select: { id: true, username: true, plan: true, planExpiresAt: true },
  });

  for (const user of users) {
    const isExpired = user.planExpiresAt ? user.planExpiresAt < new Date() : false;
    if (user.plan !== 'elite' || isExpired || !user.planExpiresAt || user.planExpiresAt.getTime() !== expiresAt.getTime()) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          plan: 'elite',
          planStartedAt: new Date(),
          planExpiresAt: expiresAt,
        },
        select: { id: true },
      });
      console.log(`[Init] Granted tester feature access to @${user.username}`);
    }
  }
}

// Helper to get all unique tickers from holdings + watchlists
async function getAllHeldTickers(): Promise<string[]> {
  const [holdings, watchlistHoldings] = await Promise.all([
    prisma.holding.findMany({
      select: { ticker: true },
      distinct: ['ticker'],
    }),
    prisma.watchlistHolding.findMany({
      select: { ticker: true },
      distinct: ['ticker'],
    }),
  ]);

  const tickers = [...holdings, ...watchlistHoldings]
    .map(h => h.ticker.toUpperCase());

  return Array.from(new Set(tickers));
}

function buildTimeBucketIdempotencyKey(jobName: string, windowMs: number): string {
  const bucket = Math.floor(Date.now() / windowMs);
  return `${jobName}:${bucket}`;
}

async function runSnapshotSchedulerForAllUsers() {
  const userIds = await prisma.holding.findMany({
    select: { userId: true },
    distinct: ['userId'],
    where: { shares: { gt: 0 }, userId: { not: null } },
  });
  for (const { userId } of userIds) {
    if (userId) {
      await createSnapshotIfNeeded(userId).catch(err => {
        if (err?.message && !err.message.includes('quotes')) {
          console.error(`[Snapshot Scheduler] Error for user ${userId.slice(0, 8)}:`, err.message);
        }
      });
    }
  }
}

async function runAnalystUpdatesJob() {
  const tickers = await getAllHeldTickers();
  await checkAnalystUpdates(tickers);
}

async function runPolygonFundamentalsJob() {
  const tickers = await getAllHeldTickers();
  for (const t of tickers) {
    await refreshFundamentalsForTicker(t).catch(err =>
      console.error(`[Polygon Fundamentals] Refresh failed for ${t}:`, err.message)
    );
  }
  console.log(`[Polygon Fundamentals] Rotation complete: ${tickers.length} tickers`);
}

async function runAnomalyDetectionForAllUsers() {
  const session = getMarketSession();
  if (session !== 'PRE' && session !== 'REG' && session !== 'POST') return;
  const users = await prisma.holding.findMany({
    select: { userId: true },
    distinct: ['userId'],
    where: { shares: { gt: 0 }, userId: { not: null } },
  });
  for (const { userId } of users) {
    if (userId) {
      await detectAnomalies(userId).catch(err =>
        console.error(`[Anomaly Detection] Error for user ${userId.slice(0, 8)}:`, err.message)
      );
    }
  }
}

async function runDividendChangeDetectionForAllUsers() {
  if (isWeekendET()) return;
  const users = await prisma.holding.findMany({
    select: { userId: true },
    distinct: ['userId'],
    where: { shares: { gt: 0 }, userId: { not: null } },
  });
  for (const { userId } of users) {
    if (userId) {
      await detectDividendChanges(userId).catch(err =>
        console.error(`[Dividend Change Detection] Error for user ${userId.slice(0, 8)}:`, err.message)
      );
    }
  }
}

async function runWebhookThresholdEvalJob() {
  evaluateWebhookThresholds();
}

async function runJobRunPruneJob() {
  const count = await pruneOldJobRuns();
  if (count > 0) console.log(`[JobRunner] Pruned ${count} old job runs`);
}

async function runIdempotencyKeyPruneJob() {
  const count = await pruneExpiredIdempotencyKeys();
  if (count > 0) console.log(`[JobRunner] Pruned ${count} expired idempotency key(s)`);
}

async function runProfileStatsRefreshForAllUsers() {
  const userIds = await prisma.holding.findMany({
    select: { userId: true },
    distinct: ['userId'],
    where: { shares: { gt: 0 }, userId: { not: null } },
  });
  for (const { userId } of userIds) {
    if (userId) {
      await refreshProfileStats(userId).catch(err =>
        console.error(`[Profile Stats] Error for user ${userId.slice(0, 8)}:`, err.message)
      );
    }
  }
}

function registerBackgroundJobHandlers(): void {
  registerJobHandler('benchmark_cache', ensureBenchmarksCached);
  registerJobHandler('snapshot_scheduler', runSnapshotSchedulerForAllUsers);
  registerJobHandler('demo_leaderboard_backfill', backfillLeaderboardDemoData);
  registerJobHandler('leaderboard_refresh', refreshLeaderboardSnapshots);
  registerJobHandler('dividend_sync', syncAllHeldTickers);
  registerJobHandler('dividend_post', postDividendsForDate);
  registerJobHandler('price_alert_eval', evaluatePriceAlerts);
  registerJobHandler('analyst_updates', runAnalystUpdatesJob);
  registerJobHandler('economic_indicators', refreshEconomicIndicators);
  registerJobHandler('international_indicators', refreshInternationalIndicators);
  registerJobHandler('polygon_fundamentals', runPolygonFundamentalsJob);
  registerJobHandler('heatmap_fundamentals', backfillHeatmapFundamentals);
  registerJobHandler('polygon_screener', backfillPolygonScreenerData);
  registerJobHandler('earnings_alerts', sendEarningsAlerts);
  registerJobHandler('milestone_check', checkMilestoneAlerts);
  registerJobHandler('anomaly_detection', runAnomalyDetectionForAllUsers);
  registerJobHandler('dividend_change_detection', runDividendChangeDetectionForAllUsers);
  registerJobHandler('creator_reconciliation', runCreatorLedgerReconciliation);
  registerJobHandler('deep_research_poller', pollActiveResearchJobs);
  registerJobHandler('congress_sync', syncLatestCongressTrades);
  registerJobHandler('congress_alert_eval', checkCongressTradeAlerts);
  registerJobHandler('profile_stats_refresh', runProfileStatsRefreshForAllUsers);
  registerJobHandler('billionaire_refresh', refreshAllBillionaires);
  registerJobHandler('billionaire_snapshot', snapshotBillionaires);
  registerJobHandler('webhook_threshold_eval', runWebhookThresholdEvalJob);
  registerJobHandler('job_run_prune', runJobRunPruneJob);
  registerJobHandler('idempotency_key_prune', runIdempotencyKeyPruneJob);
  registerJobHandler('daily_report_pregen', preGenerateDailyReports);
  registerJobHandler('analytics_cleanup', async () => {
    const count = await cleanupOldAnalyticsEvents();
    if (count > 0) console.log(`[Analytics] Cleaned up ${count} events older than 90 days`);
  });
}

const server = app.listen(config.port, async () => {
  console.log(`Stock Portfolio API running on http://localhost:${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);

  // Must run before any DB operations — enables concurrent reads + write queuing
  await initSqlitePragmas();

  // Ensure social platform tables exist (migration may have partially failed)
  try {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Post" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "content" TEXT NOT NULL, "ticker" TEXT, "type" TEXT NOT NULL DEFAULT 'thought', "attachmentType" TEXT, "attachmentData" TEXT, "deleted" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Post_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Comment" ("id" TEXT NOT NULL PRIMARY KEY, "postId" TEXT NOT NULL, "userId" TEXT NOT NULL, "content" TEXT NOT NULL, "deleted" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post" ("id") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Like" ("id" TEXT NOT NULL PRIMARY KEY, "postId" TEXT NOT NULL, "userId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Like_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post" ("id") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT "Like_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "Like_postId_userId_key" ON "Like"("postId", "userId")`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "SocialNotification" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "actorId" TEXT NOT NULL, "type" TEXT NOT NULL, "postId" TEXT, "message" TEXT NOT NULL, "read" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "SocialNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT "SocialNotification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Post_userId_createdAt_idx" ON "Post"("userId", "createdAt")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Post_createdAt_idx" ON "Post"("createdAt")`);
    console.log('[Init] Social platform tables verified');
  } catch (err: any) {
    console.error('[Init] Social table creation failed:', err.message);
  }

  try {
    await assertBillingDeploySafety();
    if (config.billingEnabled) {
      console.log('[Init] Billing deploy safety check passed');
    } else {
      console.log('[Init] Billing routes disabled');
    }
  } catch (_error) {
    if (config.nodeEnv === 'production') {
      console.error('[Init] Billing deploy safety check failed — exiting:', _error instanceof Error ? _error.message : _error);
      server.close(() => process.exit(1));
      return;
    }
    console.warn('[Init] Billing deploy safety check failed (non-fatal in dev)');
  }

  // Ensure default system user exists before any schedulers run
  await ensureSeedUser().catch(err => console.error('[Init] Failed to create seed user:', err.message));
  await ensureDefaultUserLeaderboard().catch(err => console.error('[Init] Failed to enable leaderboard for system user:', err.message));
  await ensureTesterFeatureAccess().catch(err => console.error('[Init] Failed to grant tester feature access:', err.message));
  registerBackgroundJobHandlers();

  // Auto-verify users created before email verification was required (one-time, cutoff date).
  // Only applies to pre-existing users; new users must complete OTP verification.
  await prisma.user.updateMany({
    where: { emailVerified: false, createdAt: { lt: new Date('2026-03-01') } },
    data: { emailVerified: true },
  }).then(r => { if (r.count > 0) console.log(`[Init] Auto-verified ${r.count} pre-existing users`); })
    .catch(err => console.error('[Init] Auto-verify failed:', err.message));

  // Heal any orphaned jobs from a previous server crash/restart
  await healOrphanedJobs().catch(err => console.error('[Init] Failed to heal orphaned jobs:', err.message));

  // One-time cleanup of incorrectly migrated holdings
  await cleanupMigratedHoldings().catch(err => console.error('[Cleanup] Failed:', err.message));

  // Cache benchmark data on startup and every 6 hours
  ensureBenchmarksCached()
    .then(() => {
      // After benchmarks are ready, warm holdings cache in background (non-blocking)
      warmHoldingsCache()
        .catch(err => console.error('[Startup] Holdings cache warm failed:', err))
        .finally(() => startQuoteRefresh());
    })
    .catch(err => {
      console.error('Benchmark cache init failed:', err);
      startQuoteRefresh();
    });
  setInterval(() => {
    runJob({ name: 'benchmark_cache', fn: ensureBenchmarksCached });
  }, 6 * 60 * 60 * 1000);

  // Background snapshot scheduler â€” creates portfolio snapshots even when
  // no browser is connected, so the 1D chart never has gaps.
  const SNAPSHOT_INTERVAL_MS = config.snapshotIntervalSeconds * 1000;
  console.log(`[Snapshot Scheduler] Running every ${config.snapshotIntervalSeconds}s`);
  setInterval(() => {
    runJob({ name: 'snapshot_scheduler', fn: runSnapshotSchedulerForAllUsers, maxAttempts: 1, idempotencyKey: buildTimeBucketIdempotencyKey('snapshot_scheduler', SNAPSHOT_INTERVAL_MS), idempotencyTtlMs: SNAPSHOT_INTERVAL_MS + 10000 }); // maxAttempts: 1 — runs every ~60s, no point retrying
  }, SNAPSHOT_INTERVAL_MS);

  // Demo leaderboard data backfill — only runs when DEMO_LEADERBOARD=true (pre-beta).
  // Disable this env var once real users join the leaderboard.
  if (process.env.DEMO_LEADERBOARD === 'true') {
    console.log('[Demo Data] DEMO_LEADERBOARD=true — backfilling demo users');
    setTimeout(() => {
      runJob({ name: 'demo_leaderboard_backfill', fn: backfillLeaderboardDemoData, maxAttempts: 1 });
    }, 60000); // 60s delay after startup
  } else {
    console.log('[Demo Data] Skipped (DEMO_LEADERBOARD not set)');
  }

  // Leaderboard snapshot refresh — update all leaderboard users with live prices every 3 hours
  // Skips when market is CLOSED (stale quotes); runs during PRE/REG/POST
  console.log('[Leaderboard Refresh] Running every 3 hours (market hours only)');
  setTimeout(() => {
    const session = getMarketSession();
    if (session === 'CLOSED') return;
    runJob({ name: 'leaderboard_refresh', fn: refreshLeaderboardSnapshots });
  }, 120000); // 2 min delay after startup (backfill may still be running)
  setInterval(() => {
    const session = getMarketSession();
    if (session === 'CLOSED') return;
    runJob({ name: 'leaderboard_refresh', fn: refreshLeaderboardSnapshots });
  }, 3 * 60 * 60 * 1000); // Every 3 hours

  // Dividend sync â€" fetch dividend events from Yahoo Finance on startup + every 6 hours (skip weekends)
  if (!isWeekendET()) {
    runJob({
      name: 'dividend_sync',
      fn: syncAllHeldTickers,
      idempotencyKey: buildTimeBucketIdempotencyKey('dividend_sync', 6 * 60 * 60 * 1000),
      idempotencyTtlMs: 6 * 60 * 60 * 1000,
    });
  }
  setInterval(() => {
    if (isWeekendET()) return;
    runJob({
      name: 'dividend_sync',
      fn: syncAllHeldTickers,
      idempotencyKey: buildTimeBucketIdempotencyKey('dividend_sync', 6 * 60 * 60 * 1000),
      idempotencyTtlMs: 6 * 60 * 60 * 1000,
    });
  }, 6 * 60 * 60 * 1000);

  // Dividend posting â€" check for payable dividends every hour (skip weekends — no pay dates)
  if (!isWeekendET()) {
    runJob({
      name: 'dividend_post',
      fn: postDividendsForDate,
      idempotencyKey: buildTimeBucketIdempotencyKey('dividend_post', 60 * 60 * 1000),
      idempotencyTtlMs: 60 * 60 * 1000,
    });
  }
  // NOTE: backfillMissedDividends removed â€" it double-counts dividends already
  // reflected in historical stock prices, inflating portfolio value via DRIP.
  setInterval(() => {
    if (isWeekendET()) return;
    runJob({
      name: 'dividend_post',
      fn: postDividendsForDate,
      idempotencyKey: buildTimeBucketIdempotencyKey('dividend_post', 60 * 60 * 1000),
      idempotencyTtlMs: 60 * 60 * 1000,
    });
  }, 60 * 60 * 1000);

  // Price alert evaluation â€" check every 60 seconds (skip weekends — prices are stale)
  console.log('[Price Alert Scheduler] Running every 60s');
  setInterval(() => {
    if (isWeekendET()) return;
    runJob({ name: 'price_alert_eval', fn: evaluatePriceAlerts, maxAttempts: 1 });
  }, 60000);

  // Analyst updates â€” check once per day (every 24 hours)
  console.log('[Analyst Scheduler] Running every 24 hours');
  setTimeout(() => {
    runJob({ name: 'analyst_updates', fn: runAnalystUpdatesJob });
  }, 30000);
  setInterval(() => {
    runJob({ name: 'analyst_updates', fn: runAnalystUpdatesJob });
  }, 24 * 60 * 60 * 1000);

  // Alpha Vantage: Economic indicators â€” refresh daily (5 API calls)
  console.log('[AV Economic] Running daily');
  setTimeout(() => {
    runJob({ name: 'economic_indicators', fn: refreshEconomicIndicators });
  }, 60000);
  setInterval(() => {
    runJob({ name: 'economic_indicators', fn: refreshEconomicIndicators });
  }, 24 * 60 * 60 * 1000);

  // World Bank: International economic indicators â€” refresh daily (6 API calls, no key needed)
  console.log('[WB International] Running daily');
  setTimeout(() => {
    runJob({ name: 'international_indicators', fn: refreshInternationalIndicators });
  }, 90000);
  setInterval(() => {
    runJob({ name: 'international_indicators', fn: refreshInternationalIndicators });
  }, 24 * 60 * 60 * 1000);

  // Polygon Fundamentals: refresh all held tickers every 12 hours (unlimited API calls)
  console.log('[Polygon Fundamentals] Rotating every 12 hours');
  setTimeout(() => {
    runJob({ name: 'polygon_fundamentals', fn: runPolygonFundamentalsJob });
  }, 120000);
  setInterval(() => {
    runJob({ name: 'polygon_fundamentals', fn: runPolygonFundamentalsJob });
  }, 12 * 60 * 60 * 1000);

  // Heatmap fundamentals backfill â€” refresh heatmap tickers (missing/stale) on startup + daily
  console.log('[Heatmap Fundamentals] Backfill scheduled');
  setTimeout(() => {
    runJob({ name: 'heatmap_fundamentals', fn: backfillHeatmapFundamentals });
  }, 150000); // 150s delay after startup
  setInterval(() => {
    runJob({ name: 'heatmap_fundamentals', fn: backfillHeatmapFundamentals });
  }, 24 * 60 * 60 * 1000);

  // Polygon Screener backfill — fetch EPS, dividends, beta, 52W range on startup + every 12 hours
  console.log('[Polygon Screener] Backfill scheduled');
  setTimeout(() => {
    runJob({ name: 'polygon_screener', fn: backfillPolygonScreenerData });
  }, 180000); // 180s delay after startup
  setInterval(() => {
    runJob({ name: 'polygon_screener', fn: backfillPolygonScreenerData });
  }, 12 * 60 * 60 * 1000); // Every 12 hours

  // Earnings alerts — audit log for upcoming earnings (every 6 hours, skip weekends)
  console.log('[Notifications] Earnings alerts scheduled');
  setTimeout(() => {
    if (isWeekendET()) return;
    runJob({ name: 'earnings_alerts', fn: sendEarningsAlerts });
  }, 90000);
  setInterval(() => {
    if (isWeekendET()) return;
    runJob({ name: 'earnings_alerts', fn: sendEarningsAlerts });
  }, 6 * 60 * 60 * 1000);

  // Milestone alerts (52w high/low, ATH/ATL) â€” using Yahoo Finance for accurate 52w data
  console.log('[Milestone Scheduler] Running every 30 minutes');
  setTimeout(() => {
    runJob({ name: 'milestone_check', fn: checkMilestoneAlerts });
  }, 45000);
  setInterval(() => {
    runJob({ name: 'milestone_check', fn: checkMilestoneAlerts });
  }, 30 * 60 * 1000);

  // AI Anomaly Detection — check every 30 minutes during market hours (all users)
  console.log('[Anomaly Detection] Running every 30 minutes (market hours only)');
  setTimeout(() => {
    runJob({ name: 'anomaly_detection', fn: runAnomalyDetectionForAllUsers });
  }, 120000);
  setInterval(() => {
    runJob({ name: 'anomaly_detection', fn: runAnomalyDetectionForAllUsers });
  }, 30 * 60 * 1000);

  // Dividend change detection — every 6 hours (skip weekends — no new dividend data, all users)
  console.log('[Dividend Change Detection] Running every 6 hours');
  setTimeout(() => {
    runJob({ name: 'dividend_change_detection', fn: runDividendChangeDetectionForAllUsers });
  }, 60000);
  setInterval(() => {
    runJob({ name: 'dividend_change_detection', fn: runDividendChangeDetectionForAllUsers });
  }, 6 * 60 * 60 * 1000);

  // Creator reconciliation — daily ledger vs subscription consistency audit.
  // This is a safety-net process and does not mutate data.
  if (config.creatorMonetizationEnabled) {
    console.log('[Creator Reconciliation] Running daily');
    setTimeout(() => {
      runJob({
        name: 'creator_reconciliation',
        fn: runCreatorLedgerReconciliation,
        idempotencyKey: buildTimeBucketIdempotencyKey('creator_reconciliation', 24 * 60 * 60 * 1000),
        idempotencyTtlMs: 24 * 60 * 60 * 1000,
      });
    }, 180000); // 3 min delay after startup

    setInterval(() => {
      runJob({
        name: 'creator_reconciliation',
        fn: runCreatorLedgerReconciliation,
        idempotencyKey: buildTimeBucketIdempotencyKey('creator_reconciliation', 24 * 60 * 60 * 1000),
        idempotencyTtlMs: 24 * 60 * 60 * 1000,
      });
    }, 24 * 60 * 60 * 1000);
  } else {
    console.log('[Creator Reconciliation] Skipped (creator monetization disabled)');
  }

  // NALA AI Deep Research — background poller for Gemini async jobs
  if (config.deepResearchEnabled) {
    console.log(`[Deep Research] Poller running every ${config.deepResearchPollIntervalMs / 1000}s`);
    setInterval(() => {
      runJob({ name: 'deep_research_poller', fn: pollActiveResearchJobs, maxAttempts: 1 });
    }, config.deepResearchPollIntervalMs);
  } else {
    console.log('[Deep Research] Disabled (DEEP_RESEARCH_ENABLED not set)');
  }

  // Congress trade sync — fetch latest trades every 2 hours
  console.log('[Congress Sync] Running every 2 hours');
  setTimeout(() => {
    runJob({ name: 'congress_sync', fn: syncLatestCongressTrades, idempotencyKey: buildTimeBucketIdempotencyKey('congress_sync', 2 * 60 * 60 * 1000), idempotencyTtlMs: 2 * 60 * 60 * 1000 });
  }, 60000);
  setInterval(() => {
    runJob({ name: 'congress_sync', fn: syncLatestCongressTrades, idempotencyKey: buildTimeBucketIdempotencyKey('congress_sync', 2 * 60 * 60 * 1000), idempotencyTtlMs: 2 * 60 * 60 * 1000 });
  }, 2 * 60 * 60 * 1000);

  // Congress trade alert evaluation — check every 2 hours (offset 30 min from sync)
  console.log('[Congress Alert Eval] Running every 2 hours');
  setTimeout(() => {
    runJob({ name: 'congress_alert_eval', fn: checkCongressTradeAlerts, maxAttempts: 1, idempotencyKey: buildTimeBucketIdempotencyKey('congress_alert_eval', 2 * 60 * 60 * 1000), idempotencyTtlMs: 2 * 60 * 60 * 1000 });
  }, 30 * 60 * 1000);
  setInterval(() => {
    runJob({ name: 'congress_alert_eval', fn: checkCongressTradeAlerts, maxAttempts: 1, idempotencyKey: buildTimeBucketIdempotencyKey('congress_alert_eval', 2 * 60 * 60 * 1000), idempotencyTtlMs: 2 * 60 * 60 * 1000 });
  }, 2 * 60 * 60 * 1000);

  // Webhook threshold evaluation — check every 5 minutes for failure rate spikes
  setInterval(() => {
    runJob({ name: 'webhook_threshold_eval', fn: runWebhookThresholdEvalJob, maxAttempts: 1 });
  }, 5 * 60 * 1000);

  // Prune old job run records daily (keeps last 7 days)
  setInterval(() => {
    runJob({ name: 'job_run_prune', fn: runJobRunPruneJob, maxAttempts: 2 });
  }, 24 * 60 * 60 * 1000);

  // Prune expired idempotency keys daily
  setInterval(() => {
    runJob({ name: 'idempotency_key_prune', fn: runIdempotencyKeyPruneJob, maxAttempts: 2 });
  }, 24 * 60 * 60 * 1000);

  // Analytics event cleanup — delete events older than 90 days (daily)
  console.log('[Analytics] Cleanup scheduled daily');
  setInterval(() => {
    runJob({
      name: 'analytics_cleanup',
      fn: async () => {
        const count = await cleanupOldAnalyticsEvents();
        if (count > 0) console.log(`[Analytics] Cleaned up ${count} events older than 90 days`);
      },
      maxAttempts: 2,
      idempotencyKey: buildTimeBucketIdempotencyKey('analytics_cleanup', 24 * 60 * 60 * 1000),
      idempotencyTtlMs: 24 * 60 * 60 * 1000,
    });
  }, 24 * 60 * 60 * 1000);

  // Daily Report pre-generation — warm cache so reports load instantly
  // Runs 2 min after startup + every 4 hours (aligns with 8h cache TTL)
  console.log('[Daily Report Pre-Gen] Scheduled: startup + every 4 hours');
  setTimeout(() => {
    runJob({
      name: 'daily_report_pregen',
      fn: preGenerateDailyReports,
      maxAttempts: 1,
      idempotencyKey: buildTimeBucketIdempotencyKey('daily_report_pregen', 4 * 60 * 60 * 1000),
      idempotencyTtlMs: 4 * 60 * 60 * 1000,
    });
  }, 120000); // 2 min after startup
  setInterval(() => {
    runJob({
      name: 'daily_report_pregen',
      fn: preGenerateDailyReports,
      maxAttempts: 1,
      idempotencyKey: buildTimeBucketIdempotencyKey('daily_report_pregen', 4 * 60 * 60 * 1000),
      idempotencyTtlMs: 4 * 60 * 60 * 1000,
    });
  }, 4 * 60 * 60 * 1000);

  // Profile stats refresh — recompute win rate, avg hold, badges daily
  console.log('[Profile Stats] Refresh scheduled daily');
  setTimeout(() => {
    runJob({
      name: 'profile_stats_refresh',
      fn: runProfileStatsRefreshForAllUsers,
      maxAttempts: 2,
      idempotencyKey: buildTimeBucketIdempotencyKey('profile_stats_refresh', 24 * 60 * 60 * 1000),
      idempotencyTtlMs: 24 * 60 * 60 * 1000,
    });
  }, 180000); // 3 min delay after startup
  setInterval(() => {
    runJob({
      name: 'profile_stats_refresh',
      fn: runProfileStatsRefreshForAllUsers,
      maxAttempts: 2,
      idempotencyKey: buildTimeBucketIdempotencyKey('profile_stats_refresh', 24 * 60 * 60 * 1000),
      idempotencyTtlMs: 24 * 60 * 60 * 1000,
    });
  }, 24 * 60 * 60 * 1000);

  // Billionaire net worth refresh — every 60s during market hours
  // Delay initial run to avoid overwhelming quote pipeline during startup
  console.log('[Billionaire] Refresh every 60s (market hours), snapshot every 30min');
  setTimeout(() => {
    runJob({ name: 'billionaire_refresh', fn: refreshAllBillionaires, maxAttempts: 1 });
  }, 120000); // 2 min delay — let quote cache warm first
  setInterval(() => {
    const session = getMarketSession();
    if (session === 'CLOSED') return;
    runJob({ name: 'billionaire_refresh', fn: refreshAllBillionaires, maxAttempts: 1 });
  }, 60000);

  // Billionaire snapshot — every 30 minutes for chart history
  setInterval(() => {
    runJob({
      name: 'billionaire_snapshot',
      fn: snapshotBillionaires,
      maxAttempts: 1,
      idempotencyKey: buildTimeBucketIdempotencyKey('billionaire_snapshot', 30 * 60 * 1000),
      idempotencyTtlMs: 30 * 60 * 1000,
    });
  }, 30 * 60 * 1000);

  // Fundamentals prefetch — continuously cycles through stock universe
  // pre-fetching fundamentals + earnings so data is ready before users search
  startFundamentalsPrefetch();
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  stopQuoteRefresh();
  await stopFundamentalsPrefetch();
  prisma.$disconnect().catch(() => undefined);
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  stopQuoteRefresh();
  await stopFundamentalsPrefetch();
  prisma.$disconnect().catch(() => undefined);
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});



