import app from './app';
import { config } from './config';
import { ensureBenchmarksCached } from './utils/candle-cache';
import { createSnapshotIfNeeded } from './services/snapshot.service';
import { syncAllHeldTickers } from './services/dividend-fetch.service';
import { postDividendsForDate } from './services/dividend-post.service';
import { evaluatePriceAlerts } from './services/priceAlert.service';
import { checkAnalystUpdates } from './services/analyst.service';
import { checkMilestoneAlerts } from './services/milestone.service';
import { PrismaClient } from '@prisma/client';
import { refreshEconomicIndicators, refreshInternationalIndicators } from './services/economic.service';
import { rotateTickerFundamentals } from './services/fundamentals.service';

const prisma = new PrismaClient();

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

// One-time migration: copy holdings from the default system user to real users who have none.
// This fixes the bug where holdings were saved under the hardcoded default user instead of the
// authenticated user's ID.
async function migrateDefaultHoldingsToUsers(): Promise<void> {
  const defaultHoldings = await prisma.holding.findMany({
    where: { userId: DEFAULT_USER_ID },
  });
  if (defaultHoldings.length === 0) return;

  // Find all real users (not the system user) who have zero holdings
  const realUsers = await prisma.user.findMany({
    where: { id: { not: DEFAULT_USER_ID }, username: { not: '_system' } },
    select: { id: true, username: true },
  });

  for (const user of realUsers) {
    const userHoldings = await prisma.holding.count({ where: { userId: user.id } });
    if (userHoldings === 0) {
      // Copy all default holdings to this user
      for (const h of defaultHoldings) {
        await prisma.holding.create({
          data: {
            ticker: h.ticker,
            shares: h.shares,
            averageCost: h.averageCost,
            userId: user.id,
          },
        });
      }
      // Also copy settings (cash balance, margin debt)
      const defaultSettings = await prisma.settings.findUnique({ where: { id: 'default' } });
      if (defaultSettings) {
        await prisma.userSettings.upsert({
          where: { userId: user.id },
          update: { cashBalance: defaultSettings.cashBalance, marginDebt: defaultSettings.marginDebt ?? 0 },
          create: { userId: user.id, cashBalance: defaultSettings.cashBalance, marginDebt: defaultSettings.marginDebt ?? 0 },
        });
      }
      console.log(`[Migration] Copied ${defaultHoldings.length} holdings to user ${user.username} (${user.id})`);
    }
  }
}

// Helper to get all unique tickers from holdings
async function getAllHeldTickers(): Promise<string[]> {
  const holdings = await prisma.holding.findMany({
    select: { ticker: true },
    distinct: ['ticker'],
  });
  return holdings.map(h => h.ticker);
}

const server = app.listen(config.port, async () => {
  console.log(`Stock Portfolio API running on http://localhost:${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);

  // Ensure default system user exists before any schedulers run
  await ensureDefaultUser().catch(err => console.error('[Init] Failed to create default user:', err.message));

  // Migrate holdings from default user to real users (one-time fix)
  await migrateDefaultHoldingsToUsers().catch(err => console.error('[Migration] Failed:', err.message));

  // Cache benchmark data on startup and every 6 hours
  ensureBenchmarksCached().catch(err => console.error('Benchmark cache init failed:', err));
  setInterval(() => {
    ensureBenchmarksCached().catch(err => console.error('Benchmark cache refresh failed:', err));
  }, 6 * 60 * 60 * 1000);

  // Background snapshot scheduler — creates portfolio snapshots even when
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

  // Dividend sync — fetch dividend events from Yahoo Finance on startup + every 6 hours
  syncAllHeldTickers().catch(err => console.error('[Dividend Sync] Init failed:', err));
  setInterval(() => {
    syncAllHeldTickers().catch(err => console.error('[Dividend Sync] Error:', err));
  }, 6 * 60 * 60 * 1000);

  // Dividend posting — check for payable dividends every hour
  postDividendsForDate().catch(err => console.error('[Dividend Post] Init failed:', err));
  setInterval(() => {
    postDividendsForDate().catch(err => console.error('[Dividend Post] Error:', err));
  }, 60 * 60 * 1000);

  // Price alert evaluation — check every 60 seconds
  console.log('[Price Alert Scheduler] Running every 60s');
  setInterval(() => {
    evaluatePriceAlerts().catch(err =>
      console.error('[Price Alerts] Error:', err.message)
    );
  }, 60000);

  // Analyst updates — check once per day (every 24 hours)
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

  // Alpha Vantage: Economic indicators — refresh daily (5 API calls)
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

  // World Bank: International economic indicators — refresh daily (6 API calls, no key needed)
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

  // Alpha Vantage: Fundamentals rotation — refresh oldest tickers every 6 hours (4 API calls per ticker)
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

  // Milestone alerts (52w high/low, ATH/ATL) — using Yahoo Finance for accurate 52w data
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
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
