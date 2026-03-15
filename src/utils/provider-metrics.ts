/**
 * Market data provider observability — tracks per-provider contribution,
 * failures, latency, and staleness over a 24-hour sliding window.
 *
 * Exposed at GET /health/provider-metrics
 */

type ProviderName = 'polygon' | 'yahoo' | 'finnhub';
type EventType = 'quotes_served' | 'quotes_failed' | 'candles_served' | 'candles_failed' | 'circuit_open';

interface ProviderEvent {
  provider: ProviderName;
  type: EventType;
  tickerCount: number;
  latencyMs: number;
  timestamp: number;
}

// Keep 24 hours of events
const WINDOW_MS = 24 * 60 * 60 * 1000;
const events: ProviderEvent[] = [];

function pruneOld(): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (events.length > 0 && events[0].timestamp < cutoff) {
    events.shift();
  }
}

export function recordProviderEvent(
  provider: ProviderName,
  type: EventType,
  tickerCount: number,
  latencyMs: number,
): void {
  events.push({ provider, type, tickerCount, latencyMs, timestamp: Date.now() });
  pruneOld();
}

export function getProviderMetrics() {
  pruneOld();

  const now = Date.now();
  const windows = {
    '5m': now - 5 * 60 * 1000,
    '1h': now - 60 * 60 * 1000,
    '24h': now - 24 * 60 * 60 * 1000,
  };

  type WindowStats = {
    quoteCycles: number;
    quotesServed: number;
    quotesFailed: number;
    candlesServed: number;
    candlesFailed: number;
    circuitOpens: number;
    avgLatencyMs: number;
    successRate: number;
  };

  const emptyStats = (): WindowStats => ({
    quoteCycles: 0,
    quotesServed: 0,
    quotesFailed: 0,
    candlesServed: 0,
    candlesFailed: 0,
    circuitOpens: 0,
    avgLatencyMs: 0,
    successRate: 0,
  });

  const providers: ProviderName[] = ['polygon', 'yahoo', 'finnhub'];
  const result: Record<string, Record<string, WindowStats>> = {};

  for (const provider of providers) {
    result[provider] = {};
    for (const [windowName, cutoff] of Object.entries(windows)) {
      const windowEvents = events.filter(e => e.provider === provider && e.timestamp >= cutoff);
      const stats = emptyStats();

      let totalLatency = 0;
      let latencyCount = 0;

      for (const e of windowEvents) {
        switch (e.type) {
          case 'quotes_served':
            stats.quoteCycles++;
            stats.quotesServed += e.tickerCount;
            break;
          case 'quotes_failed':
            stats.quotesFailed += e.tickerCount;
            break;
          case 'candles_served':
            stats.candlesServed += e.tickerCount;
            break;
          case 'candles_failed':
            stats.candlesFailed += e.tickerCount;
            break;
          case 'circuit_open':
            stats.circuitOpens++;
            break;
        }
        if (e.latencyMs > 0) {
          totalLatency += e.latencyMs;
          latencyCount++;
        }
      }

      stats.avgLatencyMs = latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0;
      const totalQuoteAttempts = stats.quotesServed + stats.quotesFailed;
      stats.successRate = totalQuoteAttempts > 0
        ? Math.round((stats.quotesServed / totalQuoteAttempts) * 10000) / 100
        : 100;

      result[provider][windowName] = stats;
    }
  }

  // Summary: which provider is doing the real work?
  const h1 = result;
  const summary = {
    primaryQuoteProvider:
      (h1.polygon['1h'].quotesServed > h1.yahoo['1h'].quotesServed)
        ? 'polygon'
        : (h1.yahoo['1h'].quotesServed > 0 ? 'yahoo' : 'polygon'),
    polygonContribution1h: h1.polygon['1h'].quotesServed,
    yahooContribution1h: h1.yahoo['1h'].quotesServed,
    finnhubContribution1h: h1.finnhub['1h'].quotesServed,
    recommendation:
      h1.polygon['1h'].quotesServed === 0 && h1.yahoo['1h'].quotesServed > 0
        ? 'Polygon provided 0 quotes in the last hour. Yahoo is doing all the work. Consider dropping Polygon.'
        : h1.yahoo['1h'].quotesServed === 0 && h1.polygon['1h'].quotesServed > 0
          ? 'Yahoo provided 0 quotes. Polygon is the sole source. Keep Polygon.'
          : 'Both providers active.',
  };

  return {
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    summary,
    providers: result,
  };
}
