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

import { fetchStockDetails, STOCK_DETAILS_OPTIONAL_TIMEOUT_MS } from '../services/market.service';

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
});
