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
import prisma from './utils/prisma';
import { refreshEconomicIndicators, refreshInternationalIndicators } from './services/economic.service';
import { rotateTickerFundamentals } from './services/fundamentals.service';
import { backfillHeatmapFundamentals } from './services/market-heatmap-fundamentals.service';
import { backfillPolygonScreenerData } from './services/polygon-screener.service';
import { sendEarningsAlerts } from './services/notifications.service';
import { assertBillingDeploySafety } from './services/billing.service';
import { runCreatorLedgerReconciliation } from './services/creator-reconciliation.service';
import { pollActiveResearchJobs } from './services/deep-research.service';
import { warmHoldingsCache } from './services/market.service';

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
  const existing = await prisma.user.findUnique({ where: { id: DEFAULT_USER_ID } });
  if (!existing) {
    await prisma.user.create({
      data: {
        id: DEFAULT_USER_ID,
        username: '_system',
        displayName: 'System (Seed)',
        profilePublic: false,
      },
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

  // Auto-verify users created before email verification was required.
  // These users can't complete OTP verification and are stuck in a dead end.
  await prisma.user.updateMany({
    where: { emailVerified: false },
    data: { emailVerified: true },
  }).then(r => { if (r.count > 0) console.log(`[Init] Auto-verified ${r.count} pre-existing users`); })
    .catch(err => console.error('[Init] Auto-verify failed:', err.message));

  // One-time cleanup of incorrectly migrated holdings
  await cleanupMigratedHoldings().catch(err => console.error('[Cleanup] Failed:', err.message));

  // ONE-TIME DIAGNOSTIC: Compare production Piques holdings vs expected — remove after checking
  (async () => {
    const userId = '237198da-612e-411c-9ef8-f267c887a9f1';
    const holdings = await prisma.holding.findMany({ where: { userId }, select: { ticker: true, shares: true, averageCost: true }, orderBy: { ticker: 'asc' } });
    const settings = await prisma.userSettings.findUnique({ where: { userId }, select: { cashBalance: true, marginDebt: true } });
    console.log(`[DIAG] Piques holdings (${holdings.length}):`);
    holdings.forEach(h => console.log(`[DIAG]   ${h.ticker.padEnd(6)} shares=${h.shares} avgCost=${h.averageCost}`));
    console.log(`[DIAG] Settings: cash=${settings?.cashBalance} margin=${settings?.marginDebt}`);

    // Expected from local jppiques (the correct account):
    const expected: Record<string, { shares: number; avgCost: number }> = {
      AMZN: { shares: 150, avgCost: 234.05 }, ASML: { shares: 15, avgCost: 1069.38 },
      AXP: { shares: 75.169, avgCost: 373.62 }, BABA: { shares: 60, avgCost: 179.44 },
      CAT: { shares: 20, avgCost: 692.78 }, CSX: { shares: 250, avgCost: 41.02 },
      EEM: { shares: 300, avgCost: 60.13 }, FEZ: { shares: 150, avgCost: 67.9 },
      GOOGL: { shares: 200, avgCost: 192.39 }, LMT: { shares: 30, avgCost: 503.01 },
      MLM: { shares: 20, avgCost: 700 }, MSFT: { shares: 28, avgCost: 412.12 },
      PWR: { shares: 20, avgCost: 530.48 }, RDDT: { shares: 83, avgCost: 199.49 },
      SPY: { shares: 285.211295, avgCost: 542.11 }, TSM: { shares: 70, avgCost: 186.44 },
      VRT: { shares: 60, avgCost: 188.58 }, WMT: { shares: 282.19, avgCost: 98.78 },
    };
    const prodTickers = new Set(holdings.map(h => h.ticker));
    const expectedTickers = new Set(Object.keys(expected));
    for (const t of expectedTickers) { if (!prodTickers.has(t)) console.log(`[DIAG] MISSING: ${t}`); }
    for (const t of prodTickers) { if (!expectedTickers.has(t)) console.log(`[DIAG] EXTRA: ${t}`); }
    for (const h of holdings) {
      const e = expected[h.ticker];
      if (e && (h.shares !== e.shares || h.averageCost !== e.avgCost)) {
        console.log(`[DIAG] MISMATCH ${h.ticker}: prod shares=${h.shares} avgCost=${h.averageCost} vs expected shares=${e.shares} avgCost=${e.avgCost}`);
      }
    }
  })().catch(err => console.error('[DIAG] Failed:', err.message));

  // Cache benchmark data on startup and every 6 hours
  ensureBenchmarksCached()
    .then(() => {
      // After benchmarks are ready, warm holdings cache in background (non-blocking)
      warmHoldingsCache().catch(err => console.error('[Startup] Holdings cache warm failed:', err));
    })
    .catch(err => console.error('Benchmark cache init failed:', err));
  setInterval(() => {
    ensureBenchmarksCached().catch(err => console.error('Benchmark cache refresh failed:', err));
  }, 6 * 60 * 60 * 1000);

  // Background snapshot scheduler â€” creates portfolio snapshots even when
  // no browser is connected, so the 1D chart never has gaps.
  const SNAPSHOT_INTERVAL_MS = config.snapshotIntervalSeconds * 1000;
  console.log(`[Snapshot Scheduler] Running every ${config.snapshotIntervalSeconds}s`);
  setInterval(async () => {
    try {
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
    } catch (err: unknown) {
      console.error('[Snapshot Scheduler] Error fetching users:', (err as Error).message);
    }
  }, SNAPSHOT_INTERVAL_MS);

  // Demo leaderboard data backfill — only runs when DEMO_LEADERBOARD=true (pre-beta).
  // Disable this env var once real users join the leaderboard.
  if (process.env.DEMO_LEADERBOARD === 'true') {
    console.log('[Demo Data] DEMO_LEADERBOARD=true — backfilling demo users');
    setTimeout(() => {
      backfillLeaderboardDemoData().catch(err =>
        console.error('[Demo Data] Backfill failed:', (err as Error).message)
      );
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
    refreshLeaderboardSnapshots().catch(err =>
      console.error('[Leaderboard Refresh] Startup run failed:', (err as Error).message)
    );
  }, 120000); // 2 min delay after startup (backfill may still be running)
  setInterval(() => {
    const session = getMarketSession();
    if (session === 'CLOSED') return;
    refreshLeaderboardSnapshots().catch(err =>
      console.error('[Leaderboard Refresh] Error:', (err as Error).message)
    );
  }, 3 * 60 * 60 * 1000); // Every 3 hours

  // Dividend sync â€" fetch dividend events from Yahoo Finance on startup + every 6 hours (skip weekends)
  if (!isWeekendET()) {
    syncAllHeldTickers().catch(err => console.error('[Dividend Sync] Init failed:', err));
  }
  setInterval(() => {
    if (isWeekendET()) return;
    syncAllHeldTickers().catch(err => console.error('[Dividend Sync] Error:', err));
  }, 6 * 60 * 60 * 1000);

  // Dividend posting â€" check for payable dividends every hour (skip weekends — no pay dates)
  if (!isWeekendET()) {
    postDividendsForDate().catch(err => console.error('[Dividend Post] Init failed:', err));
  }
  // NOTE: backfillMissedDividends removed â€" it double-counts dividends already
  // reflected in historical stock prices, inflating portfolio value via DRIP.
  setInterval(() => {
    if (isWeekendET()) return;
    postDividendsForDate().catch(err => console.error('[Dividend Post] Error:', err));
  }, 60 * 60 * 1000);

  // Price alert evaluation â€" check every 60 seconds (skip weekends — prices are stale)
  console.log('[Price Alert Scheduler] Running every 60s');
  setInterval(() => {
    if (isWeekendET()) return;
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

  // Polygon Screener backfill — fetch EPS, dividends, beta, 52W range on startup + every 12 hours
  console.log('[Polygon Screener] Backfill scheduled');
  setTimeout(() => {
    backfillPolygonScreenerData().catch(err =>
      console.error('[Polygon Screener] Startup backfill failed:', (err as Error).message)
    );
  }, 180000); // 180s delay after startup
  setInterval(() => {
    backfillPolygonScreenerData().catch(err =>
      console.error('[Polygon Screener] Backfill error:', (err as Error).message)
    );
  }, 12 * 60 * 60 * 1000); // Every 12 hours

  // Earnings alerts — audit log for upcoming earnings (every 6 hours, skip weekends)
  console.log('[Notifications] Earnings alerts scheduled');
  setTimeout(() => {
    if (isWeekendET()) return;
    sendEarningsAlerts().catch(err =>
      console.error('[Notifications] Earnings alert run failed:', (err as Error).message)
    );
  }, 90000); // 90s delay after startup
  setInterval(() => {
    if (isWeekendET()) return;
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

  // AI Anomaly Detection — check every 15 minutes during market hours (all users)
  console.log('[Anomaly Detection] Running every 15 minutes (market hours only)');
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
  setTimeout(() => {
    runAnomalyDetectionForAllUsers().catch(err =>
      console.error('[Anomaly Detection] Startup check failed:', (err as Error).message)
    );
  }, 120000); // 2 min delay
  setInterval(() => {
    runAnomalyDetectionForAllUsers().catch(err =>
      console.error('[Anomaly Detection] Error:', (err as Error).message)
    );
  }, 15 * 60 * 1000);

  // Dividend change detection — every 6 hours (skip weekends — no new dividend data, all users)
  console.log('[Dividend Change Detection] Running every 6 hours');
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
  setTimeout(() => {
    runDividendChangeDetectionForAllUsers().catch(err =>
      console.error('[Dividend Change Detection] Init failed:', (err as Error).message)
    );
  }, 60000);
  setInterval(() => {
    runDividendChangeDetectionForAllUsers().catch(err =>
      console.error('[Dividend Change Detection] Error:', (err as Error).message)
    );
  }, 6 * 60 * 60 * 1000);

  // Creator reconciliation — daily ledger vs subscription consistency audit.
  // This is a safety-net process and does not mutate data.
  if (config.creatorMonetizationEnabled) {
    console.log('[Creator Reconciliation] Running daily');
    setTimeout(() => {
      runCreatorLedgerReconciliation().catch(err =>
        console.error('[Creator Reconciliation] Startup run failed:', (err as Error).message)
      );
    }, 180000); // 3 min delay after startup

    setInterval(() => {
      runCreatorLedgerReconciliation().catch(err =>
        console.error('[Creator Reconciliation] Daily run failed:', (err as Error).message)
      );
    }, 24 * 60 * 60 * 1000);
  } else {
    console.log('[Creator Reconciliation] Skipped (creator monetization disabled)');
  }

  // NALA AI Deep Research — background poller for Gemini async jobs
  if (config.deepResearchEnabled) {
    console.log(`[Deep Research] Poller running every ${config.deepResearchPollIntervalMs / 1000}s`);
    setInterval(() => {
      pollActiveResearchJobs().catch(err =>
        console.error('[Deep Research] Poll error:', err instanceof Error ? err.message : err)
      );
    }, config.deepResearchPollIntervalMs);
  } else {
    console.log('[Deep Research] Disabled (DEEP_RESEARCH_ENABLED not set)');
  }
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});



