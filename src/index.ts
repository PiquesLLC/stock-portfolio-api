import app from './app';
import { config } from './config';
import { ensureBenchmarksCached } from './utils/candle-cache';
import { createSnapshotIfNeeded } from './services/snapshot.service';
import { syncAllHeldTickers } from './services/dividend-fetch.service';
import { postDividendsForDate } from './services/dividend-post.service';
import { evaluatePriceAlerts } from './services/priceAlert.service';

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
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
