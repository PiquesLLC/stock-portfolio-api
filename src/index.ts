import crypto from 'crypto';
import app from './app';
import { config } from './config';
import { ensureBenchmarksCached, restoreCandleCache, persistCandleCache } from './utils/candle-cache';
import { persistQuoteCache, restoreQuoteCache } from './utils/polygon';
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
import { bootstrapScreenerUniverseIfEmpty } from './services/screener-bootstrap.service';
import { backfillValueRadar } from './services/value-radar.service';
import { evaluateValueRadarAlerts, sendValueRadarDigest } from './services/value-radar-alerts.service';
import { sendEarningsAlerts } from './services/notifications.service';
import { assertBillingDeploySafety } from './services/billing.service';
import { runCreatorLedgerReconciliation } from './services/creator-reconciliation.service';
import { runCreatorStripeReconciliation } from './services/creator-stripe-reconciliation.service';
import { pollActiveResearchJobs } from './services/deep-research.service';
import { warmHoldingsCache } from './services/market.service';
import { startQuoteRefresh, stopQuoteRefresh } from './services/quote-refresh.service';
import { evaluateWebhookThresholds } from './utils/webhook-metrics';
import { startFundamentalsPrefetch, stopFundamentalsPrefetch } from './services/fundamentals-prefetch.service';
import { runJob, pruneOldJobRuns, healOrphanedJobs, pruneExpiredIdempotencyKeys, registerJobHandler } from './services/job-runner.service';
import { preGenerateDailyReports } from './services/perplexity-daily-report.service';
import { getMarketStateET } from './utils/market-state';
import { runWeeklyBriefCycle, runMonthlyBriefCycle } from './services/brief-scheduler.service';
import { cleanupOldEvents as cleanupOldAnalyticsEvents } from './services/analytics.service';
import { checkCongressTradeAlerts } from './services/alert.service';
import { syncLatestCongressTrades } from './services/congress.service';
import { refreshPoliticianRoster } from './services/politician.service';
import { refreshProfileStats } from './services/profile-stats.service';
import { refreshAllBillionaires, snapshotBillionaires } from './services/billionaire.service';
import { backupDatabase } from './services/backup.service';
import { cleanupStaleData } from './services/cleanup.service';
import * as Sentry from '@sentry/node';
import { scheduleV2ReconcileDaily } from './v2/reconciliation/cron';

function assertSingleReplicaRefreshRotationSafety(): void {
  const replicaCountRaw = process.env.RAILWAY_REPLICA_COUNT;

  if (!replicaCountRaw) {
    if (process.env.RAILWAY_REPLICA_ID) {
      console.warn(
        '[Auth] Refresh-token rotation uses a process-local 30s grace cache. ' +
        'Railway exposes RAILWAY_REPLICA_ID but not an official replica-count variable. ' +
        'Set RAILWAY_REPLICA_COUNT manually and keep the service Deploy replica count at 1.'
      );
    }
    return;
  }

  const replicaCount = Number.parseInt(replicaCountRaw, 10);
  if (!Number.isInteger(replicaCount) || replicaCount < 1) {
    throw new Error(
      `Invalid RAILWAY_REPLICA_COUNT="${replicaCountRaw}". Set it to an integer >= 1 to enforce single-replica auth refresh safety.`
    );
  }
  if (replicaCount > 1) {
    throw new Error(
      `Auth refresh rotation grace cache is process-local and cannot run safely with ${replicaCount} Railway replicas. Scale the service back to 1 replica.`
    );
  }
}

assertSingleReplicaRefreshRotationSafety();

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

// Auto-seed billionaires on first deploy (data doesn't exist in production DB yet)
async function seedBillionairesIfEmpty(): Promise<void> {
  const count = await prisma.billionaire.count();
  if (count > 0) return;

  console.log('[Init] Seeding billionaires (Bloomberg Billionaires Index)...');
  const BILLIONAIRES = [
    { name: 'Elon Musk', slug: 'elon-musk', company: 'Tesla / SpaceX', title: 'CEO', country: 'US', industry: 'Technology', baseNetWorthUsd: 500e9, holdings: [{ ticker: 'TSLA', shares: 411e6, note: 'Includes trust holdings' }] },
    { name: 'Larry Page', slug: 'larry-page', company: 'Alphabet', title: 'Co-founder', country: 'US', industry: 'Technology', baseNetWorthUsd: 135e9, holdings: [{ ticker: 'GOOGL', shares: 395e6, note: 'Class A + C' }] },
    { name: 'Sergey Brin', slug: 'sergey-brin', company: 'Alphabet', title: 'Co-founder', country: 'US', industry: 'Technology', baseNetWorthUsd: 134e9, holdings: [{ ticker: 'GOOGL', shares: 372e6, note: 'Class A + C' }] },
    { name: 'Jeff Bezos', slug: 'jeff-bezos', company: 'Amazon', title: 'Executive Chairman', country: 'US', industry: 'Technology', baseNetWorthUsd: 21e9, holdings: [{ ticker: 'AMZN', shares: 945e6, note: 'Per latest SEC filing' }] },
    { name: 'Mark Zuckerberg', slug: 'mark-zuckerberg', company: 'Meta', title: 'CEO', country: 'US', industry: 'Technology', baseNetWorthUsd: 8e9, holdings: [{ ticker: 'META', shares: 350e6, note: 'Class A + B' }] },
    { name: 'Larry Ellison', slug: 'larry-ellison', company: 'Oracle', title: 'CTO & Chairman', country: 'US', industry: 'Technology', baseNetWorthUsd: 19e9, holdings: [{ ticker: 'ORCL', shares: 1170e6, note: 'Direct + trust' }] },
    { name: 'Jensen Huang', slug: 'jensen-huang', company: 'NVIDIA', title: 'CEO', country: 'US', industry: 'Technology', baseNetWorthUsd: 48e9, holdings: [{ ticker: 'NVDA', shares: 579e6, note: 'Post 10:1 split' }] },
    { name: 'Michael Dell', slug: 'michael-dell', company: 'Dell Technologies', title: 'CEO', country: 'US', industry: 'Technology', baseNetWorthUsd: 58e9, holdings: [{ ticker: 'DELL', shares: 543e6, note: 'Direct + MSD Capital' }] },
    { name: 'Jim Walton', slug: 'jim-walton', company: 'Walmart / Arvest Bank', title: 'Chairman, Arvest Bank', country: 'US', industry: 'Retail', baseNetWorthUsd: 40e9, holdings: [{ ticker: 'WMT', shares: 860e6, note: 'Walton family trust' }] },
    { name: 'Rob Walton', slug: 'rob-walton', company: 'Walmart', title: 'Former Chairman', country: 'US', industry: 'Retail', baseNetWorthUsd: 40e9, holdings: [{ ticker: 'WMT', shares: 860e6, note: 'Walton family trust' }] },
    { name: 'Warren Buffett', slug: 'warren-buffett', company: 'Berkshire Hathaway', title: 'Chairman & CEO', country: 'US', industry: 'Finance', baseNetWorthUsd: 0, holdings: [{ ticker: 'BRK-B', shares: 298e6, note: 'A-shares converted to B-equivalent' }] },
    { name: 'Steve Ballmer', slug: 'steve-ballmer', company: 'LA Clippers', title: 'Owner', country: 'US', industry: 'Technology', baseNetWorthUsd: 11e9, holdings: [{ ticker: 'MSFT', shares: 333e6, note: 'Largest individual MSFT holder' }] },
    { name: 'Bernard Arnault', slug: 'bernard-arnault', company: 'LVMH', title: 'Chairman & CEO', country: 'France', industry: 'Luxury', baseNetWorthUsd: 143e9, holdings: [{ ticker: 'LVMUY', shares: 97e6, note: 'ADR equivalent (partial)' }] },
    { name: 'Alice Walton', slug: 'alice-walton', company: 'Walmart', title: 'Heiress', country: 'US', industry: 'Retail', baseNetWorthUsd: 40e9, holdings: [{ ticker: 'WMT', shares: 751e6, note: 'Walton family trust' }] },
    { name: 'Amancio Ortega', slug: 'amancio-ortega', company: 'Inditex (Zara)', title: 'Founder', country: 'Spain', industry: 'Retail', baseNetWorthUsd: 122e9, holdings: [] },
    { name: 'Carlos Slim', slug: 'carlos-slim', company: 'Grupo Carso', title: 'Chairman', country: 'Mexico', industry: 'Telecom', baseNetWorthUsd: 112e9, holdings: [] },
    { name: 'Bill Gates', slug: 'bill-gates', company: 'Cascade Investment', title: 'Co-chair, Gates Foundation', country: 'US', industry: 'Technology', baseNetWorthUsd: 79e9, holdings: [{ ticker: 'MSFT', shares: 50e6, note: 'Greatly reduced over years' }] },
    { name: 'Mukesh Ambani', slug: 'mukesh-ambani', company: 'Reliance Industries', title: 'Chairman', country: 'India', industry: 'Conglomerate', baseNetWorthUsd: 91e9, holdings: [] },
    { name: 'Francoise Bettencourt Meyers', slug: 'francoise-bettencourt', company: "L'Oreal", title: 'Chairwoman', country: 'France', industry: 'Consumer', baseNetWorthUsd: 81e9, holdings: [] },
    { name: 'Michael Bloomberg', slug: 'michael-bloomberg', company: 'Bloomberg LP', title: 'Co-founder & CEO', country: 'US', industry: 'Media', baseNetWorthUsd: 95e9, holdings: [] },
    { name: 'Gautam Adani', slug: 'gautam-adani', company: 'Adani Group', title: 'Chairman', country: 'India', industry: 'Industrial', baseNetWorthUsd: 76e9, holdings: [] },
    { name: 'Phil Knight', slug: 'phil-knight', company: 'Nike', title: 'Chairman Emeritus', country: 'US', industry: 'Consumer', baseNetWorthUsd: 32e9, holdings: [{ ticker: 'NKE', shares: 250e6, note: 'Class A shares' }] },
    { name: 'Ken Griffin', slug: 'ken-griffin', company: 'Citadel', title: 'CEO', country: 'US', industry: 'Finance', baseNetWorthUsd: 45e9, holdings: [] },
    { name: 'MacKenzie Scott', slug: 'mackenzie-scott', company: 'Philanthropist', title: 'Author & Philanthropist', country: 'US', industry: 'Philanthropy', baseNetWorthUsd: 25e9, holdings: [{ ticker: 'AMZN', shares: 56e6, note: 'Post-divorce, reduced by giving' }] },
    { name: 'Reed Hastings', slug: 'reed-hastings', company: 'Netflix', title: 'Executive Chairman', country: 'US', industry: 'Entertainment', baseNetWorthUsd: 2e9, holdings: [{ ticker: 'NFLX', shares: 55e6, note: 'Post 10:1 split' }] },
  ];

  for (const b of BILLIONAIRES) {
    await prisma.billionaire.upsert({
      where: { name: b.name },
      create: { name: b.name, slug: b.slug, company: b.company, title: b.title, country: b.country, industry: b.industry, baseNetWorthUsd: b.baseNetWorthUsd, holdings: JSON.stringify(b.holdings), source: 'bloomberg' },
      update: {},
    });
  }
  console.log(`[Init] Seeded ${BILLIONAIRES.length} billionaires`);
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
  registerJobHandler('value_radar', backfillValueRadar);
  registerJobHandler('value_radar_alerts', evaluateValueRadarAlerts);
  registerJobHandler('value_radar_digest', sendValueRadarDigest);
  registerJobHandler('earnings_alerts', sendEarningsAlerts);
  registerJobHandler('milestone_check', checkMilestoneAlerts);
  registerJobHandler('anomaly_detection', runAnomalyDetectionForAllUsers);
  registerJobHandler('dividend_change_detection', runDividendChangeDetectionForAllUsers);
  registerJobHandler('creator_reconciliation', runCreatorLedgerReconciliation);
  registerJobHandler('creator_stripe_reconciliation', runCreatorStripeReconciliation);
  registerJobHandler('deep_research_poller', pollActiveResearchJobs);
  registerJobHandler('congress_sync', syncLatestCongressTrades);
  registerJobHandler('congress_alert_eval', checkCongressTradeAlerts);
  registerJobHandler('politician_refresh', refreshPoliticianRoster);
  registerJobHandler('profile_stats_refresh', runProfileStatsRefreshForAllUsers);
  registerJobHandler('billionaire_refresh', refreshAllBillionaires);
  registerJobHandler('billionaire_snapshot', snapshotBillionaires);
  registerJobHandler('webhook_threshold_eval', runWebhookThresholdEvalJob);
  registerJobHandler('job_run_prune', runJobRunPruneJob);
  registerJobHandler('idempotency_key_prune', runIdempotencyKeyPruneJob);
  registerJobHandler('daily_report_pregen', preGenerateDailyReports);
  registerJobHandler('weekly_brief_cycle', runWeeklyBriefCycle);
  registerJobHandler('monthly_brief_cycle', runMonthlyBriefCycle);
  registerJobHandler('analytics_cleanup', async () => {
    const count = await cleanupOldAnalyticsEvents();
    if (count > 0) console.log(`[Analytics] Cleaned up ${count} events older than 90 days`);
  });
  registerJobHandler('stale_data_cleanup', cleanupStaleData);
}

let isShuttingDown = false;

async function shutdown(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`${signal} received, shutting down gracefully`);

  // Stop background refreshers we have explicit handles on.
  stopQuoteRefresh();
  persistQuoteCache();
  await stopFundamentalsPrefetch();

  // NOTE: we used to take a SQLite backup here, but reviewer flagged
  // that ~30 untracked setInterval timers (snapshot scheduler,
  // billionaire refresh, leaderboard, etc.) keep firing and cause
  // WAL-checkpoint busy=1 contention, AND that the 1.4 GB copy can
  // exceed Railway's 10s SIGKILL grace. The daily-cron backup +
  // documented pre-cutover manual snapshot cover the freshness story
  // without the shutdown-path fragility.

  // Disconnect Prisma. Await so the pool teardown completes before
  // Sentry.flush — otherwise a Sentry flush in-flight while Prisma
  // shuts down its libsql worker can race.
  await prisma.$disconnect().catch(() => undefined);

  // Flush Sentry so any captureMessage/Exception posted in the seconds
  // before SIGTERM is not dropped. 2s budget sits comfortably inside
  // Railway's grace window (~10s).
  await Sentry.flush(2000).catch(() => undefined);

  // server.close runs in parallel with the above — it only resolves
  // once in-flight requests drain. Long-polling clients can hold it
  // open; use callback form so we exit when the server's done OR after
  // the disconnect path, whichever wins.
  server.close(() => {
    // Use the write-with-callback form so the line actually flushes to
    // Railway's log pipe before process.exit.
    process.stdout.write('[Shutdown] Complete\n', () => process.exit(0));
  });
}

const server = app.listen(config.port, async () => {
  console.log(`Stock Portfolio API running on http://localhost:${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);

  // Must run before any DB operations — enables concurrent reads + write queuing
  await initSqlitePragmas();

  // Restore candle cache from disk so intelligence 5D/1M works immediately after deploy
  restoreCandleCache();
  const quoteCacheRestoreStartedAt = Date.now();
  restoreQuoteCache();
  console.log(`[Init] Quote cache restore completed in ${Date.now() - quoteCacheRestoreStartedAt}ms`);

  // Fix partially-failed migrations: ensure tables exist, then mark migration as applied.
  // Migration 20260319_add_social_platform failed because ALTER TABLE User (kycVerified)
  // conflicted with existing column, rolling back the CREATE TABLE statements.
  // This block creates the tables idempotently and marks the migration as finished
  // so prisma migrate deploy won't retry it.
  try {
    // 1. Ensure tables exist (idempotent)
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Post" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "content" TEXT NOT NULL, "ticker" TEXT, "type" TEXT NOT NULL DEFAULT 'thought', "attachmentType" TEXT, "attachmentData" TEXT, "deleted" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Post_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Comment" ("id" TEXT NOT NULL PRIMARY KEY, "postId" TEXT NOT NULL, "userId" TEXT NOT NULL, "content" TEXT NOT NULL, "deleted" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post" ("id") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Like" ("id" TEXT NOT NULL PRIMARY KEY, "postId" TEXT NOT NULL, "userId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Like_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post" ("id") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT "Like_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "Like_postId_userId_key" ON "Like"("postId", "userId")`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "SocialNotification" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "actorId" TEXT NOT NULL, "type" TEXT NOT NULL, "postId" TEXT, "message" TEXT NOT NULL, "read" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "SocialNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT "SocialNotification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Post_userId_createdAt_idx" ON "Post"("userId", "createdAt")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Post_createdAt_idx" ON "Post"("createdAt")`);
    // Also ensure PerformanceBadge + ProfileStatsCache from same migration
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "PerformanceBadge" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "badge" TEXT NOT NULL, "window" TEXT NOT NULL, "earnedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" DATETIME, CONSTRAINT "PerformanceBadge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "PerformanceBadge_userId_badge_window_key" ON "PerformanceBadge"("userId", "badge", "window")`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ProfileStatsCache" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL UNIQUE, "winRate" REAL, "totalTrades" INTEGER, "avgHoldDays" REAL, "profitFactor" REAL, "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ProfileStatsCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`);

    // 1b. Add kycVerified / kycVerifiedAt columns to User (may already exist)
    try { await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN "kycVerified" BOOLEAN NOT NULL DEFAULT false`); } catch { /* column already exists */ }
    try { await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN "kycVerifiedAt" DATETIME`); } catch { /* column already exists */ }

    // 1c. Create missing indexes from the migration
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "PerformanceBadge_userId_idx" ON "PerformanceBadge"("userId")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ProfileStatsCache_userId_idx" ON "ProfileStatsCache"("userId")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Post_ticker_createdAt_idx" ON "Post"("ticker", "createdAt")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Comment_postId_createdAt_idx" ON "Comment"("postId", "createdAt")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Comment_userId_idx" ON "Comment"("userId")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Like_postId_idx" ON "Like"("postId")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Like_userId_idx" ON "Like"("userId")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "SocialNotification_userId_read_createdAt_idx" ON "SocialNotification"("userId", "read", "createdAt")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "SocialNotification_userId_createdAt_idx" ON "SocialNotification"("userId", "createdAt")`);

    // 1d. Create CHECK triggers (SQLite doesn't support IF NOT EXISTS for triggers, so wrap in try/catch)
    try {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER post_type_check BEFORE INSERT ON "Post" BEGIN SELECT CASE WHEN NEW."type" NOT IN ('thought', 'analysis', 'trade_idea') THEN RAISE(ABORT, 'Invalid post type') END; END`);
    } catch { /* trigger already exists */ }
    try {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER post_type_check_update BEFORE UPDATE ON "Post" BEGIN SELECT CASE WHEN NEW."type" NOT IN ('thought', 'analysis', 'trade_idea') THEN RAISE(ABORT, 'Invalid post type') END; END`);
    } catch { /* trigger already exists */ }
    try {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER social_notif_type_check BEFORE INSERT ON "SocialNotification" BEGIN SELECT CASE WHEN NEW."type" NOT IN ('new_follower', 'comment', 'like', 'mention') THEN RAISE(ABORT, 'Invalid social notification type') END; END`);
    } catch { /* trigger already exists */ }
    try {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER social_notif_type_check_update BEFORE UPDATE ON "SocialNotification" BEGIN SELECT CASE WHEN NEW."type" NOT IN ('new_follower', 'comment', 'like', 'mention') THEN RAISE(ABORT, 'Invalid social notification type') END; END`);
    } catch { /* trigger already exists */ }

    // 2. Mark the migration as successfully applied if it's stuck as failed
    const migrationRows: any[] = await prisma.$queryRawUnsafe(
      `SELECT id, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = '20260319_add_social_platform'`
    );
    if (migrationRows.length > 0) {
      const m = migrationRows[0];
      if (!m.finished_at || m.rolled_back_at) {
        await prisma.$executeRawUnsafe(
          `UPDATE _prisma_migrations SET finished_at = datetime('now'), rolled_back_at = NULL, applied_steps_count = 1, logs = 'Fixed by app startup - tables created manually' WHERE migration_name = '20260319_add_social_platform'`
        );
        console.log('[Init] Fixed migration 20260319_add_social_platform — marked as applied');
      }
    } else {
      // Migration record doesn't exist at all — insert it
      await prisma.$executeRawUnsafe(
        `INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at, applied_steps_count, logs) VALUES (lower(hex(randomblob(16))), 'manual', '20260319_add_social_platform', datetime('now'), 1, 'Created by app startup')`
      );
      console.log('[Init] Inserted migration record for 20260319_add_social_platform');
    }

    console.log('[Init] Social platform tables + migration state verified');
  } catch (err: any) {
    console.error('[Init] Social table/migration fix failed:', err.message);
  }

  try {
    await assertBillingDeploySafety();
    if (config.billingEnabled) {
      console.log('[Init] Billing deploy safety check passed');
      // Log first-8 hex of SHA-256 of each loaded webhook secret so a future
      // mismatch with Stripe's dashboard fingerprint is detectable in 30s
      // instead of 2 days. Hash is non-reversible; safe to log. Added Apr 26
      // after the silent creator-webhook signature outage.
      const sha8 = (s: string): string =>
        s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 8) : 'EMPTY';
      console.log(`[Init] Stripe webhook secret fingerprints — billing=${sha8(config.stripeWebhookSecret)} connect=${sha8(config.stripeConnectWebhookSecret)}`);
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
  await seedBillionairesIfEmpty().catch(err => console.error('[Init] Failed to seed billionaires:', err.message));
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

  // Persist candle cache to disk every 30 minutes so it survives deploys
  setInterval(() => persistCandleCache(), 30 * 60 * 1000);
  // Also persist on first data load (5 min after startup)
  setTimeout(() => persistCandleCache(), 5 * 60 * 1000);
  setInterval(() => persistQuoteCache(), 60 * 1000);

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

  // Analyst updates â€” check once per day. 24h idempotency key prevents
  // post-deploy startup cron from double-spawning while a run is mid-flight.
  console.log('[Analyst Scheduler] Running every 24 hours');
  setTimeout(() => {
    runJob({
      name: 'analyst_updates',
      fn: runAnalystUpdatesJob,
      idempotencyKey: buildTimeBucketIdempotencyKey('analyst_updates', 24 * 60 * 60 * 1000),
      idempotencyTtlMs: 24 * 60 * 60 * 1000,
    });
  }, 30000);
  setInterval(() => {
    runJob({
      name: 'analyst_updates',
      fn: runAnalystUpdatesJob,
      idempotencyKey: buildTimeBucketIdempotencyKey('analyst_updates', 24 * 60 * 60 * 1000),
      idempotencyTtlMs: 24 * 60 * 60 * 1000,
    });
  }, 24 * 60 * 60 * 1000);

  // Alpha Vantage: Economic indicators â€” refresh daily (5 API calls).
  // Idempotency key bucketed to 24h prevents the post-deploy startup cron from
  // double-spawning while a previous run is still mid-flight (orphaned by deploy).
  console.log('[AV Economic] Running daily');
  setTimeout(() => {
    runJob({
      name: 'economic_indicators',
      fn: refreshEconomicIndicators,
      idempotencyKey: buildTimeBucketIdempotencyKey('economic_indicators', 24 * 60 * 60 * 1000),
      idempotencyTtlMs: 24 * 60 * 60 * 1000,
    });
  }, 60000);
  setInterval(() => {
    runJob({
      name: 'economic_indicators',
      fn: refreshEconomicIndicators,
      idempotencyKey: buildTimeBucketIdempotencyKey('economic_indicators', 24 * 60 * 60 * 1000),
      idempotencyTtlMs: 24 * 60 * 60 * 1000,
    });
  }, 24 * 60 * 60 * 1000);

  // World Bank: International economic indicators â€” refresh daily (6 API calls, no key needed).
  // 24h idempotency key prevents post-deploy startup cron from double-spawning mid-flight.
  console.log('[WB International] Running daily');
  setTimeout(() => {
    runJob({
      name: 'international_indicators',
      fn: refreshInternationalIndicators,
      idempotencyKey: buildTimeBucketIdempotencyKey('international_indicators', 24 * 60 * 60 * 1000),
      idempotencyTtlMs: 24 * 60 * 60 * 1000,
    });
  }, 90000);
  setInterval(() => {
    runJob({
      name: 'international_indicators',
      fn: refreshInternationalIndicators,
      idempotencyKey: buildTimeBucketIdempotencyKey('international_indicators', 24 * 60 * 60 * 1000),
      idempotencyTtlMs: 24 * 60 * 60 * 1000,
    });
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

  // Screener Universe bootstrap — first-deploy ingest of bundled Finviz themes
  // into ScreenerUniverse. Idempotent: skips if rows exist. Fire-and-forget.
  setTimeout(() => { void bootstrapScreenerUniverseIfEmpty(); }, 5000);

  // Polygon Screener backfill — fetch EPS, dividends, beta, 52W range on startup + every 12 hours
  console.log('[Polygon Screener] Backfill scheduled');
  setTimeout(() => {
    runJob({ name: 'polygon_screener', fn: backfillPolygonScreenerData });
  }, 180000); // 180s delay after startup
  setInterval(() => {
    runJob({ name: 'polygon_screener', fn: backfillPolygonScreenerData });
  }, 12 * 60 * 60 * 1000); // Every 12 hours

  // Value Radar backfill — compute 10Y avg P/E on startup + every 24 hours
  console.log('[Value Radar] Backfill scheduled');
  setTimeout(() => {
    runJob({ name: 'value_radar', fn: backfillValueRadar });
  }, 210000); // 210s delay (after screener)
  setInterval(() => {
    runJob({ name: 'value_radar', fn: backfillValueRadar });
  }, 24 * 60 * 60 * 1000);

  // Value Radar alerts — detect deep_value transitions every 30 min (market hours only)
  console.log('[Value Radar Alerts] Scheduled every 30 min');
  setTimeout(() => {
    if (isWeekendET()) return;
    runJob({ name: 'value_radar_alerts', fn: evaluateValueRadarAlerts, maxAttempts: 1 });
  }, 240000); // 240s (after value radar backfill starts)
  setInterval(() => {
    if (isWeekendET()) return;
    runJob({ name: 'value_radar_alerts', fn: evaluateValueRadarAlerts, maxAttempts: 1 });
  }, 30 * 60 * 1000);

  // Value Radar daily digest — single morning notification summarizing tier changes
  console.log('[Value Radar Digest] Scheduled daily');
  setInterval(() => {
    if (isWeekendET()) return;
    const etTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = etTime.getHours();
    const min = etTime.getMinutes();
    // Only fire near market open (9:30-10:00 AM ET)
    if (hour === 9 && min >= 30 || hour === 10 && min < 1) {
      runJob({ name: 'value_radar_digest', fn: sendValueRadarDigest, maxAttempts: 1,
        idempotencyKey: `value_radar_digest:${new Date().toISOString().slice(0, 10)}`,
        idempotencyTtlMs: 24 * 60 * 60 * 1000 });
    }
  }, 30 * 60 * 1000); // Check every 30 min; idempotency ensures one-per-day

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

    // Stripe-side reconciliation — daily cross-check vs Stripe transfers
    // + charge balance transactions. Detects "ghost" transfers (Stripe has,
    // we don't — the audit-C2 double-pay symptom) and missing transfers,
    // amount mismatches, reversal-status mismatches, and per-charge ledger
    // gaps. Staggered from the internal recon by 1 minute.
    console.log('[Creator Stripe Reconciliation] Running daily');
    setTimeout(() => {
      runJob({
        name: 'creator_stripe_reconciliation',
        fn: runCreatorStripeReconciliation,
        idempotencyKey: buildTimeBucketIdempotencyKey('creator_stripe_reconciliation', 24 * 60 * 60 * 1000),
        idempotencyTtlMs: 24 * 60 * 60 * 1000,
        maxAttempts: 3,
      });
    }, 240000); // 4 min delay after startup (1 min after internal recon)

    setInterval(() => {
      runJob({
        name: 'creator_stripe_reconciliation',
        fn: runCreatorStripeReconciliation,
        idempotencyKey: buildTimeBucketIdempotencyKey('creator_stripe_reconciliation', 24 * 60 * 60 * 1000),
        idempotencyTtlMs: 24 * 60 * 60 * 1000,
        maxAttempts: 3,
      });
    }, 24 * 60 * 60 * 1000);
  } else {
    console.log('[Creator Reconciliation] Skipped (creator monetization disabled)');
    console.log('[Creator Stripe Reconciliation] Skipped (creator monetization disabled)');
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

  // Politician roster refresh — pull latest legislators-current.json from
  // unitedstates/congress-legislators every 7 days. Also runs once 90s after
  // boot so a brand-new instance gets the roster without waiting a week.
  console.log('[Politician Refresh] Running weekly (7d), seed run at +90s');
  const POLITICIAN_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
  setTimeout(() => {
    runJob({ name: 'politician_refresh', fn: refreshPoliticianRoster, maxAttempts: 2, idempotencyKey: buildTimeBucketIdempotencyKey('politician_refresh', POLITICIAN_REFRESH_MS), idempotencyTtlMs: POLITICIAN_REFRESH_MS });
  }, 90 * 1000);
  setInterval(() => {
    runJob({ name: 'politician_refresh', fn: refreshPoliticianRoster, maxAttempts: 2, idempotencyKey: buildTimeBucketIdempotencyKey('politician_refresh', POLITICIAN_REFRESH_MS), idempotencyTtlMs: POLITICIAN_REFRESH_MS });
  }, POLITICIAN_REFRESH_MS);

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

  // Stale data cleanup — purge old snapshots, logs, job runs daily to prevent SQLITE_FULL
  console.log('[Cleanup] Scheduled daily');
  setTimeout(() => {
    runJob({
      name: 'stale_data_cleanup',
      fn: cleanupStaleData,
      maxAttempts: 2,
      idempotencyKey: buildTimeBucketIdempotencyKey('stale_data_cleanup', 24 * 60 * 60 * 1000),
      idempotencyTtlMs: 24 * 60 * 60 * 1000,
    });
  }, 60000); // 60s delay after startup
  setInterval(() => {
    runJob({
      name: 'stale_data_cleanup',
      fn: cleanupStaleData,
      maxAttempts: 2,
      idempotencyKey: buildTimeBucketIdempotencyKey('stale_data_cleanup', 24 * 60 * 60 * 1000),
      idempotencyTtlMs: 24 * 60 * 60 * 1000,
    });
  }, 24 * 60 * 60 * 1000);

  // Daily Report pre-generation — gated by market state
  console.log('[Daily Report Pre-Gen] Scheduled: every 5 min, state-aware (intraday=20min bucket, otherwise=4h bucket)');
  const TRIGGER_PREGEN = () => {
    const state = getMarketStateET();
    if (state === 'weekend') return;
    const bucketMs = state === 'intraday' ? 20 * 60 * 1000 : 4 * 60 * 60 * 1000;
    runJob({
      name: 'daily_report_pregen',
      fn: preGenerateDailyReports,
      maxAttempts: 1,
      idempotencyKey: buildTimeBucketIdempotencyKey(`daily_report_pregen:${state}`, bucketMs),
      idempotencyTtlMs: bucketMs,
    });
  };
  setTimeout(TRIGGER_PREGEN, 120_000);          // 2 min after startup
  setInterval(TRIGGER_PREGEN, 5 * 60 * 1000);   // every 5 min thereafter

  // Weekly + monthly brief pre-generation. Runs every hour; each cycle finds
  // users whose local time is Sunday 06:00-06:59 (weekly) or the 1st at
  // 06:00-06:59 (monthly) and pre-generates their brief. Hourly idempotency
  // key prevents double-fires if setInterval ticks twice in the same hour.
  console.log('[Brief Scheduler] Scheduled: weekly + monthly every hour');
  setInterval(() => {
    runJob({
      name: 'weekly_brief_cycle',
      fn: runWeeklyBriefCycle,
      maxAttempts: 1,
      idempotencyKey: buildTimeBucketIdempotencyKey('weekly_brief_cycle', 60 * 60 * 1000),
      idempotencyTtlMs: 60 * 60 * 1000,
    });
    runJob({
      name: 'monthly_brief_cycle',
      fn: runMonthlyBriefCycle,
      maxAttempts: 1,
      idempotencyKey: buildTimeBucketIdempotencyKey('monthly_brief_cycle', 60 * 60 * 1000),
      idempotencyTtlMs: 60 * 60 * 1000,
    });
  }, 60 * 60 * 1000);

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

  // Database backup — daily automated backup of SQLite database
  console.log('[Backup] Scheduled daily');
  setTimeout(() => backupDatabase(), 30000);
  setInterval(() => backupDatabase(), 24 * 60 * 60 * 1000);

  // v1↔v2 ledger reconciliation — daily drift check during shadow-write
  // epoch. No-op if V2_DATABASE_URL is not set. Delete this call once
  // post-cutover and v1 is fully decommissioned.
  scheduleV2ReconcileDaily();
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch(err => {
    console.error('[Shutdown] SIGTERM handler failed:', err);
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch(err => {
    console.error('[Shutdown] SIGINT handler failed:', err);
    process.exit(1);
  });
});



