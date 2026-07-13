import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// ---------------------------------------------------------------------------
// REAL getPortfolioChartData — 1D path.
//
// This is the gap the other chart suites leave open: every supertest suite
// mocks getPortfolioChartData, so the function itself (snapshot.service.ts
// ~:2380-2480) is never executed. Here we import it REAL and mock only its
// LEAF dependencies at the lowest STABLE module boundary:
//
//   - ../utils/yahoo-http  : fetchPolygonAggs (Polygon candles), yahooGet
//                            (the Yahoo fallback — never reached when Polygon
//                            returns data). This keeps the REAL
//                            reconstructPortfolioHistoryHiRes under test too.
//   - ../services/portfolio.service : getPortfolio / getHoldings
//   - prisma (global __mockPrisma)  : portfolioSnapshot.findMany (getAllSnapshots
//                            / getSnapshotsAfter) and portfolioCompositionChange
//                            .findFirst (getLatestCompositionChangeAfter).
//
// NOTE on the in-module call graph: getPortfolioChartData calls
// reconstructPortfolioHistoryHiRes / getAllSnapshots / getSnapshotsAfter /
// getLatestCompositionChangeAfter via MODULE-INTERNAL bindings, so mocking the
// snapshot.service exports would NOT intercept them. We therefore mock the
// external deps those helpers bottom out in (yahoo-http + prisma), which the
// real helpers DO call — so the whole 1D pipeline runs for real.
//
// _chartCache (60s TTL, key chart:userId:period:portfolioId) is module-scoped
// and NOT reset between tests. We defend against cross-test bleed two ways:
// vi.resetModules() + dynamic import in each test, AND a distinct userId per
// test.
// ---------------------------------------------------------------------------

const {
  getPortfolioMock,
  getHoldingsMock,
  fetchPolygonAggsMock,
  yahooGetMock,
} = vi.hoisted(() => ({
  getPortfolioMock: vi.fn(),
  getHoldingsMock: vi.fn(),
  fetchPolygonAggsMock: vi.fn(),
  yahooGetMock: vi.fn(),
}));

vi.mock('../services/portfolio.service', async () => {
  const actual = await vi.importActual<typeof import('../services/portfolio.service')>('../services/portfolio.service');
  return { ...actual, getPortfolio: getPortfolioMock, getHoldings: getHoldingsMock };
});

vi.mock('../utils/yahoo-http', async () => {
  const actual = await vi.importActual<typeof import('../utils/yahoo-http')>('../utils/yahoo-http');
  return {
    ...actual,
    fetchPolygonAggs: fetchPolygonAggsMock,
    yahooGet: yahooGetMock,
    // fetchPolygonAggs is fully mocked so getPolygonKey is never reached, but
    // stub it defensively in case any other code path consults it.
    getPolygonKey: vi.fn().mockResolvedValue('test-key'),
  };
});

// ---------------------------------------------------------------------------
// Fixed "now": Monday Feb 23 2026, 2:00 PM ET. Feb 23 2026 is EST (UTC-5),
// so 14:00 ET == 19:00 UTC. Market is open → 1D live-append + gap logic active.
// ---------------------------------------------------------------------------
function etTime(hour: number, minute: number, dateStr = '2026-02-23'): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hour + 5, minute);
}
const NOW = etTime(14, 0);
const FIVE_MIN_MS = 5 * 60 * 1000;

const SHARES = 10;
const CASH = 5000;

/** Portfolio stub. liveValue = totalAssets - marginDebt. */
function makePortfolio(overrides: Record<string, any> = {}) {
  return {
    holdings: [], options: [],
    cashBalance: CASH, marginDebt: 0,
    holdingsValue: 46000, totalAssets: 51000, netEquity: 51000,
    totalValue: 51000, totalCost: 45000, totalPL: 6000, totalPLPercent: 13.33,
    dayChange: 250, dayChangePercent: 0.49,
    ...overrides,
  };
}

/**
 * Build a Polygon candle result (timestamps in SECONDS, per the real API).
 * `count` bars ending `endMs`, spaced 5 min, with closes derived from a base
 * price so the reconstructed portfolio value is cash + shares*close.
 */
function makePolygonResult(count: number, endMs: number, basePrice: number) {
  const timestamps: number[] = [];
  const closes: number[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const tMs = endMs - i * FIVE_MIN_MS;
    timestamps.push(Math.floor(tMs / 1000)); // seconds
    // gentle drift so neighbors differ by <3% (no spike-filter interference)
    closes.push(basePrice + (count - 1 - i) * 0.5);
  }
  return {
    timestamps,
    closes,
    highs: closes.slice(),
    lows: closes.slice(),
    opens: closes.slice(),
    volumes: closes.map(() => 1000),
  };
}

let uid = 0;
function freshUserId() {
  return `chart-data-user-${uid++}`;
}

async function loadReal() {
  // Fresh module graph → fresh module-scoped _chartCache.
  vi.resetModules();
  const mod = await import('../services/snapshot.service');
  return mod.getPortfolioChartData;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.clearAllMocks();
  // getLatestCompositionChangeAfter → null (no composition change)
  (prismaMock as any).portfolioCompositionChange.findFirst.mockResolvedValue(null);
  // getAllSnapshots / getSnapshotsAfter → none (1D happy path uses candles)
  (prismaMock as any).portfolioSnapshot.findMany.mockResolvedValue([]);
  getHoldingsMock.mockResolvedValue([{ ticker: 'AAPL', shares: SHARES }]);
  yahooGetMock.mockRejectedValue(new Error('yahoo should not be called'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getPortfolioChartData — real 1D path', () => {
  it('normalizes points to liveValue and anchors periodStartValue to previousClose', async () => {
    const userId = freshUserId();
    // 30 candles (>=5 → no snapshot fallback), last bar 5 min before NOW so the
    // live value appends (gap 5min..4h). basePrice 4500 → last candle value =
    // 5000 + 10*(4500 + 29*0.5) = 5000 + 10*4514.5 = 50145. liveValue = 51000.
    // Multiplicative anchor: scale = 51000/50145 → every candle scaled (last → liveValue). F-M-13.
    fetchPolygonAggsMock.mockResolvedValue(
      makePolygonResult(30, NOW - FIVE_MIN_MS, 4500),
    );
    getPortfolioMock.mockResolvedValue(makePortfolio({ totalAssets: 51000, marginDebt: 0, dayChange: 250 }));

    const getPortfolioChartData = await loadReal();
    const { points, periodStartValue, source } = await getPortfolioChartData(userId, '1D');

    const liveValue = 51000;
    const dayChange = 250;

    // Real candle pipeline ran (Polygon path), not the snapshot fallback.
    expect(source).toBe('hiRes');
    expect(fetchPolygonAggsMock).toHaveBeenCalled();
    expect(yahooGetMock).not.toHaveBeenCalled();

    // 30 candles + 1 appended live point.
    expect(points.length).toBe(31);

    // Multiplicative anchor scales the series so its last point equals liveValue while
    // preserving the % return between points. The final point is the appended live value;
    // the candle immediately before it scales to liveValue.
    const last = points[points.length - 1];
    expect(last.time).toBe(NOW);
    expect(last.value).toBeCloseTo(liveValue, 6);

    // The candle just before the live append (50145) scales to liveValue.
    expect(points[points.length - 2].value).toBeCloseTo(liveValue, 6);

    // First candle 50000 scales by 51000/50145 → the candle-to-candle % return is preserved
    // (an additive shift distorted it). F-M-13.
    expect(points[0].value).toBeCloseTo(50000 * (51000 / 50145), 6);

    // periodStartValue uses the previousClose anchor: liveValue - dayChange.
    expect(periodStartValue).toBeCloseTo(liveValue - dayChange, 6); // 50750
  });

  it('falls back to points[0] for periodStartValue when previousClose <= 0', async () => {
    const userId = freshUserId();
    // dayChange == liveValue → previousCloseValue = 0 (falsy) → fallback to
    // points[0].value.
    fetchPolygonAggsMock.mockResolvedValue(
      makePolygonResult(30, NOW - FIVE_MIN_MS, 4500),
    );
    getPortfolioMock.mockResolvedValue(makePortfolio({ totalAssets: 51000, marginDebt: 0, dayChange: 51000 }));

    const getPortfolioChartData = await loadReal();
    const { points, periodStartValue } = await getPortfolioChartData(userId, '1D');

    expect(points.length).toBeGreaterThan(0);
    // previousClose = 51000 - 51000 = 0 → falsy → periodStartValue = first point.
    expect(periodStartValue).toBe(points[0].value);
    expect(periodStartValue).not.toBe(0);
  });

  it('serves a cached result on a second call within the TTL (no refetch)', async () => {
    const userId = freshUserId();
    fetchPolygonAggsMock.mockResolvedValue(
      makePolygonResult(30, NOW - FIVE_MIN_MS, 4500),
    );
    getPortfolioMock.mockResolvedValue(makePortfolio());

    // Same module instance (no resetModules between the two calls) → the
    // module-scoped _chartCache is shared, so the 2nd call hits the cache.
    vi.resetModules();
    const { getPortfolioChartData } = await import('../services/snapshot.service');

    const first = await getPortfolioChartData(userId, '1D');
    const callsAfterFirst = fetchPolygonAggsMock.mock.calls.length;
    const second = await getPortfolioChartData(userId, '1D');

    expect(second).toEqual(first);
    // No additional Polygon fetches on the cached call.
    expect(fetchPolygonAggsMock.mock.calls.length).toBe(callsAfterFirst);
    // getPortfolio is also skipped on a cache hit (cache check precedes it).
    expect(getPortfolioMock).toHaveBeenCalledTimes(1);
  });

  it('uses the snapshot fallback when Polygon returns too few candles', async () => {
    const userId = freshUserId();
    // Polygon yields no bars → reconstructPortfolioHistoryHiRes returns [] (<5)
    // → getPortfolioChartData falls back to getAllSnapshots (last 24h).
    fetchPolygonAggsMock.mockResolvedValue(null);
    const snapRows = Array.from({ length: 8 }, (_, i) => ({
      timestamp: new Date(NOW - (8 - i) * 30 * 60 * 1000), // every 30 min in last 4h
      totalValue: 50800 + i * 10,
      netEquity: 50800 + i * 10,
    }));
    (prismaMock as any).portfolioSnapshot.findMany.mockResolvedValue(snapRows);
    getPortfolioMock.mockResolvedValue(makePortfolio({ totalAssets: 51000, marginDebt: 0, dayChange: 250 }));

    const getPortfolioChartData = await loadReal();
    const { points, periodStartValue, source } = await getPortfolioChartData(userId, '1D');

    expect(source).toBe('snapshot');
    expect(points.length).toBeGreaterThan(0);
    // Last point still pinned to liveValue via offset + live append.
    expect(points[points.length - 1].value).toBeCloseTo(51000, 6);
    expect(periodStartValue).toBeCloseTo(51000 - 250, 6);
  });
});
