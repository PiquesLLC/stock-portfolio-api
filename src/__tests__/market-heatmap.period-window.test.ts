import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression for the heatmap period-window bug: fetchDailyCandles(ticker, days)
// over-fetches `days + 10` calendar days as a trading-day buffer, and the heatmap
// used candles[0] (the oldest, ~10 days too far back) as the period start — so a
// "1W" tile was really a ~2.5-week move (e.g. AMZN showed -9% vs the chart's +0.44%).

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
  subSectorGroups: { Tech: { 'E-Commerce': ['AMZN'] } },
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
vi.mock('../utils/market-hours', () => ({ getMarketSession: mocks.getMarketSession }));
vi.mock('../utils/yahoo-http', () => ({ yahooGet: mocks.yahooGet }));
vi.mock('../utils/finnhub', () => ({ queueAdvFetches: mocks.queueAdvFetches, getCachedAdv: mocks.getCachedAdv }));
vi.mock('../utils/polygon', () => ({ getPolygonSnapshotVolumes: mocks.getPolygonSnapshotVolumes }));

const DAY_MS = 86_400_000;
const isoDaysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

describe('getHeatmapData — period change uses the requested window, not the candle buffer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.fetchPrices.mockResolvedValue({
      quotes: new Map([['AMZN', { currentPrice: 246, changePercent: 0.4, change: 1 }]]),
    });
    mocks.getMarketSession.mockReturnValue('REG');
    mocks.queueAdvFetches.mockResolvedValue(undefined);
    mocks.getCachedAdv.mockReturnValue(0);
    mocks.getPolygonSnapshotVolumes.mockResolvedValue(new Map());
    mocks.screenerFindMany.mockResolvedValue([]);
    mocks.fundamentalsFindMany.mockResolvedValue([
      { ticker: 'AMZN', overviewJson: JSON.stringify({ companyName: 'Amazon', marketCap: 2.5e12 }) },
    ]);
    // fetchDailyCandles over-fetches a buffer, so it returns candles older than the window:
    //   ~16 days ago: $271  <- the OLD bug anchored here (candles[0]) => ~ -9%
    //   ~6 days ago:  $245  <- the TRUE 1-week start
    //   today:        $246  <- end
    mocks.fetchDailyCandles.mockResolvedValue([
      { time: isoDaysAgo(16), open: 271, high: 272, low: 270, close: 271, volume: 1 },
      { time: isoDaysAgo(6), open: 245, high: 246, low: 244, close: 245, volume: 1 },
      { time: isoDaysAgo(0.2), open: 246, high: 247, low: 245, close: 246, volume: 1 },
    ]);
  });

  it('1W anchors the start at ~7 days ago (+0.4%), not the ~17-day buffer start (-9%)', async () => {
    const { getHeatmapData } = await import('../services/market-heatmap.service');
    const resp = await getHeatmapData('1W');
    const amzn = resp.sectors[0]?.stocks[0];
    expect(amzn?.ticker).toBe('AMZN');
    // True 1W: (246 - 245)/245 ≈ +0.41%. The pre-fix bug used $271 (16d ago) => ≈ -9.2%.
    expect(amzn?.changePercent).toBeCloseTo(0.41, 1);
    expect(amzn?.changePercent).toBeGreaterThan(0);
  });

  it('1M correctly includes the ~16-day-ago candle (start in-window) => the wider ~-9% move', async () => {
    // Same candles, but a 30-day window legitimately includes the $271 candle, so the
    // negative move IS the correct 1M figure — proving the fix scopes BY window length,
    // not that it merely drops candles[0].
    const { getHeatmapData } = await import('../services/market-heatmap.service');
    const resp = await getHeatmapData('1M');
    const amzn = resp.sectors[0]?.stocks[0];
    expect(amzn?.changePercent).toBeCloseTo(-9.23, 1);
  });
});
