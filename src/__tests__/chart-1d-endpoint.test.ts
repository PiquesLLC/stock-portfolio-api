import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { generateTestToken, testUser } from './helpers';

// ---------------------------------------------------------------------------
// Hoisted mocks — created before any module loads
// ---------------------------------------------------------------------------
const {
  getPortfolioMock,
  getHoldingsMock,
  reconstructPortfolioHistoryHiResMock,
  getAllSnapshotsMock,
  getSnapshotsAfterMock,
  getLatestCompositionChangeAfterMock,
  getUserChartHandlerMock,
  getPortfolioChartDataMock,
} = vi.hoisted(() => ({
  getPortfolioMock: vi.fn(),
  getHoldingsMock: vi.fn(),
  reconstructPortfolioHistoryHiResMock: vi.fn(),
  getAllSnapshotsMock: vi.fn(),
  getSnapshotsAfterMock: vi.fn(),
  getLatestCompositionChangeAfterMock: vi.fn(),
  getUserChartHandlerMock: vi.fn(),
  getPortfolioChartDataMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../services/portfolio.service', async () => {
  const actual = await vi.importActual<typeof import('../services/portfolio.service')>('../services/portfolio.service');
  return {
    ...actual,
    getPortfolio: getPortfolioMock,
    getHoldings: getHoldingsMock,
  };
});

vi.mock('../services/snapshot.service', async () => {
  const actual = await vi.importActual<typeof import('../services/snapshot.service')>('../services/snapshot.service');
  return {
    ...actual,
    getPortfolioChartData: getPortfolioChartDataMock,
    reconstructPortfolioHistoryHiRes: reconstructPortfolioHistoryHiResMock,
    getAllSnapshots: getAllSnapshotsMock,
    getSnapshotsAfter: getSnapshotsAfterMock,
    getLatestCompositionChangeAfter: getLatestCompositionChangeAfterMock,
    recordCompositionChange: vi.fn().mockResolvedValue(undefined),
    resetSnapshotsForCompositionChange: vi.fn().mockResolvedValue(undefined),
    createSnapshotIfNeeded: vi.fn().mockResolvedValue(null),
    createUserSnapshotIfNeeded: vi.fn().mockResolvedValue(false),
    getSnapshotChartPoints: vi.fn().mockResolvedValue([]),
    reconstructPortfolioHistory: vi.fn().mockResolvedValue([]),
    reconstructPortfolioHistoryFromLedger: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../middleware/rateLimiter', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const passthrough = (_req: any, _res: any, next: any) => next();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? passthrough : v]),
  );
});

// optionalAuth supports x-skip-auth header to simulate unauthenticated requests.
// x-test-plan header overrides the injected plan (defaults to 'pro' so existing
// tests are unaffected) — used by the plan-gating suite to exercise free vs pro.
vi.mock('../middleware/auth.middleware', () => {
  const authHandler = (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-id-123', username: 'testuser', plan: (req.headers['x-test-plan'] as string) || 'pro' };
    next();
  };
  const optionalAuthHandler = (req: any, _res: any, next: any) => {
    if (req.headers['x-skip-auth'] !== '1') {
      req.user = { userId: 'test-user-id-123', username: 'testuser', plan: (req.headers['x-test-plan'] as string) || 'pro' };
    }
    next();
  };
  return {
    requireAuth: authHandler,
    requireAuthAllowUnverified: authHandler,
    optionalAuth: optionalAuthHandler,
    requireOwnership: () => (_req: any, _res: any, next: any) => next(),
  };
});

vi.mock('../middleware/email-verification.middleware', () => ({
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
}));

// Mock user chart handler so ?userId= delegation tests don't need full user-portfolio wiring
vi.mock('../controllers/users.controller', async () => {
  const actual = await vi.importActual<typeof import('../controllers/users.controller')>('../controllers/users.controller');
  return {
    ...actual,
    getUserChartHandler: getUserChartHandlerMock,
  };
});

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  Handlers: {
    requestHandler: () => (_req: any, _res: any, next: any) => next(),
    errorHandler: () => (_err: any, _req: any, _res: any, next: any) => next(),
  },
  captureException: vi.fn(),
  setUser: vi.fn(),
  startSpan: vi.fn((_: any, cb: any) => cb({})),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate `count` candle-like points starting at `baseTimeMs`. */
function makeCandles(
  count: number,
  baseTimeMs: number,
  intervalMs: number,
  baseValue: number,
): { time: number; value: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    time: baseTimeMs + i * intervalMs,
    value: baseValue + (i % 10) * 5, // small wobble
  }));
}

/** Create a portfolio mock with sensible defaults. */
function makePortfolio(overrides: Record<string, any> = {}) {
  return {
    holdings: [],
    options: [],
    cashBalance: 5000,
    marginDebt: 0,
    holdingsValue: 46000,
    totalAssets: 51000,
    netEquity: 51000,
    totalValue: 51000,
    totalCost: 45000,
    totalPL: 6000,
    totalPLPercent: 13.33,
    dayChange: 250,
    dayChangePercent: 0.49,
    regularDayChange: 250,
    regularDayChangePercent: 0.49,
    afterHoursChange: 0,
    afterHoursChangePercent: 0,
    quotesStale: false,
    quotesUnavailableCount: 0,
    quotesMeta: {},
    session: 'regular',
    ...overrides,
  };
}

/** Create a snapshot-like object. */
function makeSnapshot(timestamp: number, value: number) {
  return {
    timestamp: new Date(timestamp),
    totalValue: value,
    netEquity: value,
    cashBalance: 5000,
    dailyPL: 0,
    dailyPLPercent: 0,
    totalPL: 0,
    totalPLPercent: 0,
    userId: 'test-user-id-123',
  };
}

/**
 * Convert an ET hour/minute to a UTC timestamp on a specific date.
 * Feb 23 2026 is EST (UTC-5), so ET → UTC = hour+5.
 */
function etTime(hour: number, minute: number, dateStr = '2026-02-23'): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hour + 5, minute);
}

/**
 * Simulate the 1D path of getPortfolioChartData to produce the expected mock return value.
 * This mirrors the real service logic so tests can verify the controller's response handling.
 */
function simulate1DChartData(opts: {
  candles: { time: number; value: number }[];
  liveValue: number;
  dayChange: number;
  allSnapshots?: { timestamp: Date; totalValue: number; netEquity: number }[];
  gapSnapshots?: { timestamp: Date; totalValue: number; netEquity: number }[];
  compositionChangeAt?: Date | null;
  now: number;
}): { points: { time: number; value: number }[]; periodStartValue: number; source: string } {
  const { candles, liveValue, dayChange, allSnapshots = [], gapSnapshots = [], compositionChangeAt = null, now } = opts;
  const previousCloseValue = liveValue - dayChange;
  let source = 'hiRes';
  let points = candles.map(c => ({ ...c })); // clone

  // Snapshot fallback
  if (points.length < 5) {
    const cutoff = now - 24 * 60 * 60 * 1000;
    const recent = allSnapshots.filter(s => s.timestamp.getTime() >= cutoff);
    if (recent.length >= 2) {
      points = recent.map(s => ({ time: s.timestamp.getTime(), value: s.netEquity ?? s.totalValue }));
      source = 'snapshot';
    }
  }

  // Offset normalization
  if (points.length > 0 && liveValue > 0) {
    const lastVal = points[points.length - 1].value;
    const offset = liveValue - lastVal;
    if (Math.abs(offset) > 1) {
      for (const p of points) p.value += offset;
    }
  }

  // Gap filling
  if (points.length > 0) {
    const lastCandleTime = points[points.length - 1].time;
    const gapMs = now - lastCandleTime;
    if (gapMs > 5 * 60 * 1000 && gapMs < 4 * 3600000) {
      const lastCandleValue = points[points.length - 1].value;
      for (const s of gapSnapshots) {
        const t = s.timestamp.getTime();
        const v = s.netEquity ?? s.totalValue;
        if (lastCandleValue > 0 && (v <= 0 || Math.abs(v - lastCandleValue) / lastCandleValue > 0.15)) continue;
        if (t > lastCandleTime && t < now - 5000) points.push({ time: t, value: v });
      }
    }
  }

  // Live value append
  const lastPointTime = points.length > 0 ? points[points.length - 1].time : 0;
  if (points.length === 0 || (now - lastPointTime > 5000 && now - lastPointTime < 4 * 3600000)) {
    points.push({ time: now, value: liveValue });
  }

  // Spike filter
  if (points.length >= 3) {
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1].value;
      const curr = points[i].value;
      const next = points[i + 1].value;
      const neighborAvg = (prev + next) / 2;
      if (neighborAvg > 0 && Math.abs(curr - neighborAvg) / neighborAvg > 0.03) {
        points[i].value = neighborAvg;
      }
    }
  }

  // Composition change filter
  if (compositionChangeAt) {
    const cutoff = compositionChangeAt.getTime();
    const filtered = points.filter(p => p.time >= cutoff);
    const minUsable = Math.max(20, Math.ceil(points.length * 0.5));
    const etHourFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
    });
    const hasMarketHours = filtered.some(p => {
      const h = parseInt(etHourFmt.format(new Date(p.time)).split(':')[0]);
      return h >= 4 && h < 20;
    });
    if (filtered.length >= minUsable && hasMarketHours) {
      points = filtered;
    }
  }

  // periodStartValue
  const periodStartValue = (previousCloseValue && Number.isFinite(previousCloseValue) && previousCloseValue > 0)
    ? previousCloseValue
    : (points.length > 0 ? points[0].value : liveValue);

  return { points, periodStartValue, source };
}

// ---------------------------------------------------------------------------
// Fixed "now" — Monday Feb 23 2026, 2:00 PM ET (19:00 UTC)
// ---------------------------------------------------------------------------
const NOW = etTime(14, 0);
const FIVE_MIN = 5 * 60 * 1000;
const MARKET_OPEN_ET = etTime(4, 0); // 4 AM ET = 09:00 UTC

// Default fixture: 120 candles from 4:00 AM → 1:55 PM ET (realistic intraday).
// Last candle at 1:55 PM, NOW at 2:00 PM → 5-min gap → live value appended.
// Total default points = 121 (120 candles + 1 live).
const DEFAULT_CANDLE_COUNT = 120;

describe('GET /portfolio/history/chart?period=1D', () => {
  const token = generateTestToken(testUser);

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.clearAllMocks();

    // Default mocks — happy path
    getPortfolioMock.mockResolvedValue(makePortfolio());
    getHoldingsMock.mockResolvedValue([
      { ticker: 'AAPL', shares: 10, averageCost: 200 },
      { ticker: 'MSFT', shares: 5, averageCost: 400 },
    ]);

    const candles = makeCandles(DEFAULT_CANDLE_COUNT, MARKET_OPEN_ET, FIVE_MIN, 50800);
    reconstructPortfolioHistoryHiResMock.mockResolvedValue(candles);

    getAllSnapshotsMock.mockResolvedValue([]);
    getSnapshotsAfterMock.mockResolvedValue([]);
    getLatestCompositionChangeAfterMock.mockResolvedValue(null);

    // Default getPortfolioChartData mock — matches the default happy path
    // (120 candles + 1 live = 121 points, periodStartValue = 50750, source = hiRes)
    const defaultChartData = simulate1DChartData({
      candles: makeCandles(DEFAULT_CANDLE_COUNT, MARKET_OPEN_ET, FIVE_MIN, 50800),
      liveValue: 51000,
      dayChange: 250,
      now: NOW,
    });
    getPortfolioChartDataMock.mockResolvedValue(defaultChartData);

    // Default: delegated handler returns a simple 200
    getUserChartHandlerMock.mockImplementation((_req: any, res: any) => {
      res.json({ points: [], periodStartValue: 0, period: '1D', delegated: true });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Category 1: Composition Change Filter
  // =========================================================================
  describe('Composition change filter', () => {
    it('Test 1: after-hours change skips filter when no points survive cutoff', async () => {
      // Composition change at 9 PM ET — all 121 points are before 9 PM
      // (candles 4AM–1:55PM, live at 2PM). Filtered set = 0 points → filter skipped.
      const changeAt = new Date(etTime(21, 0));
      const chartData = simulate1DChartData({
        candles: makeCandles(DEFAULT_CANDLE_COUNT, MARKET_OPEN_ET, FIVE_MIN, 50800),
        liveValue: 51000,
        dayChange: 250,
        compositionChangeAt: changeAt,
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      expect(res.body.points.length).toBe(121);
    });

    it('Test 2: mid-session change skips filter when filtered set is below minUsable', async () => {
      // Explicit too-few-points case (distinct from Test 3):
      // 50 candles (4:00 AM to 8:05 AM ET). No live appended (gap > 4h).
      // Change at 7:00 AM leaves 14 points; minUsable = 25, so filter is skipped.
      const changeAt = new Date(etTime(7, 0));
      const chartData = simulate1DChartData({
        candles: makeCandles(50, MARKET_OPEN_ET, FIVE_MIN, 50800),
        liveValue: 51000,
        dayChange: 250,
        compositionChangeAt: changeAt,
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      // Filter skipped — full dataset returned
      expect(res.body.points.length).toBe(50);
    });

    it('Test 3: early-session change applies filter when enough points survive', async () => {
      // 121 total points (120 candles + 1 live).
      // Composition change at 5:55 AM → candles from index 23 onward = 97 + live = 98.
      // minUsable = max(20, ceil(121*0.5)) = 61. 98 >= 61 ✓ → filter applies.
      const changeAt = new Date(etTime(5, 55));
      const chartData = simulate1DChartData({
        candles: makeCandles(DEFAULT_CANDLE_COUNT, MARKET_OPEN_ET, FIVE_MIN, 50800),
        liveValue: 51000,
        dayChange: 250,
        compositionChangeAt: changeAt,
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      const { points } = res.body;
      expect(points.length).toBe(98);
      expect(points.length).toBeLessThan(121);
      // periodStartValue always uses previousCloseValue (totalValue - dayChange = 50750)
      expect(res.body.periodStartValue).toBe(50750);
    });

    it('Test 4: no composition change → full data with previousCloseValue', async () => {
      // Default getPortfolioChartDataMock (no composition change) is set in beforeEach

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      // 120 candles + 1 live value = 121
      expect(res.body.points.length).toBe(121);
      // periodStartValue = liveValue - dayChange = 51000 - 250 = 50750
      expect(res.body.periodStartValue).toBe(50750);
    });

    it('Test 5: exactly 50% boundary → filter applies', async () => {
      // 40 candles (4:00 AM → 7:15 AM ET). Gap > 4h → no live appended.
      // minUsable = max(20, ceil(40*0.5)) = 20.
      // Cutoff at 5:35 AM → indices 19..39 = 21 candles. 21 >= 20 ✓ → filter applies.
      const changeAt = new Date(etTime(5, 35));
      const chartData = simulate1DChartData({
        candles: makeCandles(40, MARKET_OPEN_ET, FIVE_MIN, 50800),
        liveValue: 51000,
        dayChange: 250,
        compositionChangeAt: changeAt,
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      expect(res.body.points.length).toBe(21);
    });

    it('Test 6: sufficient filtered points but all outside market hours → filter skipped', async () => {
      // 30 candles starting at 8:30 PM ET (hour 20). All outside market hours (4AM–8PM).
      // Composition change at 8:00 PM → all 30 pass the time filter.
      // minUsable = max(20, ceil(30*0.5)) = 20. 30 >= 20 ✓
      // BUT hasMarketHours = false (all hours >= 20) → filter skipped.
      const changeAt = new Date(etTime(20, 0));
      const chartData = simulate1DChartData({
        candles: makeCandles(30, etTime(20, 30), FIVE_MIN, 50800),
        liveValue: 51000,
        dayChange: 250,
        compositionChangeAt: changeAt,
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      // Filter skipped — full dataset
      expect(res.body.points.length).toBe(30);
    });
  });

  // =========================================================================
  // Category 2: Data Sufficiency
  // =========================================================================
  describe('Data sufficiency', () => {
    it('Test 7: normal trading day returns full candle set', async () => {
      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      expect(res.body.points.length).toBe(121);
      for (const p of res.body.points) {
        expect(typeof p.time).toBe('number');
        expect(typeof p.value).toBe('number');
      }
    });

    it('Test 8: snapshot fallback when hiRes returns insufficient data', async () => {
      // hiRes returns < 5 points → triggers snapshot fallback inside getPortfolioChartData.
      // We simulate the same scenario to produce the expected output.
      const snapshots = Array.from({ length: 30 }, (_, i) =>
        makeSnapshot(NOW - (30 - i) * 30 * 60 * 1000, 50800 + i * 10),
      );
      const chartData = simulate1DChartData({
        candles: [{ time: NOW - 60000, value: 50900 }], // < 5 → snapshot fallback
        liveValue: 51000,
        dayChange: 250,
        allSnapshots: snapshots,
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      expect(res.body.points.length).toBeGreaterThan(0);
      // getPortfolioChartData is now the single entry point; verify it was called
      expect(getPortfolioChartDataMock).toHaveBeenCalled();
    });

    it('Test 9: no candles + no snapshots → live value only', async () => {
      const chartData = simulate1DChartData({
        candles: [],
        liveValue: 51000,
        dayChange: 250,
        allSnapshots: [],
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      expect(res.body.points.length).toBe(1);
      expect(res.body.points[0].value).toBe(51000);
    });

    it('Test 10: empty portfolio (cash only) returns cash value', async () => {
      getPortfolioMock.mockResolvedValue(makePortfolio({
        holdingsValue: 0,
        totalAssets: 1000,
        netEquity: 1000,
        totalValue: 1000,
        cashBalance: 1000,
        totalCost: 0,
        totalPL: 0,
        totalPLPercent: 0,
        dayChange: 0,
        dayChangePercent: 0,
      }));
      // liveValue = totalAssets - marginDebt = 1000 - 0 = 1000
      const chartData = simulate1DChartData({
        candles: [],
        liveValue: 1000,
        dayChange: 0,
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      expect(res.body.points[0].value).toBe(1000);
    });
  });

  // =========================================================================
  // Category 3: Value Normalization (offset)
  // =========================================================================
  describe('Value normalization', () => {
    it('Test 11: offset applied when diff > $1', async () => {
      // Last candle = 50900, live = 51000 → offset = +100
      const candles = makeCandles(DEFAULT_CANDLE_COUNT, MARKET_OPEN_ET, FIVE_MIN, 50800);
      candles[candles.length - 1].value = 50900;
      const chartData = simulate1DChartData({
        candles,
        liveValue: 51000,
        dayChange: 250,
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      // First candle was 50800, after offset → 50900
      expect(res.body.points[0].value).toBe(50900);
    });

    it('Test 12: offset skipped when diff ≤ $1', async () => {
      const candles = makeCandles(DEFAULT_CANDLE_COUNT, MARKET_OPEN_ET, FIVE_MIN, 50800);
      candles[candles.length - 1].value = 50999.50;
      const chartData = simulate1DChartData({
        candles,
        liveValue: 51000,
        dayChange: 250,
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      // No offset → first candle unchanged
      expect(res.body.points[0].value).toBe(50800);
    });
  });

  // =========================================================================
  // Category 4: Gap Filling
  // =========================================================================
  describe('Gap filling', () => {
    it('Test 13: 15-min gap bridged with snapshots', async () => {
      // Last candle at 13:45 ET, NOW = 14:00 ET → 15-min gap (within 4h)
      const candles = makeCandles(DEFAULT_CANDLE_COUNT, MARKET_OPEN_ET, FIVE_MIN, 50800);
      candles[candles.length - 1].time = etTime(13, 45);

      const gapSnapshots = [
        makeSnapshot(etTime(13, 48), 50950),
        makeSnapshot(etTime(13, 51), 50960),
        makeSnapshot(etTime(13, 54), 50970),
      ];
      const chartData = simulate1DChartData({
        candles,
        liveValue: 51000,
        dayChange: 250,
        gapSnapshots,
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      // 120 candles + 3 snapshots + 1 live = 124
      expect(res.body.points.length).toBe(124);
      // getPortfolioChartData is the single entry point; verify it was called
      expect(getPortfolioChartDataMock).toHaveBeenCalled();
    });

    it('Test 14: >4hr gap NOT bridged', async () => {
      // 48 candles (4:00 AM → 7:55 AM ET). Gap = ~6h → >4h threshold.
      const chartData = simulate1DChartData({
        candles: makeCandles(48, MARKET_OPEN_ET, FIVE_MIN, 50800),
        liveValue: 51000,
        dayChange: 250,
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      // Gap > 4h: no gap bridging, no live append
      expect(res.body.points.length).toBe(48);
    });
  });

  // =========================================================================
  // Category 5: Response Shape
  // =========================================================================
  describe('Response shape', () => {
    it('Test 15: correct response shape', async () => {
      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('points');
      expect(res.body).toHaveProperty('periodStartValue');
      expect(res.body).toHaveProperty('period', '1D');
      expect(Array.isArray(res.body.points)).toBe(true);
      expect(typeof res.body.periodStartValue).toBe('number');
    });

    it('Test 16: periodStartValue = previousCloseValue when no composition change', async () => {
      // liveValue = 51000, dayChange = 250 → previousCloseValue = 50750
      // Default getPortfolioChartDataMock (no composition change) is set in beforeEach

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      expect(res.body.periodStartValue).toBe(50750);
    });

    it('Test 17: periodStartValue uses previousCloseValue even when composition change applied', async () => {
      const changeAt = new Date(etTime(5, 55));
      const chartData = simulate1DChartData({
        candles: makeCandles(DEFAULT_CANDLE_COUNT, MARKET_OPEN_ET, FIVE_MIN, 50800),
        liveValue: 51000,
        dayChange: 250,
        compositionChangeAt: changeAt,
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      // periodStartValue always uses previousCloseValue (totalValue - dayChange = 50750)
      expect(res.body.periodStartValue).toBe(50750);
    });
  });

  // =========================================================================
  // Category 6: Edge Cases (from audit)
  // =========================================================================
  describe('Edge cases', () => {
    it('Test 18: unauthenticated request (no user) → 401', async () => {
      // Route uses optionalAuth — without userId param, own-portfolio path
      // requires auth. Handler returns 401 early.
      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('x-skip-auth', '1');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Authentication required');
    });

    it('Test 19: marginDebt > 0 reduces live value', async () => {
      // liveValue = totalAssets - marginDebt = 51000 - 1000 = 50000
      getPortfolioMock.mockResolvedValue(makePortfolio({ marginDebt: 1000 }));
      const chartData = simulate1DChartData({
        candles: [],
        liveValue: 50000, // totalAssets(51000) - marginDebt(1000)
        dayChange: 250,
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      expect(res.body.points.length).toBe(1);
      expect(res.body.points[0].value).toBe(50000);
    });

    it('Test 20: previousCloseValue = 0 (falsy) → falls back to first point value', async () => {
      // liveValue = 500, dayChange = 500 → previousCloseValue = 0 (falsy).
      // The || fallback gives periodStartValue = points[0].value.
      getPortfolioMock.mockResolvedValue(makePortfolio({
        totalAssets: 500,
        marginDebt: 0,
        dayChange: 500,
      }));
      const chartData = simulate1DChartData({
        candles: makeCandles(DEFAULT_CANDLE_COUNT, MARKET_OPEN_ET, FIVE_MIN, 400),
        liveValue: 500,
        dayChange: 500,
        now: NOW,
      });
      getPortfolioChartDataMock.mockResolvedValue(chartData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      // previousCloseValue = 500 - 500 = 0 → falsy → falls back to points[0].value
      expect(res.body.periodStartValue).toBe(res.body.points[0].value);
      expect(res.body.periodStartValue).not.toBe(0);
    });

    it('Test 21: ?userId= delegates to getUserChartHandler without auth', async () => {
      // Public profile chart access — no auth needed when userId is provided.
      // Proves the 401 guard is placed AFTER userId delegation.
      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1D&userId=other-user-123')
        .set('x-skip-auth', '1');

      expect(res.status).toBe(200);
      expect(res.body.delegated).toBe(true);
      expect(getUserChartHandlerMock).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Category 7: Plan Gating on Chart Periods
  // =========================================================================
  // getChartHandler (portfolio.controller.ts) gates non-free periods behind a
  // pro+ plan. FREE_CHART_PERIODS = {1D, 1W, YTD}. A free plan requesting any
  // other valid period (1M/3M/6M/1Y/ALL) gets 403 { error: 'upgrade_required',
  // requiredPlan: 'pro' }. The plan is injected by the auth mock from the
  // x-test-plan header (see auth.middleware mock above).
  describe('plan gating', () => {
    // Periods a free plan may NOT access (valid periods minus FREE_CHART_PERIODS)
    const GATED_PERIODS = ['1M', '3M', '6M', '1Y', 'ALL'];
    // Periods always allowed for free
    const FREE_PERIODS = ['1D', '1W', 'YTD'];

    // getPortfolioChartData is mocked; give every non-1D period a 2-point,
    // wide-span dataset so the controller's progressive-unlock gate (3M+/YTD/1Y/ALL)
    // does not short-circuit to insufficientData before the 200 we assert.
    const wideSpanData = {
      points: [
        { time: NOW - 200 * 86400000, value: 50000 },
        { time: NOW, value: 51000 },
      ],
      periodStartValue: 50000,
      source: 'snapshot',
    };

    for (const period of GATED_PERIODS) {
      it(`free plan → ${period} returns 403 upgrade_required`, async () => {
        getPortfolioChartDataMock.mockResolvedValue(wideSpanData);

        const app = (await import('../app')).default;
        const res = await request(app)
          .get(`/portfolio/history/chart?period=${period}`)
          .set('Cookie', `authToken=${token}`)
          .set('x-test-plan', 'free');

        expect(res.status).toBe(403);
        expect(res.body.error).toBe('upgrade_required');
        expect(res.body.requiredPlan).toBe('pro');
        // Gate fires before any data fetch
        expect(getPortfolioChartDataMock).not.toHaveBeenCalled();
      });
    }

    for (const period of FREE_PERIODS) {
      it(`free plan → ${period} returns 200`, async () => {
        getPortfolioChartDataMock.mockResolvedValue(wideSpanData);

        const app = (await import('../app')).default;
        const res = await request(app)
          .get(`/portfolio/history/chart?period=${period}`)
          .set('Cookie', `authToken=${token}`)
          .set('x-test-plan', 'free');

        expect(res.status).toBe(200);
        expect(res.body.period).toBe(period);
      });
    }

    it('pro plan → 1M returns 200 (gated period unlocked)', async () => {
      // 1M is NOT a free period, but pro unlocks it. 1M is also exempt from
      // progressive unlock (controller: !['1D','1W','1M'].includes(period)),
      // so the default happy-path mock (121 points) is returned verbatim.
      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=1M')
        .set('Cookie', `authToken=${token}`)
        .set('x-test-plan', 'pro');

      expect(res.status).toBe(200);
      expect(res.body.period).toBe('1M');
      expect(getPortfolioChartDataMock).toHaveBeenCalled();
    });

    it('premium plan → 6M returns 200 (higher tier also unlocks)', async () => {
      getPortfolioChartDataMock.mockResolvedValue(wideSpanData);

      const app = (await import('../app')).default;
      const res = await request(app)
        .get('/portfolio/history/chart?period=6M')
        .set('Cookie', `authToken=${token}`)
        .set('x-test-plan', 'premium');

      expect(res.status).toBe(200);
      expect(res.body.period).toBe('6M');
    });
  });
});

