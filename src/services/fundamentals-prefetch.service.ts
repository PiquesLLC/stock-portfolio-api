/**
 * Fundamentals Prefetch Service
 *
 * Background worker that continuously cycles through a broad stock universe,
 * pre-fetching and caching fundamentals + earnings data so it's ready when
 * users search for or view a stock.
 *
 * Priority order:
 *   1. User holdings (active positions)
 *   2. Stale cache entries (>7 days old)
 *   3. Never-fetched tickers from the sector universe
 *
 * Rate-limit aware: processes one ticker per cycle with delays to respect
 * Polygon (unlimited/5 per min), Finnhub (60/min), and AV (25/day) limits.
 *
 * Codex-reviewed safeguards:
 *   - Skip list with backoff for tickers that fail repeatedly (prevents starvation)
 *   - Never consumes AV budget — always forces Finnhub fallback for background earnings
 *   - Ticker normalization to uppercase
 *   - Targeted DB queries (no full-table scans)
 *   - Graceful shutdown awaits in-flight cycle
 */

import prisma from '../utils/prisma';
import { refreshFundamentalsForTicker } from './polygon-fundamentals.service';
import { subSectorGroups } from '../utils/sectors';
import { JobExecutionError, runJob } from './job-runner.service';

const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CYCLE_DELAY_MS = 15_000; // 15s between tickers (4/min — safe for all APIs)
const STARTUP_DELAY_MS = 300_000; // 5 min after server start
const SKIP_BACKOFF_MS = 2 * 60 * 60 * 1000; // Skip failed tickers for 2 hours
const MAX_FAILURES = 3; // After 3 failures, back off
const LOG_PREFIX = '[Prefetch]';
const IDLE_DELAY_MS = 10 * 60 * 1000;

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let stats = { cycleCount: 0, tickersFetched: 0, errors: 0, skipped: 0, lastTicker: '', lastRun: '' };

// Track tickers that fail repeatedly to avoid starvation (Codex finding #1)
const failureMap = new Map<string, { count: number; lastAttempt: number }>();

/** Check if a ticker should be skipped due to repeated failures */
function shouldSkip(ticker: string): boolean {
  const f = failureMap.get(ticker);
  if (!f || f.count < MAX_FAILURES) return false;
  // Allow retry after backoff period
  if (Date.now() - f.lastAttempt > SKIP_BACKOFF_MS) {
    failureMap.delete(ticker);
    return false;
  }
  return true;
}

/** Record a failure for a ticker */
function recordFailure(ticker: string): void {
  const f = failureMap.get(ticker) ?? { count: 0, lastAttempt: 0 };
  f.count++;
  f.lastAttempt = Date.now();
  failureMap.set(ticker, f);
}

/** Record success — clear failure history */
function recordSuccess(ticker: string): void {
  failureMap.delete(ticker);
}

// Cache the sector universe in memory (Codex finding #5 — avoid rebuilding every cycle)
let _universeCache: string[] | null = null;

function getSectorUniverse(): string[] {
  if (_universeCache) return _universeCache;
  const tickers = new Set<string>();
  for (const sector of Object.values(subSectorGroups)) {
    for (const group of Object.values(sector)) {
      for (const t of (group as string[])) tickers.add(t.toUpperCase());
    }
  }
  _universeCache = Array.from(tickers).sort();
  return _universeCache;
}

/**
 * Pick the next ticker to prefetch based on priority.
 * Uses targeted queries — no full-table scans (Codex finding #5).
 * Normalizes tickers to uppercase (Codex finding #6).
 */
async function pickNextTicker(): Promise<{ ticker: string; reason: string } | null> {
  const staleThreshold = new Date(Date.now() - STALE_MS);

  // Priority 1: User holdings missing or stale fundamentals/earnings
  const heldTickers = await prisma.holding.findMany({
    select: { ticker: true },
    distinct: ['ticker'],
    where: { shares: { gt: 0 } },
  });
  const held = heldTickers.map(h => h.ticker.toUpperCase()); // Codex finding #6

  if (held.length > 0) {
    const cached = await prisma.fundamentalsCache.findMany({
      where: { ticker: { in: held } },
      select: { ticker: true, lastFetchedAt: true, overviewJson: true, earningsJson: true },
    });
    const cacheMap = new Map(cached.map(c => [c.ticker, c]));

    for (const t of held) {
      if (shouldSkip(t)) continue;
      const c = cacheMap.get(t);
      if (!c || !c.overviewJson) return { ticker: t, reason: 'holding-no-fundamentals' };
      if (new Date(c.lastFetchedAt) < staleThreshold) return { ticker: t, reason: 'holding-stale' };
    }
    for (const t of held) {
      if (shouldSkip(t)) continue;
      const c = cacheMap.get(t);
      if (!c?.earningsJson) return { ticker: t, reason: 'holding-no-earnings' };
    }
  }

  // Priority 2 & 3: Sector universe — targeted query (only universe tickers)
  const universe = getSectorUniverse();
  const universeCached = await prisma.fundamentalsCache.findMany({
    where: { ticker: { in: universe } },
    select: { ticker: true, lastFetchedAt: true, overviewJson: true, earningsJson: true },
  });
  const uMap = new Map(universeCached.map(c => [c.ticker, c]));

  // Missing or stale fundamentals
  for (const t of universe) {
    if (shouldSkip(t)) continue;
    const c = uMap.get(t);
    if (!c || !c.overviewJson) return { ticker: t, reason: 'universe-no-fundamentals' };
    if (new Date(c.lastFetchedAt) < staleThreshold) return { ticker: t, reason: 'universe-stale' };
  }

  // Missing earnings
  for (const t of universe) {
    if (shouldSkip(t)) continue;
    const c = uMap.get(t);
    if (!c?.earningsJson) return { ticker: t, reason: 'universe-no-earnings' };
  }

  return null;
}

/**
 * Fetch earnings via Finnhub only — never consume AV budget (Codex finding #3).
 * AV's 25 calls/day are reserved for user-driven interactive requests.
 */
async function prefetchEarnings(ticker: string): Promise<void> {
  const { finnhubQueue } = await import('../utils/finnhub-queue');
  const { config } = await import('../config');

  // If no Finnhub key, write empty sentinel so picker moves on (Codex re-review #3)
  if (!config.finnhubApiKey) {
    const empty = { quarterly: [], annual: [] };
    await prisma.fundamentalsCache.upsert({
      where: { ticker },
      update: { earningsJson: JSON.stringify(empty) },
      create: { ticker, earningsJson: JSON.stringify(empty), lastFetchedAt: new Date() },
    });
    return;
  }

  // Use Finnhub queue for rate limiting (Codex finding #4)
  const historical = await finnhubQueue.request<Array<{
    actual: number | null; estimate: number | null; period: string;
    surprise: number | null; surprisePercent: number | null;
  }>>('/stock/earnings', { symbol: ticker });

  const quarterly = (historical || [])
    .filter(h => h.period)
    .map(h => ({
      fiscalDateEnding: h.period,
      reportedDate: h.period,
      reportedEPS: h.actual ?? null,
      estimatedEPS: h.estimate ?? null,
      surprise: h.surprise ?? null,
      surprisePercentage: h.surprisePercent ?? null,
      reportTime: '',
      beat: h.surprise != null ? h.surprise > 0 : null,
    }))
    .sort((a, b) => b.fiscalDateEnding.localeCompare(a.fiscalDateEnding));

  // Write sentinel even if empty so picker doesn't re-select forever (Codex re-review #1)
  const earningsData = { quarterly, annual: [] as Array<{ fiscalDateEnding: string; reportedEPS: number | null }> };

  await prisma.fundamentalsCache.upsert({
    where: { ticker },
    update: { earningsJson: JSON.stringify(earningsData) },
    create: { ticker, earningsJson: JSON.stringify(earningsData), lastFetchedAt: new Date() },
  });
}

/** Prefetch fundamentals + earnings for a single ticker */
async function prefetchTicker(ticker: string, reason: string): Promise<void> {
  const needsFundamentals = reason.includes('fundamentals') || reason.includes('stale');
  const needsEarnings = reason.includes('earnings') || reason.includes('stale');

  if (needsFundamentals) {
    await refreshFundamentalsForTicker(ticker);
  }

  if (needsEarnings) {
    await prefetchEarnings(ticker);
  }
}

function classifyPrefetchError(err: unknown): JobExecutionError {
  if (err instanceof JobExecutionError) return err;

  const e = err as {
    message?: string;
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };
  const message = e?.message || String(err || 'Unknown prefetch error');
  const status = e?.status ?? e?.statusCode ?? e?.response?.status;
  const msg = message.toLowerCase();

  if (status === 429 || msg.includes('rate limit') || msg.includes('too many request')) {
    return new JobExecutionError(message, 'RATE_LIMITED');
  }
  if (status === 401 || status === 403 || msg.includes('unauthorized') || msg.includes('forbidden')) {
    return new JobExecutionError(message, 'PERMANENT');
  }
  if (
    status === 408 ||
    (typeof status === 'number' && status >= 500 && status <= 599) ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('network error') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up')
  ) {
    return new JobExecutionError(message, 'TRANSIENT');
  }
  if (
    msg.includes('malformed') ||
    msg.includes('invalid json') ||
    msg.includes('json parse') ||
    msg.includes('unexpected token') ||
    msg.includes('missing required') ||
    msg.includes('validation')
  ) {
    return new JobExecutionError(message, 'DATA_QUALITY');
  }

  return new JobExecutionError(message, 'UNKNOWN');
}

/** Single cycle: pick a ticker, fetch it, schedule next */
async function cycle(): Promise<void> {
  if (!running) return;
  const context: { ticker: string | null; reason: string | null } = { ticker: null, reason: null };
  let nextDelayMs = CYCLE_DELAY_MS;
  try {
    await runJob({
      name: 'fundamentals_prefetch',
      context,
      throwOnFailure: true,
      fn: async () => {
        const next = await pickNextTicker();

        if (!next) {
          if (stats.cycleCount % 100 === 0) {
            console.log(`${LOG_PREFIX} All ${getSectorUniverse().length} tickers fresh (${failureMap.size} skipped). Sleeping 10 min.`);
          }
          nextDelayMs = IDLE_DELAY_MS;
          return;
        }

        context.ticker = next.ticker;
        context.reason = next.reason;

        try {
          await prefetchTicker(next.ticker, next.reason);
        } catch (err) {
          throw classifyPrefetchError(err);
        }

        recordSuccess(next.ticker);
        stats.tickersFetched++;
        stats.lastTicker = next.ticker;
        stats.lastRun = new Date().toISOString();

        if (stats.tickersFetched % 25 === 0) {
          console.log(`${LOG_PREFIX} Progress: ${stats.tickersFetched} tickers fetched, last: ${next.ticker} (${next.reason}), skipped: ${failureMap.size}`);
        }
      },
    });
  } catch (err) {
    stats.errors++;
    if (context.ticker) recordFailure(context.ticker);
    console.error(`${LOG_PREFIX} Error on ${context.ticker || 'pick'}:`, err instanceof Error ? err.message : String(err));
  }

  stats.cycleCount++;
  if (running) timer = setTimeout(cycleWrapper, nextDelayMs);
}

/** Wrapper that tracks inflight promise for graceful shutdown (Codex finding #7) */
async function cycleWrapper(): Promise<void> {
  inflight = cycle();
  await inflight;
  inflight = null;
}

/** Start the background prefetch loop */
export function startFundamentalsPrefetch(): void {
  if (running) return;
  running = true;
  console.log(`${LOG_PREFIX} Starting background prefetch (${CYCLE_DELAY_MS / 1000}s between tickers, ${STARTUP_DELAY_MS / 1000}s startup delay)`);
  timer = setTimeout(cycleWrapper, STARTUP_DELAY_MS);
}

/** Stop the background prefetch loop — awaits in-flight cycle (Codex finding #7) */
export async function stopFundamentalsPrefetch(): Promise<void> {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (inflight) {
    try { await Promise.race([inflight, new Promise(r => setTimeout(r, 5000))]); } catch {}
  }
  console.log(`${LOG_PREFIX} Stopped. Stats: ${stats.tickersFetched} fetched, ${stats.errors} errors, ${failureMap.size} skipped`);
}

/** Get current prefetch stats */
export function getPrefetchStats() {
  return { ...stats, running, universeSize: getSectorUniverse().length, skippedTickers: failureMap.size };
}
