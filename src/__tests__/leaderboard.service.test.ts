import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// Regression tests for the leaderboard service.
//
// Focus areas:
//  1. The 1D cost-basis anchor (a position opened today is anchored at its
//     averageCost, not previousClose) — the money-bug guard that keeps the
//     leaderboard 1D return in agreement with getPortfolio's day P&L.
//  2. Ranking order + the `basis: 'none'` fallback for users with no priced
//     holdings.
//  3. Deterministic tie-break: two users with identical returns must sort by
//     userId ascending, stable across repeated calls.
//  4. Region filter -> prisma.user.findMany WHERE shape.
//  5. Empty leaderboard never touches the LeaderboardCache.

const { fetchPricesMock, fetchPolygonAggsMock } = vi.hoisted(() => ({
  fetchPricesMock: vi.fn(),
  fetchPolygonAggsMock: vi.fn(),
}));

// Partial-mock market.service so only fetchPrices is replaced (other exports,
// e.g. those that pull in heavy deps, keep their real implementations).
vi.mock('../services/market.service', async (importOriginal) => ({
  ...(await importOriginal() as object),
  fetchPrices: fetchPricesMock,
}));

// Stub the Polygon candle fetch. Returning null keeps the candle map empty so
// non-1D historical valuation and the anti-cheat series stay inert unless a
// test explicitly opts in by returning candle data.
vi.mock('../utils/yahoo-http', async (importOriginal) => ({
  ...(await importOriginal() as object),
  fetchPolygonAggs: fetchPolygonAggsMock,
}));

import { getLeaderboard } from '../services/leaderboard.service';

// ---- helpers -------------------------------------------------------------

// The service only reads `extendedPrice`, `currentPrice`, and `previousClose`
// off each quote, keyed by UPPERCASE ticker in the Map.
function quote(currentPrice: number, previousClose: number) {
  return { currentPrice, previousClose };
}
function pricesResult(quotes: Map<string, unknown>) {
  return { quotes, staleCount: 0, repricingCount: 0, failedTickers: [], provider: 'polygon' };
}

// A user row matching the `select` in getLeaderboard. trackingStartAt must be
// set well in the past or the user is skipped.
function userRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'u1',
    username: 'alice',
    displayName: 'Alice',
    region: null,
    trackingStartAt: new Date(Date.now() - 90 * 86400000),
    avatarUrl: null,
    ...over,
  };
}

function holdingRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    userId: 'u1',
    ticker: 'AAPL',
    shares: 10,
    averageCost: 100,
    createdAt: new Date(Date.now() - 30 * 86400000), // opened in the past by default
    ...over,
  };
}

// Wire up the prisma surface the service touches. The global setup mock does
// NOT define userSettings.findMany, portfolioSnapshot.count, or
// leaderboardCache.upsert — stub them here.
function setupPrisma(opts: {
  users: ReturnType<typeof userRow>[];
  holdings?: ReturnType<typeof holdingRow>[];
  settings?: Array<{ userId: string; cashBalance: number; marginDebt: number }>;
  captureUserFindMany?: boolean;
}) {
  const p = prismaMock as any;

  if (opts.captureUserFindMany) {
    p.user.findMany = vi.fn((args: unknown) => {
      (setupPrisma as any)._capturedUserArgs = args;
      return Promise.resolve(opts.users);
    });
  } else {
    p.user.findMany = vi.fn().mockResolvedValue(opts.users);
  }

  p.holding.findMany = vi.fn().mockResolvedValue(opts.holdings ?? []);
  p.userSettings = p.userSettings ?? {};
  p.userSettings.findMany = vi.fn().mockResolvedValue(opts.settings ?? []);
  p.portfolioSnapshot = p.portfolioSnapshot ?? {};
  p.portfolioSnapshot.count = vi.fn().mockResolvedValue(0);
  p.leaderboardCache = p.leaderboardCache ?? {};
  p.leaderboardCache.upsert = vi.fn().mockResolvedValue({});
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no Polygon candles -> empty candle map (anti-cheat stays inert).
  fetchPolygonAggsMock.mockResolvedValue(null);
});

// --------------------------------------------------------------------------
// 1. 1D cost-basis anchor (money-bug guard)
// --------------------------------------------------------------------------
describe('getLeaderboard 1D cost-basis anchor (money-bug guard)', () => {
  it('anchors a position opened today at its cost basis, not previousClose', async () => {
    setupPrisma({
      users: [userRow()],
      holdings: [holdingRow({ createdAt: new Date(), averageCost: 100, shares: 10 })],
      settings: [{ userId: 'u1', cashBalance: 0, marginDebt: 0 }],
    });
    // currentPrice 110, previousClose 50. Opened today -> anchor = cost 100.
    fetchPricesMock.mockResolvedValue(pricesResult(new Map([['AAPL', quote(110, 50)]])));

    const res = await getLeaderboard('1D', 'world');

    expect(res.entries).toHaveLength(1);
    const e = res.entries[0];
    // 10*(110-100) / (10*100) = +10%, NOT +120% (which previousClose would give).
    expect(e.returnPct).toBeCloseTo(10, 6);
    expect(e.returnPct).not.toBeCloseTo(120, 1);
    expect(e.returnDollar).toBeCloseTo(100, 6); // 10 * (110 - 100)
    expect(e.basis).toBe('verified');
    expect(e.twrPct).toBeCloseTo(10, 6);
  });

  it('anchors a position opened before today at previousClose', async () => {
    setupPrisma({
      users: [userRow()],
      holdings: [holdingRow({ createdAt: new Date(Date.now() - 3 * 86400000), averageCost: 100, shares: 10 })],
      settings: [{ userId: 'u1', cashBalance: 0, marginDebt: 0 }],
    });
    fetchPricesMock.mockResolvedValue(pricesResult(new Map([['AAPL', quote(110, 50)]])));

    const res = await getLeaderboard('1D', 'world');

    const e = res.entries[0];
    // 10*(110-50) / (10*50) = +120%.
    expect(e.returnPct).toBeCloseTo(120, 6);
    expect(e.returnDollar).toBeCloseTo(600, 6); // 10 * (110 - 50)
  });
});

// --------------------------------------------------------------------------
// 2. Ranking order + basis:'none' fallback
// --------------------------------------------------------------------------
describe('getLeaderboard ranking order', () => {
  it('orders by return desc and puts a no-priced-holdings user last with basis none', async () => {
    setupPrisma({
      users: [
        userRow({ id: 'uB', username: 'b', displayName: 'B' }),
        userRow({ id: 'uC', username: 'c', displayName: 'C' }),
        userRow({ id: 'uA', username: 'a', displayName: 'A' }),
      ],
      holdings: [
        // A: opened-today anchor cost=100, price=120 -> +20%
        { userId: 'uA', ticker: 'AAA', shares: 1, averageCost: 100, createdAt: new Date() },
        // B: opened-today anchor cost=100, price=105 -> +5%
        { userId: 'uB', ticker: 'BBB', shares: 1, averageCost: 100, createdAt: new Date() },
        // C: holds a ticker with no quote -> liveValue null -> basis 'none'
        { userId: 'uC', ticker: 'ZZZ', shares: 1, averageCost: 100, createdAt: new Date() },
      ],
      settings: [
        { userId: 'uA', cashBalance: 0, marginDebt: 0 },
        { userId: 'uB', cashBalance: 0, marginDebt: 0 },
        { userId: 'uC', cashBalance: 0, marginDebt: 0 },
      ],
    });
    fetchPricesMock.mockResolvedValue(pricesResult(new Map<string, unknown>([
      ['AAA', quote(120, 100)],
      ['BBB', quote(105, 100)],
      // ZZZ intentionally absent.
    ])));

    const res = await getLeaderboard('1D', 'world');

    expect(res.entries.map(e => e.userId)).toEqual(['uA', 'uB', 'uC']);
    expect(res.entries[0].returnPct).toBeCloseTo(20, 6);
    expect(res.entries[1].returnPct).toBeCloseTo(5, 6);

    const c = res.entries[2];
    expect(c.basis).toBe('none');
    expect(c.returnPct).toBeNull();
    expect(c.returnDollar).toBeNull();
    expect(c.twrPct).toBeNull();
  });
});

// --------------------------------------------------------------------------
// 3. Tie-break determinism (covered by the STEP 1 comparator fix)
// --------------------------------------------------------------------------
describe('getLeaderboard tie-break determinism', () => {
  it('breaks equal returns by userId ascending, stable across calls', async () => {
    // Two users, identical +10% return. Insertion order is [uZ, uA] (i.e. the
    // tie-break must REORDER to [uA, uZ]); without a secondary key the JS sort
    // could leave them in any order.
    const build = () => setupPrisma({
      users: [
        userRow({ id: 'uZ', username: 'z', displayName: 'Z' }),
        userRow({ id: 'uA', username: 'a', displayName: 'A' }),
      ],
      holdings: [
        { userId: 'uZ', ticker: 'ZED', shares: 1, averageCost: 100, createdAt: new Date() },
        { userId: 'uA', ticker: 'AYE', shares: 1, averageCost: 100, createdAt: new Date() },
      ],
      settings: [
        { userId: 'uZ', cashBalance: 0, marginDebt: 0 },
        { userId: 'uA', cashBalance: 0, marginDebt: 0 },
      ],
    });

    const quotes = () => pricesResult(new Map<string, unknown>([
      ['ZED', quote(110, 100)], // +10%
      ['AYE', quote(110, 100)], // +10%
    ]));

    build();
    fetchPricesMock.mockResolvedValue(quotes());
    const first = await getLeaderboard('1D', 'world');

    expect(first.entries[0].twrPct).toBeCloseTo(10, 6);
    expect(first.entries[1].twrPct).toBeCloseTo(10, 6);
    // Deterministic: userId ascending wins the tie -> uA before uZ.
    expect(first.entries.map(e => e.userId)).toEqual(['uA', 'uZ']);

    // Repeat: same input -> same order.
    vi.clearAllMocks();
    fetchPolygonAggsMock.mockResolvedValue(null);
    build();
    fetchPricesMock.mockResolvedValue(quotes());
    const second = await getLeaderboard('1D', 'world');
    expect(second.entries.map(e => e.userId)).toEqual(['uA', 'uZ']);
  });
});

// --------------------------------------------------------------------------
// 4. Region filter -> user.findMany WHERE shape
// --------------------------------------------------------------------------
describe('getLeaderboard region filter query shape', () => {
  it("adds region:'EU' + showRegion:true for europe and omits them for world", async () => {
    // europe -> EU
    setupPrisma({ users: [], captureUserFindMany: true });
    await getLeaderboard('1M', 'europe');
    let where = ((setupPrisma as any)._capturedUserArgs as any).where;
    expect(where.region).toBe('EU');
    expect(where.showRegion).toBe(true);
    expect(where.leaderboardEligible).toBe(true);
    expect(where.holdingsVisibility).toBe('all');

    // world -> neither key present
    setupPrisma({ users: [], captureUserFindMany: true });
    await getLeaderboard('1M', 'world');
    where = ((setupPrisma as any)._capturedUserArgs as any).where;
    expect('region' in where).toBe(false);
    expect('showRegion' in where).toBe(false);
  });
});

// --------------------------------------------------------------------------
// 5. Empty leaderboard never writes the cache
// --------------------------------------------------------------------------
describe('getLeaderboard empty result', () => {
  it('returns empty entries with an ISO lastUpdated and never calls leaderboardCache.upsert', async () => {
    setupPrisma({ users: [] });
    fetchPricesMock.mockResolvedValue(pricesResult(new Map()));

    const res = await getLeaderboard('1M', 'world');

    expect(res.entries).toEqual([]);
    expect(typeof res.lastUpdated).toBe('string');
    expect(new Date(res.lastUpdated).toISOString()).toBe(res.lastUpdated); // valid ISO
    expect((prismaMock as any).leaderboardCache.upsert).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// 6. Composition guard (anti-gaming): a position ADDED mid-window — via import,
//    Plaid sync, or a manual add with skipActivity=true — must not bank its
//    pre-ownership run-up on a non-1D window. Detected from the holding's
//    server-set createdAt (which the client cannot suppress).
// --------------------------------------------------------------------------
describe('getLeaderboard composition guard (anti-gaming)', () => {
  it('does not credit a mid-window-added position its pre-ownership run-up (drops it when snapshots are insufficient)', async () => {
    setupPrisma({
      users: [userRow()],
      // Created TODAY but viewed on a 1M window: the current-shares
      // reconstruction would value the position at the 1-month-ago price (50),
      // crediting a +300% run-up the user never actually held.
      holdings: [holdingRow({ ticker: 'GROW', createdAt: new Date(), averageCost: 100, shares: 10 })],
      settings: [{ userId: 'u1', cashBalance: 0, marginDebt: 0 }],
    });
    (prismaMock as any).portfolioSnapshot.findMany = vi.fn().mockResolvedValue([]); // insufficient history
    fetchPricesMock.mockResolvedValue(pricesResult(new Map([['GROW', quote(200, 190)]])));
    const now = Date.now();
    fetchPolygonAggsMock.mockResolvedValue({
      timestamps: [Math.floor((now - 35 * 86400000) / 1000), Math.floor(now / 1000)],
      closes: [50, 200], // window-start price 50 → +300% reconstruction if uncaught
    });

    const res = await getLeaderboard('1M', 'world');

    expect(res.entries).toHaveLength(1);
    const e = res.entries[0];
    expect(e.flagged).toBe(true); // composition-changed
    expect(e.suspicious).toBe(false); // benign, not anti-cheat — stays eligible, just not credited the run-up
    expect(e.returnPct).toBeNull(); // dropped, NOT +300%
  });

  it('does NOT flag an established position (createdAt before the window)', async () => {
    setupPrisma({
      users: [userRow()],
      holdings: [holdingRow({ ticker: 'HELD', createdAt: new Date(Date.now() - 200 * 86400000), averageCost: 100, shares: 10 })],
      settings: [{ userId: 'u1', cashBalance: 0, marginDebt: 0 }],
    });
    fetchPricesMock.mockResolvedValue(pricesResult(new Map([['HELD', quote(120, 118)]])));
    const now = Date.now();
    fetchPolygonAggsMock.mockResolvedValue({
      timestamps: [Math.floor((now - 35 * 86400000) / 1000), Math.floor(now / 1000)],
      closes: [100, 120],
    });

    const res = await getLeaderboard('1M', 'world');

    const e = res.entries[0];
    expect(e.flagged).toBe(false); // established holding — fair reconstruction
    expect(e.returnPct).toBeCloseTo(20, 4); // (120-100)/100
  });
});
