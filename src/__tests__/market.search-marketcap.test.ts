import { beforeEach, describe, expect, it, vi } from 'vitest';

const { axiosGetMock, finnhubQueueRequestMock } = vi.hoisted(() => ({
  axiosGetMock: vi.fn(),
  finnhubQueueRequestMock: vi.fn(),
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
    finnhubApiKey: 'test-finnhub-key',
    quoteCacheTtlSeconds: 30,
    priceCacheTtl: 5,
    repriceThresholdSeconds: 30,
  },
}));

vi.mock('../utils/finnhub-queue', () => ({
  finnhubQueue: {
    request: finnhubQueueRequestMock,
  },
}));

import {
  clearAdvCache,
  clearMarketCapCache,
  clearSearchCache,
  searchSymbols,
} from '../utils/finnhub';

function mockFinnhubSearchResult(symbol: string, description = 'Test Company'): void {
  axiosGetMock.mockResolvedValueOnce({
    data: {
      count: 1,
      result: [
        {
          symbol,
          description,
          type: 'Common Stock',
          primary_exchange: 'NYSE',
        },
      ],
    },
  });
}

describe('searchSymbols market-cap enrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSearchCache();
    clearAdvCache();
    clearMarketCapCache();
  });

  it('cache miss fetches search results and triggers market cap enrichment fetch', async () => {
    mockFinnhubSearchResult('ABCD');
    finnhubQueueRequestMock.mockImplementation(async (path: string) => {
      if (path === '/stock/profile2') return { marketCapitalization: 123456 };
      // ADV enrichment path (/stock/candle) can run in parallel; return minimal valid shape.
      return { s: 'ok', v: [1000, 2000, 3000] };
    });

    const response = await searchSymbols('ABCD');

    expect(response.partial).toBe(false);
    expect(response.results[0]?.symbol).toBe('ABCD');
    expect(
      axiosGetMock.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes('/search')
      )
    ).toBe(true);
    await vi.waitFor(() => {
      expect(finnhubQueueRequestMock).toHaveBeenCalledWith('/stock/profile2', { symbol: 'ABCD' });
    });
  });

  it('cache hit reuses cached search results and avoids second Finnhub search call', async () => {
    mockFinnhubSearchResult('EFGH');
    finnhubQueueRequestMock.mockImplementation(async (path: string) => {
      if (path === '/stock/profile2') return { marketCapitalization: 5000 };
      return { s: 'ok', v: [1000, 2000, 3000] };
    });

    await searchSymbols('EFGH');
    await vi.waitFor(() => {
      expect(finnhubQueueRequestMock).toHaveBeenCalled();
    });
    const callsAfterFirst = axiosGetMock.mock.calls.length;
    await searchSymbols('EFGH');

    expect(axiosGetMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('enrichment failure does not block search response', async () => {
    mockFinnhubSearchResult('IJKL');
    finnhubQueueRequestMock.mockImplementation(async (path: string) => {
      if (path === '/stock/profile2') throw new Error('profile2 failed');
      return { s: 'ok', v: [1000, 2000, 3000] };
    });

    const response = await searchSymbols('IJKL');

    expect(response.partial).toBe(false);
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results[0]?.symbol).toBe('IJKL');
  });
});
