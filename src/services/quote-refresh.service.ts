import { config } from '../config';
import prisma from '../utils/prisma';
import { getMarketSession, getMarketSessionForTicker } from '../utils/market-hours';
import { Quote } from '../types';
import { getPolygonQuotes, upsertPolygonQuoteCache } from '../utils/polygon';
import { fetchYahooV8BatchQuotes } from './market.service';
import { JobExecutionError, runJob } from './job-runner.service';

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
    let polygonError: Error | null = null;
    let yahooError: Error | null = null;

    if (isProviderAvailable('Polygon')) {
      try {
        const polygonResult = await getPolygonQuotes(tickers);
        polygonRefreshed = polygonResult.quotes.size;
        polygonQuotes = polygonResult.quotes;
        markProviderSuccess('Polygon');
      } catch (error) {
        markProviderFailure('Polygon');
        polygonError = error instanceof Error ? error : new Error(String(error));
        console.warn('[QuoteRefresh] Polygon refresh failed:', polygonError.message);
      }
    }

    if (isProviderAvailable('Yahoo')) {
      try {
        const yahooBatch = await fetchYahooV8BatchQuotes(tickers, {
          skipCache: session === 'REG',
        });

        for (const [ticker, yahooQuote] of yahooBatch.entries()) {
          if (!Number.isFinite(yahooQuote.price) || yahooQuote.price <= 0) continue;

          const base = polygonQuotes.get(ticker);
          const previousClose = yahooQuote.previousClose > 0
            ? yahooQuote.previousClose
            : base?.previousClose || yahooQuote.price;
          const currentPrice = yahooQuote.price;
          const change = currentPrice - previousClose;
          const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;
          const updatedAt = yahooQuote.regularMarketTime
            ? yahooQuote.regularMarketTime * 1000
            : Date.now();
          // regularClose = today's 4PM close. Yahoo v8 meta.regularMarketPrice is always the
          // regular session close, even during extended hours. Use it directly.
          const regularClose = yahooQuote.regularMarketPrice > 0
            ? yahooQuote.regularMarketPrice
            : base?.regularClose || previousClose;
          const extendedChange = currentPrice - regularClose;
          const extendedChangePercent = regularClose > 0 ? (extendedChange / regularClose) * 100 : 0;

          const mergedQuote: Quote = {
            ticker,
            currentPrice,
            change,
            changePercent,
            high: yahooQuote.dayHigh && yahooQuote.dayHigh > 0 ? yahooQuote.dayHigh : (base?.high || currentPrice),
            low: yahooQuote.dayLow && yahooQuote.dayLow > 0 ? yahooQuote.dayLow : (base?.low || currentPrice),
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

        if (yahooOverlayCount > 0) {
          markProviderSuccess('Yahoo');
        } else {
          markProviderFailure('Yahoo');
          yahooError = new Error('Yahoo v8 overlay returned no fresh quotes');
        }
      } catch (error) {
        markProviderFailure('Yahoo');
        yahooError = error instanceof Error ? error : new Error(String(error));
        console.warn('[QuoteRefresh] Yahoo v8 overlay failed:', yahooError.message);
      }
    }

    if (tickers.length > 0 && polygonRefreshed === 0 && yahooOverlayCount === 0 && (polygonError || yahooError)) {
      const msg = (polygonError?.message || '') + ' ' + (yahooError?.message || '');
      if (msg.toLowerCase().includes('rate limit') || msg.includes('429')) {
        throw new JobExecutionError('Quote refresh failed due to provider rate limits', 'RATE_LIMITED');
      }
      throw new JobExecutionError('Quote refresh failed for all available providers', 'TRANSIENT');
    }

    const elapsedSeconds = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(
      `[QuoteRefresh] Refreshed ${tickers.length} tickers in ${elapsedSeconds}s (Polygon: ${polygonRefreshed}, Yahoo v8 overlay: ${yahooOverlayCount})`,
    );
  } finally {
    cycleInProgress = false;
  }
}

export function startQuoteRefresh(): void {
  if (refreshTimer) return;

  const intervalMs = Math.max(5_000, config.quoteRefreshIntervalMs);
  console.log(`[QuoteRefresh] Starting background refresh every ${Math.round(intervalMs / 1000)}s`);

  runJob({ name: 'quote_refresh', fn: runRefreshCycle, maxAttempts: 1 });
  refreshTimer = setInterval(() => {
    runJob({ name: 'quote_refresh', fn: runRefreshCycle, maxAttempts: 1 });
  }, intervalMs);
}

export function stopQuoteRefresh(): void {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
  console.log('[QuoteRefresh] Stopped background refresh');
}
