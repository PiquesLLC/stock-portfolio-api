import { describe, it, expect } from 'vitest';
import {
  calculateTWR,
  calculateXIRR,
  calculateCorrelation,
  calculateBeta,
  annualizeReturn,
  annualizedVolatility,
  sharpeRatio,
  maxDrawdown,
  dailyReturnsFromValues,
  bestWorstDays,
  isSuspiciousReturn,
  isSuspiciousSharpe,
  RISK_FREE_RATE,
  TRADING_DAYS,
} from '../utils/finance-math';

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN / CHARACTERIZATION TESTS for the canonical finance library.
//
// Purpose: FREEZE the exact current behavior of finance-math.ts — including the
// deliberate choices an independent audit flagged as inconsistently re-implemented
// elsewhere (SAMPLE stddev ÷(n-1), √252 annualization, 365-calendar-day return
// annualization, the <20 correlation / <10 beta+vol data gates, the positive
// drawdown convention with a peak>0 guard, RISK_FREE_RATE=0).
//
// These are the SINGLE SOURCE OF TRUTH. Any future consolidation that routes a
// divergent re-implementation (population stddev, unguarded drawdown, different
// gates, etc.) through this library must either leave these green (behavior-
// preserving) or change a test on purpose (a conscious, reviewed number change).
// ─────────────────────────────────────────────────────────────────────────────

describe('finance-math golden — shared constants', () => {
  it('pins the shared risk constants', () => {
    expect(RISK_FREE_RATE).toBe(0);
    expect(TRADING_DAYS).toBe(252);
  });
});

describe('finance-math golden — calculateTWR', () => {
  const d = (s: string) => new Date(s);
  it('is the simple return when there are no cashflows', () => {
    const twr = calculateTWR([
      { date: d('2026-01-01'), value: 100 },
      { date: d('2026-02-01'), value: 110 },
    ]);
    expect(twr).toBeCloseTo(0.1, 10);
  });
  it('returns null for < 2 snapshots', () => {
    expect(calculateTWR([{ date: d('2026-01-01'), value: 100 }])).toBeNull();
  });
  it('returns null when the first value is <= 0', () => {
    expect(calculateTWR([
      { date: d('2026-01-01'), value: 0 },
      { date: d('2026-02-01'), value: 100 },
    ])).toBeNull();
  });
});

describe('finance-math golden — calculateXIRR', () => {
  it('solves a clean 10% one-year IRR (365.25-day year, negative = invested)', () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date(t0.getTime() + 365.25 * 24 * 3600 * 1000);
    const r = calculateXIRR([
      { date: t0, amount: -1000 },
      { date: t1, amount: 1100 },
    ]);
    expect(r).not.toBeNull();
    expect(r as number).toBeCloseTo(0.1, 3);
  });
  it('returns null for < 2 cashflows', () => {
    expect(calculateXIRR([{ date: new Date('2026-01-01'), amount: -1000 }])).toBeNull();
  });
});

describe('finance-math golden — calculateCorrelation', () => {
  const seq = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
  it('is +1 for perfectly correlated series (>= 20 points)', () => {
    const a = seq(20, (i) => i * 0.01 - 0.05);
    expect(calculateCorrelation(a, a) as number).toBeCloseTo(1, 10);
  });
  it('is -1 for perfectly anti-correlated series', () => {
    const a = seq(20, (i) => i * 0.01 - 0.05);
    const b = a.map((x) => -x);
    expect(calculateCorrelation(a, b) as number).toBeCloseTo(-1, 10);
  });
  it('returns null below the 20-point gate', () => {
    const a = seq(19, (i) => i * 0.01);
    expect(calculateCorrelation(a, a)).toBeNull();
  });
  it('returns null for a zero-variance series (exact-constant → denom 0)', () => {
    // Use an exactly-representable constant (0.5) so the mean is exact and every
    // deviation is exactly 0 → denom === 0 guard fires. (An FP-inexact constant
    // like 0.01 leaves sub-ulp noise that slips past the ===0 guard — a known
    // minor fragility, flagged separately, not locked here.)
    const a = seq(20, () => 0.5);
    expect(calculateCorrelation(a, a)).toBeNull();
  });
});

describe('finance-math golden — calculateBeta', () => {
  const bench = [0.01, -0.02, 0.03, -0.01, 0.02, -0.03, 0.015, -0.005, 0.025, -0.02, 0.01, 0.005];
  it('is 1.0 when portfolio == benchmark', () => {
    expect(calculateBeta(bench, bench) as number).toBeCloseTo(1, 10);
  });
  it('is 2.0 when portfolio moves 2x the benchmark', () => {
    expect(calculateBeta(bench.map((x) => x * 2), bench) as number).toBeCloseTo(2, 10);
  });
  it('returns null below the 10-point gate', () => {
    expect(calculateBeta(bench.slice(0, 9), bench.slice(0, 9))).toBeNull();
  });
  it('returns null when the benchmark has zero variance (exact constant)', () => {
    // Exactly-representable constant so varianceB === 0 fires (see correlation note).
    const flat = new Array(12).fill(0.5);
    expect(calculateBeta(bench, flat)).toBeNull();
  });
});

describe('finance-math golden — annualizeReturn (365 calendar-day basis)', () => {
  it('is identity over exactly 365 days', () => {
    expect(annualizeReturn(0.1, 365)).toBeCloseTo(0.1, 10);
  });
  it('compounds a half-year return correctly', () => {
    // (1.21)^(365/730) - 1 = 1.1 - 1 = 0.1
    expect(annualizeReturn(0.21, 730)).toBeCloseTo(0.1, 10);
  });
  it('returns 0 for non-positive days', () => {
    expect(annualizeReturn(0.5, 0)).toBe(0);
    expect(annualizeReturn(0.5, -10)).toBe(0);
  });
});

describe('finance-math golden — annualizedVolatility (SAMPLE stddev x sqrt(252))', () => {
  it('matches the sample-variance formula exactly (locks ÷(n-1), not ÷n)', () => {
    const r = [0.02, -0.02, 0.02, -0.02, 0.02, -0.02, 0.02, -0.02, 0.02, -0.02];
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const sampleVar = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
    const expected = Math.sqrt(sampleVar) * Math.sqrt(252);
    expect(annualizedVolatility(r) as number).toBeCloseTo(expected, 12);
  });
  it('returns null below the 10-point gate', () => {
    expect(annualizedVolatility([0.01, -0.01, 0.02, -0.02, 0.01, -0.01, 0.02, -0.02, 0.01])).toBeNull();
  });
});

describe('finance-math golden — sharpeRatio', () => {
  it('is (return - 0) / vol with RISK_FREE_RATE = 0', () => {
    expect(sharpeRatio(0.2, 0.1) as number).toBeCloseTo(2, 10);
  });
  it('is null when either input is null or vol <= 0', () => {
    expect(sharpeRatio(null, 0.1)).toBeNull();
    expect(sharpeRatio(0.2, null)).toBeNull();
    expect(sharpeRatio(0.2, 0)).toBeNull();
    expect(sharpeRatio(0.2, -0.1)).toBeNull();
  });
});

describe('finance-math golden — maxDrawdown (positive fraction, peak>0 guard)', () => {
  it('finds the largest peak-to-trough drop as a positive fraction', () => {
    // 100 ->120(peak)->90 ->130(peak)->80  => (130-80)/130 = 0.384615...
    expect(maxDrawdown([100, 120, 90, 130, 80])).toBeCloseTo(0.384615, 5);
  });
  it('returns 0 for a non-positive starting peak (guard)', () => {
    expect(maxDrawdown([0, -5, 10])).toBe(0);
    expect(maxDrawdown([-5, -1, -10])).toBe(0);
  });
  it('returns 0 for fewer than 2 points', () => {
    expect(maxDrawdown([100])).toBe(0);
    expect(maxDrawdown([])).toBe(0);
  });
});

describe('finance-math golden — dailyReturnsFromValues (v[i-1] > 0 guard)', () => {
  it('skips returns where the prior value is not strictly positive', () => {
    expect(dailyReturnsFromValues([100, 110, 0, 50])).toEqual([0.1, -1]);
  });
});

describe('finance-math golden — bestWorstDays', () => {
  const d = (s: string) => new Date(s);
  it('reports the best and worst daily percentage moves', () => {
    const { bestDay, worstDay } = bestWorstDays([
      { date: d('2026-01-01'), value: 100 },
      { date: d('2026-01-02'), value: 110 },  // +10%
      { date: d('2026-01-03'), value: 99 },   // -10%
    ]);
    expect(bestDay?.returnPct).toBeCloseTo(10, 6);
    expect(worstDay?.returnPct).toBeCloseTo(-10, 6);
  });
});

describe('finance-math golden — anti-cheat heuristics', () => {
  it('isSuspiciousReturn flags impossible single-day moves', () => {
    expect(isSuspiciousReturn(400, 1)).toBe(true);
    expect(isSuspiciousReturn(100, 1)).toBe(false);
    expect(isSuspiciousReturn(600, 30)).toBe(true);
  });
  it('isSuspiciousSharpe flags sharpe > 5', () => {
    expect(isSuspiciousSharpe(10, 1)).toBe(true);
    expect(isSuspiciousSharpe(2, 1)).toBe(false);
    expect(isSuspiciousSharpe(10, 0)).toBe(false); // vol <= 0 -> not suspicious
  });
});
