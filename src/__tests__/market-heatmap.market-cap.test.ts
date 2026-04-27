import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fundamentalsFindMany: vi.fn(),
  screenerFindMany: vi.fn(),
  fetchPrices: vi.fn(),
  fetchDailyCandles: vi.fn(),
  getMarketSession: vi.fn(),
  yahooGet: vi.fn(),
  queueAdvFetches: vi.fn(),
  getCachedAdv: vi.fn(),
  getPolygonSnapshotVolumes: vi.fn(),
}));

vi.mock('../utils/sectors', () => ({
  subSectorGroups: { Tech: { Semis: ['TSM'] } },
  INDEX_SETS: {},
}));

vi.mock('../utils/prisma', () => ({
  default: {
    fundamentalsCache: { findMany: mocks.fundamentalsFindMany },
    screenerCache: { findMany: mocks.screenerFindMany },
  },
}));

vi.mock('../services/market.service', () => ({
  fetchPrices: mocks.fetchPrices,
  fetchDailyCandles: mocks.fetchDailyCandles,
}));

vi.mock('../utils/market-hours', () => ({
  getMarketSession: mocks.getMarketSession,
}));

vi.mock('../utils/yahoo-http', () => ({
  yahooGet: mocks.yahooGet,
}));

vi.mock('../utils/finnhub', () => ({
  queueAdvFetches: mocks.queueAdvFetches,
  getCachedAdv: mocks.getCachedAdv,
}));

vi.mock('../utils/polygon', () => ({
  getPolygonSnapshotVolumes: mocks.getPolygonSnapshotVolumes,
}));

describe('getHeatmapData — market cap backfill for null Polygon caps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.fetchPrices.mockResolvedValue({
      quotes: new Map([['TSM', { currentPrice: 403.93, changePercent: 0.37, change: 1.5 }]]),
    });
    mocks.fetchDailyCandles.mockResolvedValue([]);
    mocks.getMarketSession.mockReturnValue('REG');
    mocks.queueAdvFetches.mockResolvedValue(undefined);
    mocks.getCachedAdv.mockReturnValue(0);
    mocks.getPolygonSnapshotVolumes.mockResolvedValue(new Map());
    mocks.screenerFindMany.mockResolvedValue([]);
  });

  it('returns the real Yahoo market cap when Polygon-cached overview has marketCap:null (ADR scenario)', async () => {
    // Polygon's tickerDetails.market_cap is null for many ADRs (TSM, ASML, ARM, BABA…),
    // so the cached FundamentalsCache row exists but its overviewJson has marketCap:null.
    mocks.fundamentalsFindMany.mockResolvedValue([
      { ticker: 'TSM', overviewJson: JSON.stringify({ companyName: 'Taiwan Semi', marketCap: null }) },
    ]);
    // Yahoo has the real number (~$1.05T)
    mocks.yahooGet.mockResolvedValue({
      data: {
        quoteSummary: {
          result: [{ price: { shortName: 'Taiwan Semi', marketCap: { raw: 1.05e12 } } }],
        },
      },
    });

    const { getHeatmapData } = await import('../services/market-heatmap.service');
    const resp = await getHeatmapData('1D');

    const tsm = resp.sectors[0]?.stocks[0];
    expect(tsm?.ticker).toBe('TSM');
    // BEFORE FIX: stub `?? 1` leaks through → marketCapB === 1 (= "$1B" in UI).
    expect(tsm?.marketCapB).not.toBe(1);
    // Yahoo cap (1.05e12) → marketCapB ≈ 1050 billions.
    expect(tsm?.marketCapB).toBeGreaterThan(500);
  });

  it('emits 0 (not the $1B stub) when both Polygon and Yahoo lack market cap', async () => {
    mocks.fundamentalsFindMany.mockResolvedValue([
      { ticker: 'TSM', overviewJson: JSON.stringify({ companyName: 'Taiwan Semi', marketCap: null }) },
    ]);
    // Yahoo also returns nothing
    mocks.yahooGet.mockResolvedValue({ data: { quoteSummary: { result: [] } } });

    const { getHeatmapData } = await import('../services/market-heatmap.service');
    const resp = await getHeatmapData('1D');

    const tsm = resp.sectors[0]?.stocks[0];
    expect(tsm?.marketCapB).not.toBe(1);
    expect(tsm?.marketCapB).toBe(0);
  });
});
