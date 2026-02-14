import app from './app';
import { config } from './config';
import { ensureBenchmarksCached } from './utils/candle-cache';
import { createSnapshotIfNeeded } from './services/snapshot.service';
import { backfillLeaderboardDemoData } from './services/demo-data.service';
import { syncAllHeldTickers } from './services/dividend-fetch.service';
import { postDividendsForDate } from './services/dividend-post.service';
import { evaluatePriceAlerts } from './services/priceAlert.service';
import { checkAnalystUpdates } from './services/analyst.service';
import { checkMilestoneAlerts } from './services/milestone.service';
import { detectAnomalies, detectDividendChanges } from './services/anomaly-detection.service';
import { getMarketSession } from './utils/market-hours';
import prisma from './utils/prisma';
import { refreshEconomicIndicators, refreshInternationalIndicators } from './services/economic.service';
import { rotateTickerFundamentals } from './services/fundamentals.service';
import { backfillHeatmapFundamentals } from './services/market-heatmap-fundamentals.service';
import { sendEarningsAlerts } from './services/notifications.service';

const DEFAULT_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

// Ensure the legacy default user exists (many services reference this hardcoded ID)
async function ensureDefaultUser(): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { id: DEFAULT_USER_ID } });
  if (!existing) {
    await prisma.user.create({
      data: {
        id: DEFAULT_USER_ID,
        username: '_system',
        displayName: 'My Portfolio',
        profilePublic: false,
      },
    });
    console.log('[Init] Created default system user');
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

  const updates: { leaderboardEligible?: boolean; profilePublic?: boolean; trackingStartAt?: Date } = {};
  if (!user.leaderboardEligible) updates.leaderboardEligible = true;
  if (!user.profilePublic) updates.profilePublic = true;
  if (user.trackingStartAt?.getTime() !== trackingStartAt.getTime()) {
    updates.trackingStartAt = trackingStartAt;
  }

  if (Object.keys(updates).length > 0) {
    await prisma.user.update({ where: { id: DEFAULT_USER_ID }, data: updates });
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

const server = app.listen(config.port, async () => {
  console.log(`Stock Portfolio API running on http://localhost:${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);

  // Ensure default system user exists before any schedulers run
  await ensureDefaultUser().catch(err => console.error('[Init] Failed to create default user:', err.message));
  await ensureDefaultUserLeaderboard().catch(err => console.error('[Init] Failed to enable leaderboard for system user:', err.message));

  // One-time cleanup of incorrectly migrated holdings
  await cleanupMigratedHoldings().catch(err => console.error('[Cleanup] Failed:', err.message));

  // Cache benchmark data on startup and every 6 hours
  ensureBenchmarksCached().catch(err => console.error('Benchmark cache init failed:', err));
  setInterval(() => {
    ensureBenchmarksCached().catch(err => console.error('Benchmark cache refresh failed:', err));
  }, 6 * 60 * 60 * 1000);

  // Background snapshot scheduler â€” creates portfolio snapshots even when
  // no browser is connected, so the 1D chart never has gaps.
  const SNAPSHOT_INTERVAL_MS = config.snapshotIntervalSeconds * 1000;
  console.log(`[Snapshot Scheduler] Running every ${config.snapshotIntervalSeconds}s`);
  setInterval(() => {
    createSnapshotIfNeeded().catch(err => {
      // Only log non-routine errors (quotes unavailable is expected outside market hours)
      if (err?.message && !err.message.includes('quotes')) {
        console.error('[Snapshot Scheduler] Error:', err.message);
      }
    });
  }, SNAPSHOT_INTERVAL_MS);

  // Demo leaderboard data backfill â€” holdings + snapshots + activity events
  setTimeout(() => {
    backfillLeaderboardDemoData().catch(err =>
      console.error('[Demo Data] Backfill failed:', (err as Error).message)
    );
  }, 60000); // 60s delay after startup

  // Dividend sync â€” fetch dividend events from Yahoo Finance on startup + every 6 hours
  syncAllHeldTickers().catch(err => console.error('[Dividend Sync] Init failed:', err));
  setInterval(() => {
    syncAllHeldTickers().catch(err => console.error('[Dividend Sync] Error:', err));
  }, 6 * 60 * 60 * 1000);

  // Dividend posting â€” check for payable dividends every hour (today's date only)
  postDividendsForDate().catch(err => console.error('[Dividend Post] Init failed:', err));
  // NOTE: backfillMissedDividends removed â€” it double-counts dividends already
  // reflected in historical stock prices, inflating portfolio value via DRIP.
  setInterval(() => {
    postDividendsForDate().catch(err => console.error('[Dividend Post] Error:', err));
  }, 60 * 60 * 1000);

  // Price alert evaluation â€” check every 60 seconds
  console.log('[Price Alert Scheduler] Running every 60s');
  setInterval(() => {
    evaluatePriceAlerts().catch(err =>
      console.error('[Price Alerts] Error:', err.message)
    );
  }, 60000);

  // Analyst updates â€” check once per day (every 24 hours)
  // Also run on startup after a short delay
  console.log('[Analyst Scheduler] Running every 24 hours');
  setTimeout(async () => {
    try {
      const tickers = await getAllHeldTickers();
      await checkAnalystUpdates(tickers);
    } catch (err: any) {
      console.error('[Analyst Scheduler] Startup check failed:', err.message);
    }
  }, 30000); // 30 second delay after startup

  setInterval(async () => {
    try {
      const tickers = await getAllHeldTickers();
      await checkAnalystUpdates(tickers);
    } catch (err: any) {
      console.error('[Analyst Scheduler] Error:', err.message);
    }
  }, 24 * 60 * 60 * 1000); // Every 24 hours

  // Alpha Vantage: Economic indicators â€” refresh daily (5 API calls)
  console.log('[AV Economic] Running daily');
  setTimeout(() => {
    refreshEconomicIndicators().catch(err =>
      console.error('[AV Economic] Startup refresh failed:', (err as Error).message)
    );
  }, 60000); // 60s delay
  setInterval(() => {
    refreshEconomicIndicators().catch(err =>
      console.error('[AV Economic] Error:', (err as Error).message)
    );
  }, 24 * 60 * 60 * 1000);

  // World Bank: International economic indicators â€” refresh daily (6 API calls, no key needed)
  console.log('[WB International] Running daily');
  setTimeout(() => {
    refreshInternationalIndicators().catch(err =>
      console.error('[WB International] Startup refresh failed:', (err as Error).message)
    );
  }, 90000); // 90s delay
  setInterval(() => {
    refreshInternationalIndicators().catch(err =>
      console.error('[WB International] Error:', (err as Error).message)
    );
  }, 24 * 60 * 60 * 1000);

  // Alpha Vantage: Fundamentals rotation â€” refresh oldest tickers every 6 hours (4 API calls per ticker)
  console.log('[AV Fundamentals] Rotating every 6 hours');
  setTimeout(async () => {
    try {
      const tickers = await getAllHeldTickers();
      await rotateTickerFundamentals(tickers);
    } catch (err) {
      console.error('[AV Fundamentals] Startup rotation failed:', (err as Error).message);
    }
  }, 120000); // 120s delay
  setInterval(async () => {
    try {
      const tickers = await getAllHeldTickers();
      await rotateTickerFundamentals(tickers);
    } catch (err) {
      console.error('[AV Fundamentals] Rotation error:', (err as Error).message);
    }
  }, 6 * 60 * 60 * 1000);

  // Heatmap fundamentals backfill â€” refresh heatmap tickers (missing/stale) on startup + daily
  console.log('[Heatmap Fundamentals] Backfill scheduled');
  setTimeout(() => {
    backfillHeatmapFundamentals().catch(err =>
      console.error('[Heatmap Fundamentals] Startup backfill failed:', (err as Error).message)
    );
  }, 150000); // 150s delay after startup
  setInterval(() => {
    backfillHeatmapFundamentals().catch(err =>
      console.error('[Heatmap Fundamentals] Backfill error:', (err as Error).message)
    );
  }, 24 * 60 * 60 * 1000);

  // Earnings alerts — audit log for upcoming earnings (every 6 hours)
  console.log('[Notifications] Earnings alerts scheduled');
  setTimeout(() => {
    sendEarningsAlerts().catch(err =>
      console.error('[Notifications] Earnings alert run failed:', (err as Error).message)
    );
  }, 90000); // 90s delay after startup
  setInterval(() => {
    sendEarningsAlerts().catch(err =>
      console.error('[Notifications] Earnings alert run failed:', (err as Error).message)
    );
  }, 6 * 60 * 60 * 1000);

  // Milestone alerts (52w high/low, ATH/ATL) â€” using Yahoo Finance for accurate 52w data
  console.log('[Milestone Scheduler] Running every 30 minutes');
  setTimeout(() => {
    checkMilestoneAlerts().catch(err =>
      console.error('[Milestone Scheduler] Startup check failed:', err.message)
    );
  }, 45000);
  setInterval(() => {
    checkMilestoneAlerts().catch(err =>
      console.error('[Milestone Scheduler] Error:', err.message)
    );
  }, 30 * 60 * 1000);

  // AI Anomaly Detection — check every 15 minutes during market hours
  console.log('[Anomaly Detection] Running every 15 minutes (market hours only)');
  setTimeout(() => {
    const session = getMarketSession();
    if (session === 'PRE' || session === 'REG' || session === 'POST') {
      detectAnomalies().catch(err =>
        console.error('[Anomaly Detection] Startup check failed:', err.message)
      );
    }
  }, 120000); // 2 min delay
  setInterval(async () => {
    const session = getMarketSession();
    if (session === 'PRE' || session === 'REG' || session === 'POST') {
      await detectAnomalies().catch(err =>
        console.error('[Anomaly Detection] Error:', err.message)
      );
    }
  }, 15 * 60 * 1000);

  // Dividend change detection — every 6 hours (aligned with dividend sync)
  console.log('[Dividend Change Detection] Running every 6 hours');
  setTimeout(() => {
    detectDividendChanges().catch(err =>
      console.error('[Dividend Change Detection] Init failed:', err.message)
    );
  }, 60000);
  setInterval(() => {
    detectDividendChanges().catch(err =>
      console.error('[Dividend Change Detection] Error:', err.message)
    );
  }, 6 * 60 * 60 * 1000);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});





