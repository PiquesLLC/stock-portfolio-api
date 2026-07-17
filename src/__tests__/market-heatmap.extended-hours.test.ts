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
  subSectorGroups: { Tech: { 'Mega-Cap Tech': ['GOOGL'] } },
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

describe('getHeatmapData — extended-hours overlay (1D)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.fetchDailyCandles.mockResolvedValue([]);
    mocks.queueAdvFetches.mockResolvedValue(undefined);
    mocks.getCachedAdv.mockReturnValue(0);
    mocks.getPolygonSnapshotVolumes.mockResolvedValue(new Map());
    mocks.screenerFindMany.mockResolvedValue([]);
    mocks.fundamentalsFindMany.mockResolvedValue([
      { ticker: 'GOOGL', overviewJson: JSON.stringify({ companyName: 'Alphabet', marketCap: 2.0e12 }) },
    ]);
    mocks.yahooGet.mockResolvedValue({ data: { quoteSummary: { result: [] } } });
  });

  it('uses extendedPrice and full extended-hours change when quote has extended fields (POST session)', async () => {
    // Real-world scenario from user report: GOOGL closed -0.16% in regular session,
    // then rose ~7% in after-hours on earnings. Heatmap on the 1D tab should show the
    // total move from previousClose (green ~+6.84%), not the stale regular-session red.
    mocks.getMarketSession.mockReturnValue('POST');
    mocks.fetchPrices.mockResolvedValue({
      quotes: new Map([
        ['GOOGL', {
          currentPrice: 99.84,
          previousClose: 100,
          change: -0.16,
          changePercent: -0.16,
          extendedPrice: 106.84,
          extendedChange: 7.0,
          extendedChangePercent: 7.01,
        }],
      ]),
    });

    const { getHeatmapData } = await import('../services/market-heatmap.service');
    const resp = await getHeatmapData('1D');

    const googl = resp.sectors[0]?.stocks[0];
    expect(googl?.ticker).toBe('GOOGL');
    // BEFORE FIX: returns regular-session changePercent (-0.16) → tile renders red.
    // AFTER FIX: returns total change from previousClose (~6.84) → tile renders green.
    expect(googl?.changePercent).toBeGreaterThan(5);
    expect(googl?.changePercent).toBeCloseTo(6.84, 1);
    // Price should reflect extended-hours value so the hover tooltip is consistent.
    expect(googl?.price).toBe(106.84);
  });

  it('splits regular vs after-hours from regularClose when currentPrice carries the extended print (real provider shape)', async () => {
    // Every live provider (Polygon batch, quote-refresh merge, fetchPrices Yahoo overlay)
    // writes the extended print into BOTH currentPrice and extendedPrice, with the true
    // 4 PM close in regularClose. The After-hours→Regular toggle collapsed to a no-op when
    // regularChangePercent was derived from currentPrice. The overlay shape also lacks
    // extendedChangePercent — regularClose alone must qualify the row as extended.
    mocks.getMarketSession.mockReturnValue('POST');
    mocks.fetchPrices.mockResolvedValue({
      quotes: new Map([
        ['GOOGL', {
          currentPrice: 106.84,      // extended print (as the batch overlay writes it)
          previousClose: 100,
          change: 6.84,
          changePercent: 6.84,       // blended — already carries the AH move
          extendedPrice: 106.84,
          regularClose: 99.84,       // today's 4 PM close
          // no extendedChangePercent — fetchPrices overlay doesn't set it
        }],
      ]),
    });

    const { getHeatmapData } = await import('../services/market-heatmap.service');
    const resp = await getHeatmapData('1D');

    const googl = resp.sectors[0]?.stocks[0];
    expect(googl?.changePercent).toBeCloseTo(6.84, 1);          // After-hours view
    expect(googl?.regularChangePercent).toBeCloseTo(-0.16, 2);  // Regular view — NOT 6.84
    expect(googl?.price).toBe(106.84);
    expect(googl?.regularPrice).toBe(99.84);
  });

  it('falls back to regular-session changePercent when no extended-hours fields are present', async () => {
    mocks.getMarketSession.mockReturnValue('REG');
    mocks.fetchPrices.mockResolvedValue({
      quotes: new Map([
        ['GOOGL', {
          currentPrice: 101.5,
          previousClose: 100,
          change: 1.5,
          changePercent: 1.5,
          // no extendedPrice / extendedChangePercent
        }],
      ]),
    });

    const { getHeatmapData } = await import('../services/market-heatmap.service');
    const resp = await getHeatmapData('1D');

    const googl = resp.sectors[0]?.stocks[0];
    expect(googl?.changePercent).toBeCloseTo(1.5, 2);
    expect(googl?.price).toBe(101.5);
  });

  it('preserves extended-hours change overnight (CLOSED session) when quote reflects AH close', async () => {
    // Real-world scenario: at 1:50 AM ET (CLOSED, between POST end and PRE start), Yahoo's
    // postMarketPrice is preserved in `quote.currentPrice` and the override path has
    // recomputed `quote.changePercent` against `previousClose`. The heatmap must use that
    // value, NOT the regular-session candle change — otherwise the tile flips back to red
    // at 8:01 PM and stays wrong all night.
    mocks.getMarketSession.mockReturnValue('CLOSED');
    mocks.fetchPrices.mockResolvedValue({
      quotes: new Map([
        ['GOOGL', {
          // Yahoo overlay during CLOSED: currentPrice = AH close, changePercent recomputed
          // against previousClose by the batch path at market.service.ts:896-900.
          // NOTE: extendedPrice/extendedChangePercent are intentionally NOT set here —
          // those are gated to PRE/POST in the current backend, so during CLOSED they're null.
          // The heatmap must still preserve the AH change via quote.changePercent.
          currentPrice: 106.84,
          previousClose: 100,
          change: 6.84,
          changePercent: 6.84,
        }],
      ]),
    });
    // CLOSED triggers fetchOneDayChangesFromCandles, which compares regular-session daily
    // closes. If candles dominate, GOOGL would render at -0.16% (red) — wrong.
    mocks.fetchDailyCandles.mockResolvedValue([
      { date: '2026-04-28', open: 100, high: 100.5, low: 99.5, close: 100, volume: 1_000_000 },
      { date: '2026-04-29', open: 100, high: 100.2, low: 99.6, close: 99.84, volume: 1_000_000 },
    ]);

    const { getHeatmapData } = await import('../services/market-heatmap.service');
    const resp = await getHeatmapData('1D');

    const googl = resp.sectors[0]?.stocks[0];
    expect(googl?.ticker).toBe('GOOGL');
    // BEFORE FIX: use1DCandles gates off the live-quote branch, candle change wins → -0.16%.
    // AFTER FIX: quote.changePercent (already AH-aware via Yahoo overlay) wins → +6.84%.
    expect(googl?.changePercent).toBeGreaterThan(5);
    expect(googl?.changePercent).toBeCloseTo(6.84, 1);
    // Tile should display the AH close, not the regular close.
    expect(googl?.price).toBe(106.84);
  });

  it('falls back to candles during CLOSED when quote.changePercent is 0 (stale weekend snapshot)', async () => {
    // Defensive case: on a weekend with a stale Polygon snapshot, the override path may
    // not have fired and quote.changePercent is 0. We should not display 0 — fall to
    // candles to show the most recent trading day's move vs the prior trading day.
    mocks.getMarketSession.mockReturnValue('CLOSED');
    mocks.fetchPrices.mockResolvedValue({
      quotes: new Map([
        ['GOOGL', {
          currentPrice: 100,
          previousClose: 100,
          change: 0,
          changePercent: 0,
        }],
      ]),
    });
    mocks.fetchDailyCandles.mockResolvedValue([
      { date: '2026-04-25', open: 99, high: 100, low: 98.5, close: 99, volume: 1_000_000 },
      { date: '2026-04-28', open: 99.5, high: 101, low: 99, close: 100.98, volume: 1_000_000 },
    ]);

    const { getHeatmapData } = await import('../services/market-heatmap.service');
    const resp = await getHeatmapData('1D');

    const googl = resp.sectors[0]?.stocks[0];
    // Candle change = (100.98 - 99) / 99 = ~2.0%
    expect(googl?.changePercent).toBeCloseTo(2.0, 1);
  });

  it('ignores extended-hours fields for non-1D periods (period change comes from candles)', async () => {
    mocks.getMarketSession.mockReturnValue('POST');
    mocks.fetchPrices.mockResolvedValue({
      quotes: new Map([
        ['GOOGL', {
          currentPrice: 99.84,
          previousClose: 100,
          change: -0.16,
          changePercent: -0.16,
          extendedPrice: 106.84,
          extendedChangePercent: 7.01,
        }],
      ]),
    });
    // 1W candles: simulate a 5% week-over-week gain unrelated to today's after-hours pop.
    mocks.fetchDailyCandles.mockResolvedValue([
      { date: '2026-04-22', open: 95, high: 96, low: 94, close: 95, volume: 1000 },
      { date: '2026-04-23', open: 95.5, high: 96.5, low: 94.5, close: 96, volume: 1000 },
      { date: '2026-04-24', open: 96, high: 97, low: 95.5, close: 96.5, volume: 1000 },
      { date: '2026-04-25', open: 96.5, high: 98, low: 96, close: 97.5, volume: 1000 },
      { date: '2026-04-28', open: 97.5, high: 100, low: 97, close: 99.75, volume: 1000 },
    ]);

    const { getHeatmapData } = await import('../services/market-heatmap.service');
    const resp = await getHeatmapData('1W');

    const googl = resp.sectors[0]?.stocks[0];
    // 1W = the date-anchored candle close -> the REGULAR live price (99.84), NOT the
    // after-hours pop (106.84): (95 -> 99.84) ≈ +5.1%.
    expect(googl?.changePercent).toBeCloseTo(5.09, 1);
    expect(googl?.changePercent).toBeLessThan(6); // ignores the after-hours 106.84
  });
});
