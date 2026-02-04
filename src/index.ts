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

const prisma = new PrismaClient();

// Helper to get all unique tickers from holdings
async function getAllHeldTickers(): Promise<string[]> {
  const holdings = await prisma.holding.findMany({
    select: { ticker: true },
    distinct: ['ticker'],
  });
  return holdings.map(h => h.ticker);
}

const server = app.listen(config.port, () => {
  console.log(`Stock Portfolio API running on http://localhost:${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);

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
