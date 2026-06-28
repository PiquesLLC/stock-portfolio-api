import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getQuoteMock,
  getQuotesMock,
  searchSymbolsMock,
  getStockProfileMock,
  getStockMetricsMock,
  getPolygonQuotesMock,
  getPolygonQuoteMock,
  yahooGetMock,
  fetchPolygonAggsMock,
  getMarketSessionMock,
  getMarketSessionForTickerMock,
} = vi.hoisted(() => ({
  getQuoteMock: vi.fn(),
  getQuotesMock: vi.fn(),
  searchSymbolsMock: vi.fn(),
  getStockProfileMock: vi.fn(),
  getStockMetricsMock: vi.fn(),
  getPolygonQuotesMock: vi.fn(),
  getPolygonQuoteMock: vi.fn(),
  yahooGetMock: vi.fn(),
  fetchPolygonAggsMock: vi.fn(),
  getMarketSessionMock: vi.fn(),
  getMarketSessionForTickerMock: vi.fn(),
}));

vi.mock('../utils/finnhub', () => ({
  getQuote: getQuoteMock,
  getQuotes: getQuotesMock,
  searchSymbols: searchSymbolsMock,
  getStockProfile: getStockProfileMock,
  getStockMetrics: getStockMetricsMock,
}));

vi.mock('../utils/polygon', () => ({
  getPolygonQuotes: getPolygonQuotesMock,
  getPolygonQuote: getPolygonQuoteMock,
}));

vi.mock('../utils/yahoo-http', () => ({
  yahooGet: yahooGetMock,
  fetchPolygonAggs: fetchPolygonAggsMock,
}));

vi.mock('../utils/market-hours', () => ({
  getMarketSession: getMarketSessionMock,
  getMarketSessionForTicker: getMarketSessionForTickerMock,
}));

import { fetchStockDetails, fetchPrices, STOCK_DETAILS_OPTIONAL_TIMEOUT_MS, TickerNotFoundError } from '../services/market.service';

describe('market.service fetchPrices — Yahoo confirmation clears false staleness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    getMarketSessionMock.mockReturnValue('POST');
    getMarketSessionForTickerMock.mockReturnValue('POST');
    getQuotesMock.mockResolvedValue({ quotes: new Map(), staleCount: 0, repricingCount: 0, failedTickers: [], provider: 'finnhub' });
  });

  // An aged Polygon cache entry during POST: real price, but flagged stale/repricing
  // because getPolygonQuotes saw it was >30min old.
  const agedPolygonQuote = (ticker: string) => ({
    quotes: new Map([[ticker, {
      ticker, currentPrice: 255, previousClose: 250, change: 5, changePercent: 2,
      high: 256, low: 254, open: 250, timestamp: 1, updatedAt: 1,
      isStale: true, isRepricing: true, quoteAgeSeconds: 4200, session: 'POST',
    }]]),
    staleCount: 1, repricingCount: 1, failedTickers: [] as string[], provider: 'polygon',
  });

  it('clears isStale/isRepricing and zeroes the counts when a fresh Yahoo quote CONFIRMS an aged Polygon price within tolerance (POST)', async () => {
    getPolygonQuotesMock.mockResolvedValue(agedPolygonQuote('AAPL'));
    // Yahoo POST price 255.5 vs Polygon 255 = ~0.2% divergence -> confirm, do NOT overwrite.
    yahooGetMock.mockResolvedValue({ data: { quoteResponse: { result: [{
      symbol: 'AAPL', marketState: 'POST', regularMarketPreviousClose: 250,
      regularMarketPrice: 250, postMarketPrice: 255.5,
    }] } } });

    const result = await fetchPrices(['AAPL']);
    const quote = result.quotes.get('AAPL')!;

    expect(quote.isStale).toBe(false);
    expect(quote.isRepricing).toBe(false);
    expect(quote.currentPrice).toBe(255); // within tolerance -> price NOT overwritten
    expect(result.staleCount).toBe(0);
    expect(result.repricingCount).toBe(0);
  });

  it('leaves the quote stale/repricing when Yahoo has no fresh price to confirm it (never masks a real outage)', async () => {
    // Guard, not a revert-catch: with no Yahoo data the overlay never touches the quote, so
    // Polygon's flags/counts pass through unchanged with or without the fix. It pins the
    // safety invariant — staleness only ever clears on a real confirmation, never otherwise.
    getPolygonQuotesMock.mockResolvedValue(agedPolygonQuote('NVDA'));
    yahooGetMock.mockResolvedValue({ data: { quoteResponse: { result: [] } } }); // Yahoo returns nothing usable

    const result = await fetchPrices(['NVDA']);
    const quote = result.quotes.get('NVDA')!;

    expect(quote.isStale).toBe(true);
    expect(quote.isRepricing).toBe(true);
    expect(result.staleCount).toBe(1);
    expect(result.repricingCount).toBe(1);
  });
});

describe('market.service fetchStockDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    getMarketSessionMock.mockReturnValue('REG');
    getMarketSessionForTickerMock.mockReturnValue('REG');
    getPolygonQuoteMock.mockRejectedValue(new Error('polygon down'));
    getQuoteMock.mockRejectedValue(new Error('finnhub down'));
    yahooGetMock.mockResolvedValue({
      data: {
        chart: {
          result: [{
            meta: {
              regularMarketPrice: 100,
              regularMarketDayHigh: 103,
              regularMarketDayLow: 98,
              regularMarketOpen: 99,
              chartPreviousClose: 97,
            },
            timestamp: [1, 2],
            indicators: {
              quote: [{
                close: [99, 100],
              }],
            },
          }],
        },
      },
    });

    getStockProfileMock.mockImplementation(() => new Promise(() => undefined));
    getStockMetricsMock.mockImplementation(() => new Promise(() => undefined));
    fetchPolygonAggsMock.mockImplementation(() => new Promise(() => undefined));
  });

  it('returns quote data promptly even when profile, metrics, and candles stall', async () => {
    const pending = fetchStockDetails('NOW');

    await vi.advanceTimersByTimeAsync(STOCK_DETAILS_OPTIONAL_TIMEOUT_MS + 5);

    await expect(pending).resolves.toEqual(expect.objectContaining({
      ticker: 'NOW',
      quote: expect.objectContaining({
        ticker: 'NOW',
        currentPrice: 100,
        previousClose: 97,
      }),
      profile: null,
      metrics: null,
      candles: null,
    }));
  });

  describe('no-quote disambiguation (unknown symbol → 404 vs transient outage → retryable 5xx)', () => {
    // Resolve the no-quote branch: every provider fails AND Yahoo returns no
    // usable meta → quote is null. Then advance past the optional soft-timeouts
    // (profile/metrics/candles stay pending) so fetchStockDetails reaches the
    // disambiguation, and read the rejection.
    const resolveNoQuote = async (ticker: string) => {
      yahooGetMock.mockResolvedValue({ data: { chart: { result: [{ meta: {} }] } } });
      const p = fetchStockDetails(ticker).catch((e) => e);
      await vi.advanceTimersByTimeAsync(STOCK_DETAILS_OPTIONAL_TIMEOUT_MS + 5);
      return p;
    };

    it('throws TickerNotFoundError when a COMPLETE search finds no exact match', async () => {
      // partial:false = the search ran cleanly; empty results = symbol unknown.
      searchSymbolsMock.mockResolvedValue({ results: [], partial: false, cached: false, advPending: [] });
      expect(await resolveNoQuote('FAKEXYZ')).toBeInstanceOf(TickerNotFoundError);
    });

    it('does NOT 404 (throws a retryable error) when the search itself is PARTIAL', async () => {
      // partial:true = search providers failed; results are unreliable, so an
      // empty list must not be read as "no such symbol" (the cold-cache
      // real-ticker-during-outage regression).
      searchSymbolsMock.mockResolvedValue({ results: [], partial: true, cached: false, advPending: [] });
      const err = await resolveNoQuote('AAPL');
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TickerNotFoundError);
    });

    it('does NOT 404 when a complete search DOES return the exact symbol (real ticker, transient quote outage)', async () => {
      searchSymbolsMock.mockResolvedValue({
        results: [{ symbol: 'AAPL', description: 'Apple Inc', type: 'stock', primaryExchange: 'XNAS', popularityScore: 1 }],
        partial: false, cached: false, advPending: [],
      });
      const err = await resolveNoQuote('AAPL');
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TickerNotFoundError);
    });

    it('matches the exact symbol case-insensitively', async () => {
      searchSymbolsMock.mockResolvedValue({
        results: [{ symbol: 'aapl', description: 'Apple Inc', type: 'stock', primaryExchange: 'XNAS', popularityScore: 1 }],
        partial: false, cached: false, advPending: [],
      });
      expect(await resolveNoQuote('AAPL')).not.toBeInstanceOf(TickerNotFoundError);
    });
  });
});
