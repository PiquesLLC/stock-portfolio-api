import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// getPerformanceComparison's risk metrics (beta/correlation/volatility/
// maxDrawdown/bestDay/worstDay) feed the public profile's signal grade, risk
// posture, and badges. Lock in the two fixes:
// (1) FLOW ADJUSTMENT — on the snapshot-sourced series, deposits/withdrawals
//     must not read as market moves (a deposit is not a "best day").
// (2) DATE-PAIRED beta/correlation — portfolio and benchmark returns are
//     paired per-date; a MID-series benchmark gap must not shift the pairing
//     (the old code trimmed the portfolio array from the front).

const { fetchPriceMock, benchmarkCandlesMock, benchmarkReturnsMock } = vi.hoisted(() => ({
  fetchPriceMock: vi.fn(),
  benchmarkCandlesMock: vi.fn(),
  benchmarkReturnsMock: vi.fn(),
}));

vi.mock('../services/market.service', async (importOriginal) => ({
  ...(await importOriginal() as object),
  fetchPrice: fetchPriceMock,
}));

vi.mock('../utils/candle-cache', async (importOriginal) => ({
  ...(await importOriginal() as object),
  getBenchmarkCandles: benchmarkCandlesMock,
  getBenchmarkReturns: benchmarkReturnsMock,
  getBenchmarkReturnWithQuote: vi.fn().mockReturnValue(0.01),
  getBenchmarkTotalReturn: vi.fn().mockReturnValue(0.01),
  getBenchmarkTotalReturnFromDate: vi.fn().mockReturnValue(0.01),
}));

import { getPerformanceComparison } from '../services/benchmark.service';

/** End-of-day timestamp `offset` days before today (UTC). */
function day(offset: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  d.setUTCHours(20, 0, 0, 0);
  return d;
}
const dateKey = (d: Date) => d.toISOString().slice(0, 10);

function snapRow(timestamp: Date, value: number) {
  return {
    id: `snap_${timestamp.getTime()}`,
    userId: 'u1',
    timestamp,
    totalValue: value,
    netEquity: value,
    cashBalance: 0,
  };
}

function mockPrismaFor(snaps: ReturnType<typeof snapRow>[], txns: { type: string; amount: number; date: Date }[]) {
  const p = prismaMock as any;
  p.portfolioSnapshot = {
    findMany: vi.fn().mockResolvedValue(snaps),
    findFirst: vi.fn().mockResolvedValue(null), // no pre-window baseline
  };
  p.holding = { findMany: vi.fn().mockResolvedValue([]) }; // no candle reconstruction
  p.activityEvent = { count: vi.fn().mockResolvedValue(0) };
  p.transaction = { findMany: vi.fn().mockResolvedValue(txns) };
  p.userSettings = { findUnique: vi.fn().mockResolvedValue(null) };
}

describe('getPerformanceComparison — flow-adjusted, date-paired risk metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchPriceMock.mockResolvedValue({ currentPrice: 500, changePercent: 0.5 });
    benchmarkCandlesMock.mockReturnValue(null);
    benchmarkReturnsMock.mockReturnValue(null);
  });

  it('a deposit on a flat market yields zero volatility/drawdown and no fake best day', async () => {
    // 16 daily snapshots: $1000 flat, then a $500 deposit steps the account to
    // $1500 (market never moves). The raw series has a +50% "day".
    const snaps: ReturnType<typeof snapRow>[] = [];
    for (let i = 15; i >= 0; i--) {
      snaps.push(snapRow(day(i), i <= 7 ? 1500 : 1000));
    }
    const depositDate = new Date(day(7)); // same calendar day as the step-up
    depositDate.setUTCHours(15, 0, 0, 0);
    mockPrismaFor(snaps, [{ type: 'deposit', amount: 500, date: depositDate }]);

    const perf = await getPerformanceComparison('1M', 'SPY', 'u1');

    expect(perf.volatilityPct).toBe(0);
    expect(perf.maxDrawdownPct).toBe(0);
    expect(perf.bestDay?.returnPct).toBe(0);
    expect(perf.worstDay?.returnPct).toBe(0);
  });

  it('beta/correlation stay exactly 1 vs an identical benchmark despite a MID-series candle gap', async () => {
    // Portfolio tracks the benchmark tick-for-tick (value = close × 10), but the
    // benchmark is missing ONE mid-series date. Date-pairing must skip only the
    // two returns touching the gap; front-trimming (the old bug) would misalign
    // every earlier pair and drag beta/correlation off 1.
    // 25 days inside the 1M window -> 24 returns; the gap kills 2 pairs -> 22
    // pairs, clearing both thresholds (beta >=10, correlation >=20).
    const closes = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 5 + i * 0.3);
    const n = closes.length;
    const snaps: ReturnType<typeof snapRow>[] = [];
    const bmDates: string[] = [];
    const bmCloses: number[] = [];
    for (let i = 0; i < n; i++) {
      const ts = day(n - 1 - i);
      snaps.push(snapRow(ts, closes[i] * 10));
      if (i !== 6) { // benchmark candle missing at index 6
        bmDates.push(dateKey(ts));
        bmCloses.push(closes[i]);
      }
    }
    mockPrismaFor(snaps, []);
    benchmarkCandlesMock.mockReturnValue({ dates: bmDates, closes: bmCloses });

    const perf = await getPerformanceComparison('1M', 'SPY', 'u1');

    // 24 portfolio returns; 22 date-paired — identical series
    expect(perf.beta).toBe(1);
    expect(perf.correlation).toBe(1);
  });
});
