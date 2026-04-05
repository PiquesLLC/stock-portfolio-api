/**
 * Market-close snapshot: when the market is CLOSED (weekend/holiday/overnight),
 * the heatmap serves a pre-captured snapshot of closing prices instead of hitting
 * Polygon/Finnhub/Yahoo. This eliminates the weekend "many stocks show 0.00%"
 * problem caused by flaky batch quote fetches against a closed market.
 *
 * Capture runs at 8:05 PM ET on trading days, after the POST session ends.
 * Persisted to disk so it survives Railway deploys.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Quote } from '../types';
import { getMarketSession } from '../utils/market-hours';
import { isUSMarketHoliday, isUSTradingDay, getLastTradingDayET } from '../utils/market-holidays';
import { fetchPrices, fetchQuote } from './market.service';

const SNAPSHOT_PATH = process.env.NODE_ENV === 'production'
  ? '/data/market-close-snapshot.json'
  : path.join(process.cwd(), 'prisma', 'market-close-snapshot.json');

export interface MarketCloseSnapshot {
  capturedAt: string;        // ISO timestamp of capture
  sessionEndDate: string;    // YYYY-MM-DD in ET — the trading day whose close this represents
  quoteCount: number;
  quotes: Record<string, Quote>;
}

// In-memory cache of the loaded snapshot; reloaded on write or server boot.
let cachedSnapshot: MarketCloseSnapshot | null = null;

/**
 * Returns true if the market is currently closed AND we should serve snapshot data.
 *
 * Closed = weekend OR holiday OR overnight (8 PM - 4 AM ET).
 * During PRE/REG/POST sessions on a trading day, we always use live quotes.
 */
export function shouldServeSnapshot(date: Date = new Date()): boolean {
  // Full-day closure: weekend or holiday
  if (!isUSTradingDay(date)) return true;
  // Trading day, but outside 4 AM - 8 PM ET window
  return getMarketSession(date) === 'CLOSED';
}

/**
 * Returns the ET hour (0-23) for the given date.
 */
function etHour(date: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '0';
  return parseInt(hourPart, 10);
}

/**
 * Returns true if NOW (in ET) is 8:00-8:59 PM on a trading day — the capture window.
 */
export function isCaptureHour(date: Date = new Date()): boolean {
  if (!isUSTradingDay(date)) return false;
  return etHour(date) === 20;
}

/**
 * Load snapshot from disk into memory cache. Called once at boot and after each capture.
 */
export function loadSnapshot(): MarketCloseSnapshot | null {
  if (cachedSnapshot) return cachedSnapshot;
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return null;
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as MarketCloseSnapshot;
    if (!parsed.quotes || typeof parsed.quotes !== 'object') return null;
    cachedSnapshot = parsed;
    return parsed;
  } catch (err) {
    console.warn('[MarketCloseSnapshot] Failed to load:', (err as Error).message);
    return null;
  }
}

/**
 * Return snapshot quote for a ticker, or null if not in the snapshot.
 */
export function getSnapshotQuote(ticker: string): Quote | null {
  const snap = loadSnapshot();
  if (!snap) return null;
  return snap.quotes[ticker.toUpperCase()] || null;
}

/**
 * Build a quotes Map from the loaded snapshot for the requested tickers.
 * Tickers not in the snapshot are omitted (same convention as fetchPrices failedTickers).
 */
export function getQuotesFromSnapshot(tickers: string[]): { quotes: Map<string, Quote> } {
  const quotes = new Map<string, Quote>();
  const snap = loadSnapshot();
  if (!snap) return { quotes };
  for (const ticker of tickers) {
    const upper = ticker.toUpperCase();
    const q = snap.quotes[upper];
    if (q) quotes.set(upper, q);
  }
  return { quotes };
}

/**
 * Capture a fresh snapshot by fetching live quotes for the provided tickers,
 * then write to disk atomically. Invoked by the scheduled job at 8:05 PM ET.
 */
export async function captureMarketCloseSnapshot(tickers: string[]): Promise<{ captured: number; failed: number }> {
  if (tickers.length === 0) return { captured: 0, failed: 0 };

  const uniqueTickers = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
  console.log(`[MarketCloseSnapshot] Capturing close for ${uniqueTickers.length} tickers...`);

  const { quotes } = await fetchPrices(uniqueTickers);
  console.log(`[MarketCloseSnapshot] Batch fetch returned ${quotes.size}/${uniqueTickers.length}`);

  // For every ticker missing from the batch, hit Polygon/Finnhub/Yahoo per-ticker.
  // Polygon unlimited plan — don't throttle. Run in parallel sub-groups of 15 to
  // avoid burst-protection rate limits but still finish quickly (~5s for 120 tickers).
  const missing = uniqueTickers.filter((t) => !quotes.has(t));
  if (missing.length > 0) {
    console.log(`[MarketCloseSnapshot] Filling ${missing.length} gaps via single-ticker fallback`);
    const PARALLEL = 15;
    for (let i = 0; i < missing.length; i += PARALLEL) {
      const group = missing.slice(i, i + PARALLEL);
      await Promise.all(
        group.map(async (ticker) => {
          try {
            const q = await fetchQuote(ticker);
            if (q && q.currentPrice > 0) quotes.set(ticker.toUpperCase(), q);
          } catch {
            // Silently drop — merge with existing snapshot handles persistence.
          }
        })
      );
    }
    console.log(`[MarketCloseSnapshot] After fallback: ${quotes.size}/${uniqueTickers.length}`);
  }

  // Merge with existing snapshot if present: keep previously-captured quotes
  // for tickers missing from this capture. Never regress on coverage.
  const existing = loadSnapshot();
  if (existing) {
    for (const [ticker, q] of Object.entries(existing.quotes)) {
      if (!quotes.has(ticker)) {
        quotes.set(ticker, q);
      }
    }
  }

  // After gap-fill + merge, write whatever we have. No threshold — a partial
  // snapshot beats no snapshot, and subsequent retries keep adding coverage.
  if (quotes.size === 0) {
    console.warn('[MarketCloseSnapshot] Zero quotes captured; skipping write');
    return { captured: 0, failed: uniqueTickers.length };
  }

  const quoteMap: Record<string, Quote> = {};
  for (const [ticker, quote] of quotes.entries()) {
    quoteMap[ticker.toUpperCase()] = quote;
  }

  // sessionEndDate = the most recent actual trading day. On weekends/holidays
  // (bootstrap path), this is the prior Friday or day-before-holiday, NOT today.
  const snapshot: MarketCloseSnapshot = {
    capturedAt: new Date().toISOString(),
    sessionEndDate: getLastTradingDayET(),
    quoteCount: Object.keys(quoteMap).length,
    quotes: quoteMap,
  };

  try {
    const dir = path.dirname(SNAPSHOT_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = SNAPSHOT_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot), 'utf-8');
    fs.renameSync(tmpPath, SNAPSHOT_PATH);
    cachedSnapshot = snapshot;
    console.log(`[MarketCloseSnapshot] Wrote ${snapshot.quoteCount} quotes for ${snapshot.sessionEndDate}`);
  } catch (err) {
    console.error('[MarketCloseSnapshot] Failed to write:', (err as Error).message);
  }

  return { captured: snapshot.quoteCount, failed: uniqueTickers.length - snapshot.quoteCount };
}

/**
 * Scheduler entry point — runs hourly. Captures only if it's currently the
 * 20:00-20:59 ET window on a trading day. Deduplication is handled by the
 * runJob() idempotency key in index.ts.
 */
export async function runMarketCloseSnapshotCycle(tickers: string[]): Promise<void> {
  if (!isCaptureHour()) return;
  // Guard against capturing on a holiday we discovered via session check
  if (isUSMarketHoliday()) return;
  await captureMarketCloseSnapshot(tickers);
}
