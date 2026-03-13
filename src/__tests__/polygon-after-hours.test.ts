import { beforeEach, describe, expect, it, vi } from 'vitest';

const { axiosGetMock, getMarketSessionMock } = vi.hoisted(() => ({
  axiosGetMock: vi.fn(),
  getMarketSessionMock: vi.fn(),
}));

vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  return {
    ...actual,
    default: {
      ...actual.default,
      get: axiosGetMock,
    },
    get: axiosGetMock,
  };
});

vi.mock('../config', () => ({
  config: {
    polygonApiKey: 'test-polygon-key',
    quoteCacheTtlSeconds: 30,
  },
}));

vi.mock('../utils/market-hours', () => ({
  getMarketSession: getMarketSessionMock,
}));

import { clearAllPolygonCaches, getPolygonQuotes } from '../utils/polygon';

describe('getPolygonQuotes extended-hours split', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllPolygonCaches();
  });

  it('uses Polygon day close as regularClose during POST while keeping lastTrade as extendedPrice', async () => {
    getMarketSessionMock.mockReturnValue('POST');
    axiosGetMock.mockResolvedValue({
      data: {
        status: 'OK',
        tickers: [{
          ticker: 'AAPL',
          updated: 1_710_000_000_000_000,
          day: { o: 101, h: 109, l: 102, c: 105, v: 1000, vw: 105 },
          min: { av: 1000, t: 1_710_000_000_000, n: 1, o: 105, h: 108, l: 105, c: 108, v: 10, vw: 108 },
          prevDay: { o: 99, h: 100, l: 98, c: 100, v: 900, vw: 100 },
          lastTrade: { c: [1], i: '1', p: 108, s: 1, t: 1_710_000_060_000_000_000, x: 4 },
        }],
      },
    });

    const result = await getPolygonQuotes(['AAPL']);
    const quote = result.quotes.get('AAPL');

    expect(quote).toEqual(expect.objectContaining({
      ticker: 'AAPL',
      currentPrice: 108,
      previousClose: 100,
      regularClose: 105,
      extendedPrice: 108,
      extendedChange: 3,
      session: 'POST',
    }));
  });

  it('uses Polygon previous close as regularClose during PRE while keeping lastTrade as extendedPrice', async () => {
    getMarketSessionMock.mockReturnValue('PRE');
    axiosGetMock.mockResolvedValue({
      data: {
        status: 'OK',
        tickers: [{
          ticker: 'AAPL',
          updated: 1_710_000_000_000_000,
          day: { o: 100, h: 103, l: 99, c: 102, v: 1000, vw: 102 },
          prevDay: { o: 99, h: 100, l: 98, c: 100, v: 900, vw: 100 },
          lastTrade: { c: [1], i: '1', p: 104, s: 1, t: 1_710_000_060_000_000_000, x: 4 },
        }],
      },
    });

    const result = await getPolygonQuotes(['AAPL']);
    const quote = result.quotes.get('AAPL');

    expect(quote).toEqual(expect.objectContaining({
      ticker: 'AAPL',
      currentPrice: 104,
      previousClose: 100,
      regularClose: 100,
      extendedPrice: 104,
      extendedChange: 4,
      session: 'PRE',
    }));
  });
});
