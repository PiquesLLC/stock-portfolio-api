import { config } from '../config';
import prisma from '../utils/prisma';
import { getMarketSession, getMarketSessionForTicker } from '../utils/market-hours';
import { Quote } from '../types';
import { getPolygonQuotes, upsertPolygonQuoteCache } from '../utils/polygon';
import { fetchYahooBatchQuotes } from './market.service';

type ProviderName = 'Polygon' | 'Yahoo';

interface ProviderCircuitState {
  consecutiveFailures: number;
  openUntilMs: number;
}

const FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 60_000;

let refreshTimer: NodeJS.Timeout | null = null;
let cycleInProgress = false;

const providerCircuits: Record<ProviderName, ProviderCircuitState> = {
  Polygon: { consecutiveFailures: 0, openUntilMs: 0 },
  Yahoo: { consecutiveFailures: 0, openUntilMs: 0 },
};

function getMaxRefreshTickers(): number {
  return Math.max(1, config.maxRefreshTickers);
}

function isProviderAvailable(provider: ProviderName): boolean {
  const state = providerCircuits[provider];
  const now = Date.now();

  if (state.openUntilMs > 0 && now >= state.openUntilMs) {
    state.openUntilMs = 0;
    state.consecutiveFailures = 0;
    console.log(`[QuoteRefresh] ${provider} circuit CLOSED - retrying provider`);
  }

  return state.openUntilMs === 0;
}

function markProviderSuccess(provider: ProviderName): void {
  providerCircuits[provider].consecutiveFailures = 0;
}

function markProviderFailure(provider: ProviderName): void {
  const state = providerCircuits[provider];
  state.consecutiveFailures += 1;

  if (state.consecutiveFailures >= FAILURE_THRESHOLD && state.openUntilMs === 0) {
    state.openUntilMs = Date.now() + CIRCUIT_OPEN_MS;
    console.warn(
      `[QuoteRefresh] ${provider} circuit OPEN - ${FAILURE_THRESHOLD} consecutive failures, skipping for 60s`,
    );
  }
}

async function getActiveTickers(): Promise<string[]> {
  const holdings = await prisma.holding.findMany({
    select: { ticker: true },
    distinct: ['ticker'],
    where: { shares: { gt: 0 } },
  });

  const tickers = Array.from(new Set(holdings.map(h => h.ticker.toUpperCase())));
  return tickers.slice(0, getMaxRefreshTickers());
}

async function runRefreshCycle(): Promise<void> {
  if (cycleInProgress) return;
  cycleInProgress = true;

  const startMs = Date.now();

  try {
    const nowMs = Date.now();
    const session = getMarketSession(new Date(nowMs));

    // Skip refresh when market is closed — no new price data to fetch
    if (session === 'CLOSED') {
      return;
    }

    const tickers = await getActiveTickers();
    if (tickers.length === 0) {
      return;
    }

    let polygonRefreshed = 0;
    let yahooOverlayCount = 0;
    let polygonQuotes = new Map<string, Quote>();

    if (isProviderAvailable('Polygon')) {
      try {
        const polygonResult = await getPolygonQuotes(tickers);
        polygonRefreshed = polygonResult.quotes.size;
        polygonQuotes = polygonResult.quotes;
        markProviderSuccess('Polygon');
      } catch (error) {
        markProviderFailure('Polygon');
        console.warn('[QuoteRefresh] Polygon refresh failed:', (error as Error).message);
      }
    }

    // Yahoo overlay: during REGULAR hours Yahoo is near-real-time while Polygon
    // Developer plan is ~15-min delayed. During PRE/POST Yahoo provides extended
    // hours pricing that Polygon often misses. Only skip during CLOSED.
    if ((session === 'PRE' || session === 'POST') && isProviderAvailable('Yahoo')) {
      try {
        const yahooQuotes = await fetchYahooBatchQuotes(tickers);
        for (const [ticker, yahooQuote] of yahooQuotes.entries()) {
          if (!Number.isFinite(yahooQuote.price) || yahooQuote.price <= 0) continue;

          const base = polygonQuotes.get(ticker);
          const previousClose = yahooQuote.previousClose > 0
            ? yahooQuote.previousClose
            : base?.previousClose || yahooQuote.price;
          const currentPrice = yahooQuote.price;
          const change = currentPrice - previousClose;
          const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;
          const updatedAt = Date.now();

          // During POST: regularClose = today's 4PM close (regularMarketPrice).
          // During PRE: regularClose = yesterday's close (previousClose — no "today" close yet).
          const regularClose = session === 'POST'
            ? (yahooQuote.regularMarketPrice || base?.currentPrice || previousClose)
            : previousClose;
          const extendedChange = currentPrice - regularClose;
          const extendedChangePercent = regularClose > 0 ? (extendedChange / regularClose) * 100 : 0;

          const mergedQuote: Quote = {
            ticker,
            currentPrice,
            change,
            changePercent,
            high: base?.high || currentPrice,
            low: base?.low || currentPrice,
            open: base?.open || previousClose,
            previousClose,
            timestamp: Math.floor(updatedAt / 1000),
            updatedAt,
            isStale: false,
            isRepricing: false,
            quoteAgeSeconds: 0,
            session: getMarketSessionForTicker(ticker, new Date(updatedAt)),
            regularClose,
            extendedPrice: currentPrice,
            extendedChange,
            extendedChangePercent,
          };

          upsertPolygonQuoteCache(ticker, mergedQuote);
          yahooOverlayCount += 1;
        }

        markProviderSuccess('Yahoo');
      } catch (error) {
        markProviderFailure('Yahoo');
        console.warn('[QuoteRefresh] Yahoo overlay failed:', (error as Error).message);
      }
    }

    const elapsedSeconds = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(
      `[QuoteRefresh] Refreshed ${tickers.length} tickers in ${elapsedSeconds}s (Polygon: ${polygonRefreshed}, Yahoo overlay: ${yahooOverlayCount})`,
    );
  } catch (error) {
    console.error('[QuoteRefresh] Refresh cycle failed:', (error as Error).message);
  } finally {
    cycleInProgress = false;
  }
}

export function startQuoteRefresh(): void {
  if (refreshTimer) return;

  const intervalMs = Math.max(5_000, config.quoteRefreshIntervalMs);
  console.log(`[QuoteRefresh] Starting background refresh every ${Math.round(intervalMs / 1000)}s`);

  void runRefreshCycle();
  refreshTimer = setInterval(() => {
    void runRefreshCycle();
  }, intervalMs);
}

export function stopQuoteRefresh(): void {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
  console.log('[QuoteRefresh] Stopped background refresh');
}
