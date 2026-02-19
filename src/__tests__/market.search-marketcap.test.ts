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
    finnhubQueueRequestMock.mockResolvedValue({ marketCapitalization: 123456 });

    const response = await searchSymbols('ABCD');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(response.partial).toBe(false);
    expect(response.results[0]?.symbol).toBe('ABCD');
    expect(
      axiosGetMock.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes('/search')
      )
    ).toBe(true);
    expect(finnhubQueueRequestMock).toHaveBeenCalledWith('/stock/profile2', { symbol: 'ABCD' });
  });

  it('cache hit reuses cached search results and avoids second Finnhub search call', async () => {
    mockFinnhubSearchResult('EFGH');
    finnhubQueueRequestMock.mockResolvedValue({ marketCapitalization: 5000 });

    await searchSymbols('EFGH');
    await new Promise(resolve => setTimeout(resolve, 0));
    const callsAfterFirst = axiosGetMock.mock.calls.length;
    await searchSymbols('EFGH');

    expect(axiosGetMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('enrichment failure does not block search response', async () => {
    mockFinnhubSearchResult('IJKL');
    finnhubQueueRequestMock.mockRejectedValue(new Error('profile2 failed'));

    const response = await searchSymbols('IJKL');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(response.partial).toBe(false);
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results[0]?.symbol).toBe('IJKL');
  });
});
