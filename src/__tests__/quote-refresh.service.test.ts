import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  findManyMock,
  getMarketSessionMock,
  getMarketSessionForTickerMock,
  getPolygonQuotesMock,
  upsertPolygonQuoteCacheMock,
  runJobMock,
  yahooGetMock,
} = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  getMarketSessionMock: vi.fn(),
  getMarketSessionForTickerMock: vi.fn(),
  getPolygonQuotesMock: vi.fn(),
  upsertPolygonQuoteCacheMock: vi.fn(),
  runJobMock: vi.fn(),
  yahooGetMock: vi.fn(),
}));

vi.mock('../utils/prisma', () => ({
  default: {
    holding: {
      findMany: findManyMock,
    },
  },
}));

vi.mock('../utils/market-hours', () => ({
  getMarketSession: getMarketSessionMock,
  getMarketSessionForTicker: getMarketSessionForTickerMock,
}));

vi.mock('../utils/polygon', () => ({
  getPolygonQuotes: getPolygonQuotesMock,
  upsertPolygonQuoteCache: upsertPolygonQuoteCacheMock,
}));

vi.mock('../services/job-runner.service', async () => {
  const actual = await vi.importActual<typeof import('../services/job-runner.service')>('../services/job-runner.service');
  return {
    ...actual,
    runJob: runJobMock,
  };
});

vi.mock('../utils/yahoo-http', () => ({
  yahooGet: yahooGetMock,
  fetchPolygonAggs: vi.fn(),
}));

import { startQuoteRefresh, stopQuoteRefresh } from '../services/quote-refresh.service';

describe('quote-refresh.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    runJobMock.mockImplementation(async ({ fn }: { fn: () => Promise<unknown> }) => fn());
    getMarketSessionMock.mockReturnValue('POST');
    getMarketSessionForTickerMock.mockReturnValue('POST');
    findManyMock.mockResolvedValue([{ ticker: 'AAPL' }]);
    getPolygonQuotesMock.mockResolvedValue({
      quotes: new Map([
        ['AAPL', {
          ticker: 'AAPL',
          currentPrice: 110,
          change: 10,
          changePercent: 10,
          high: 111,
          low: 99,
          open: 101,
          previousClose: 100,
          timestamp: 1_710_000_000,
          updatedAt: 1_710_000_000_000,
          isStale: false,
          isRepricing: false,
          quoteAgeSeconds: 0,
          session: 'POST',
        }],
      ]),
      staleCount: 0,
      repricingCount: 0,
      failedTickers: [],
      provider: 'polygon',
    });
    yahooGetMock.mockResolvedValue({
      data: {
        chart: {
          result: [{
            meta: {
              regularMarketPrice: 105,
              chartPreviousClose: 100,
              regularMarketDayHigh: 109,
              regularMarketDayLow: 102,
              regularMarketTime: 1_710_000_060,
              currentTradingPeriod: {
                pre: { start: 1_709_990_000, end: 1_709_995_000 },
                regular: { start: 1_709_995_000, end: 1_710_000_000 },
                post: { start: 1_710_000_000, end: 1_710_005_000 },
              },
            },
            indicators: {
              quote: [{
                close: [104, 108],
              }],
            },
          }],
        },
      },
    });
  });

  afterEach(() => {
    stopQuoteRefresh();
  });

  it('writes Yahoo v8 after-hours overlay into the quote cache with the correct regular close split', async () => {
    startQuoteRefresh();
    await runJobMock.mock.results[0]?.value;

    expect(upsertPolygonQuoteCacheMock).toHaveBeenCalledTimes(1);
    expect(upsertPolygonQuoteCacheMock).toHaveBeenCalledWith('AAPL', expect.objectContaining({
      ticker: 'AAPL',
      currentPrice: 108,
      previousClose: 100,
      regularClose: 105,
      extendedPrice: 108,
      extendedChange: 3,
      extendedChangePercent: 3 / 105 * 100,
      session: 'POST',
      high: 109,
      low: 102,
      timestamp: 1_710_000_060,
      updatedAt: 1_710_000_060_000,
    }));
  });
});
