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

import { fetchStockDetails, STOCK_DETAILS_OPTIONAL_TIMEOUT_MS, TickerNotFoundError } from '../services/market.service';

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
