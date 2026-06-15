import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the data-layer deps so the projection MATH is exercised deterministically.
vi.mock('../services/portfolio.service', () => ({
  getPortfolio: vi.fn(),
  getHoldings: vi.fn(),
}));
vi.mock('../services/snapshot.service', () => ({
  getAllSnapshots: vi.fn(),
  getSnapshotsAfter: vi.fn(),
  reconstructPortfolioHistory: vi.fn(),
}));
vi.mock('../services/dividend.service', () => ({
  getTotalDividendsBetween: vi.fn(),
}));

import {
  getSP500Projections,
  getMetrics,
  getRealizedProjections,
  getPaceProjection,
  getCurrentPaceProjection,
} from '../services/projection.service';
import { config } from '../config';
import * as portfolioService from '../services/portfolio.service';
import * as snapshotService from '../services/snapshot.service';
import * as dividendService from '../services/dividend.service';

const mockGetPortfolio = vi.mocked(portfolioService.getPortfolio);
const mockGetHoldings = vi.mocked(portfolioService.getHoldings);
const mockGetAllSnapshots = vi.mocked(snapshotService.getAllSnapshots);
const mockGetSnapshotsAfter = vi.mocked(snapshotService.getSnapshotsAfter);
const mockReconstruct = vi.mocked(snapshotService.reconstructPortfolioHistory);
const mockGetDividends = vi.mocked(dividendService.getTotalDividendsBetween);

// Minimal fixtures (cast — the service only reads the fields set here).
function snapAt(dateStr: string, netEquity: number): any {
  return { timestamp: new Date(dateStr), netEquity, totalValue: netEquity };
}
function portfolio(netEquity: number, extra: Record<string, unknown> = {}): any {
  return { netEquity, cashBalance: 0, marginDebt: 0, dayChange: 0, dayChangePercent: 0, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDividends.mockResolvedValue(0);
  mockGetAllSnapshots.mockResolvedValue([]);
  mockGetSnapshotsAfter.mockResolvedValue([]);
  mockReconstruct.mockResolvedValue([] as any);
  mockGetHoldings.mockResolvedValue([] as any);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('projection.service', () => {
  describe('getSP500Projections', () => {
    it('monthly-compounds to the S&P long-run return at each horizon', async () => {
      mockGetPortfolio.mockResolvedValue(portfolio(10000));
      const r = await getSP500Projections('u1');
      const annual = config.sp500CagrTotalReturn;
      const monthlyRate = Math.pow(1 + annual, 1 / 12) - 1;

      expect(r.mode).toBe('sp500');
      expect(r.currentValue).toBe(10000);
      expect(r.assumptions.annualReturn).toBe(annual);
      expect(r.assumptions.compounding).toBe('monthly');
      // 12 months of monthly compounding == the annual return, exactly by construction
      expect(r.horizons['1y'].base).toBeCloseTo(10000 * (1 + annual), 2);
      expect(r.horizons['10y'].base).toBeCloseTo(
        Math.round(10000 * Math.pow(1 + monthlyRate, 120) * 100) / 100,
        2,
      );
      // Longer horizon must project a larger value than a shorter one
      expect(r.horizons['10y'].base).toBeGreaterThan(r.horizons['5y'].base);
      expect(r.horizons['5y'].base).toBeGreaterThan(r.horizons['1y'].base);
    });
  });

  describe('getMetrics — realized metric math', () => {
    it('returns all-null metrics with a note when fewer than 2 snapshots', async () => {
      mockGetPortfolio.mockResolvedValue(portfolio(10000));
      mockGetAllSnapshots.mockResolvedValue([snapAt('2026-01-01', 10000)]);
      const r = await getMetrics('u1', 'max');
      expect(r.metrics).toEqual({ cagr: null, volatility: null, maxDrawdown: null, sharpe: null });
      expect(r.notes.join(' ')).toContain('at least 2 snapshots');
    });

    it('computes CAGR over the snapshot span, including dividends in total return', async () => {
      mockGetPortfolio.mockResolvedValue(portfolio(12100));
      // 10000 -> 12100 over exactly 1 year, no dividends => total return 1.21 => CAGR 21%
      mockGetAllSnapshots.mockResolvedValue([snapAt('2025-01-01', 10000), snapAt('2026-01-01', 12100)]);
      const r = await getMetrics('u1', 'max');
      expect(r.metrics.cagr).toBeCloseTo(0.21, 3);
    });

    it('folds dividends into the CAGR total return', async () => {
      mockGetPortfolio.mockResolvedValue(portfolio(10000));
      // flat price (10000 -> 10000) but $1000 of dividends over 1y => total return 1.10 => CAGR 10%
      mockGetAllSnapshots.mockResolvedValue([snapAt('2025-01-01', 10000), snapAt('2026-01-01', 10000)]);
      mockGetDividends.mockResolvedValue(1000);
      const r = await getMetrics('u1', 'max');
      expect(r.metrics.cagr).toBeCloseTo(0.10, 3);
    });

    it('caps CAGR at 1000% (10) for extreme growth and records a note', async () => {
      mockGetPortfolio.mockResolvedValue(portfolio(1e9));
      mockGetAllSnapshots.mockResolvedValue([snapAt('2025-12-01', 1), snapAt('2026-01-01', 1e9)]);
      const r = await getMetrics('u1', 'max');
      expect(r.metrics.cagr).toBe(10);
      expect(r.notes.join(' ')).toContain('capped');
    });

    it('floors CAGR at -99% for a near-total loss', async () => {
      mockGetPortfolio.mockResolvedValue(portfolio(1));
      mockGetAllSnapshots.mockResolvedValue([snapAt('2025-01-01', 10000), snapAt('2026-01-01', 1)]);
      const r = await getMetrics('u1', 'max');
      expect(r.metrics.cagr).toBe(-0.99);
    });

    it('computes max drawdown as the largest peak-to-trough decline (negative)', async () => {
      mockGetPortfolio.mockResolvedValue(portfolio(11000));
      // peak 12000, trough 9000 => DD = (12000-9000)/12000 = 0.25
      mockGetAllSnapshots.mockResolvedValue([
        snapAt('2025-01-01', 10000),
        snapAt('2025-06-01', 12000),
        snapAt('2025-09-01', 9000),
        snapAt('2026-01-01', 11000),
      ]);
      const r = await getMetrics('u1', 'max');
      expect(r.metrics.maxDrawdown).toBeCloseTo(-0.25, 4);
    });

    it('produces a finite volatility and Sharpe for a varying series', async () => {
      mockGetPortfolio.mockResolvedValue(portfolio(10800));
      mockGetAllSnapshots.mockResolvedValue([
        snapAt('2025-01-01', 10000),
        snapAt('2025-04-01', 10500),
        snapAt('2025-07-01', 10200),
        snapAt('2025-10-01', 10900),
        snapAt('2026-01-01', 10800),
      ]);
      const r = await getMetrics('u1', 'max');
      expect(r.metrics.volatility).not.toBeNull();
      expect(r.metrics.volatility as number).toBeGreaterThan(0);
      expect(r.metrics.sharpe).not.toBeNull();
      expect(Number.isFinite(r.metrics.sharpe as number)).toBe(true);
    });
  });

  describe('getRealizedProjections', () => {
    it('downgrades the lookback when history is too short and notes the substitution', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
      mockGetPortfolio.mockResolvedValue(portfolio(10000));
      // ~41 days of data: '1y'/'6m' unavailable, '1m' available
      mockGetAllSnapshots.mockResolvedValue([snapAt('2026-05-05', 10000), snapAt('2026-06-14', 11000)]);
      const r = await getRealizedProjections('u1', '1y');
      expect(r.lookback).toBe('1y');
      expect(r.lookbackUsed).toBe('1m');
      expect(r.notes.join(' ')).toContain('used 1m');
    });

    it('caps runaway projections at 1000x current value', async () => {
      mockGetPortfolio.mockResolvedValue(portfolio(10000));
      // forces CAGR to the 10 cap => 10y compound would explode, must clamp to 1000x
      mockGetAllSnapshots.mockResolvedValue([snapAt('2025-12-01', 1), snapAt('2026-01-01', 1e9)]);
      const r = await getRealizedProjections('u1', 'max');
      expect(r.realized.cagr).toBe(10);
      expect(r.horizons['10y'].base).toBe(10000 * 1000);
    });

    it('falls back to SP500 projections for a sub-portfolio (portfolioId) without fetching snapshots', async () => {
      mockGetPortfolio.mockResolvedValue(portfolio(10000));
      const r = await getRealizedProjections('u1', '1y', 'pf_123');
      expect(r.realized.cagr).toBeNull();
      expect(r.notes.join(' ')).toContain('Sub-portfolio');
      expect(r.horizons['1y'].base).toBeCloseTo(10000 * (1 + config.sp500CagrTotalReturn), 2);
      expect(mockGetAllSnapshots).not.toHaveBeenCalled();
    });
  });

  describe('getPaceProjection (MTD linear)', () => {
    it('returns hasData=false when there is no baseline snapshot for the month', async () => {
      mockGetSnapshotsAfter.mockResolvedValue([]);
      const r = await getPaceProjection('u1', 10000);
      expect(r.hasData).toBe(false);
      expect(r.horizonValue['1y']).toBeNull();
    });

    it('linearly annualizes the MTD return and scales horizon values', async () => {
      // baseline 10000, current 10500 => MTD +5% => annual +60% (×12)
      mockGetSnapshotsAfter.mockResolvedValue([
        { timestamp: new Date('2026-06-01'), netEquity: 10000, totalValue: 10000 },
      ] as any);
      const r = await getPaceProjection('u1', 10500);
      expect(r.hasData).toBe(true);
      expect(r.mtdReturnPct).toBeCloseTo(5, 2);
      expect(r.paceAnnualPct).toBeCloseTo(60, 2);
      expect(r.horizonValue['1y']).toBeCloseTo(10500 * 1.6, 2); // +60%
      expect(r.horizonValue['5y']).toBeCloseTo(10500 * 4.0, 2); // +300%
    });
  });

  describe('getCurrentPaceProjection (linear annualization + clamps)', () => {
    it('1D: annualizes the daily move ×252 and clamps to the +50% ceiling', async () => {
      mockGetPortfolio.mockResolvedValue(portfolio(10000, { dayChangePercent: 1, dayChange: 100 }));
      const r = await getCurrentPaceProjection('u1', '1D');
      expect(r.window).toBe('1D');
      expect(r.windowReturnPct).toBeCloseTo(1, 2);
      // 1% × 252 = 252% -> clamped to 50%
      expect(r.annualizedPacePct).toBe(50);
      expect(r.capped).toBe(true);
      expect(r.projections['1y']!.value).toBeCloseTo(10000 * 1.5, 2);
      expect(r.projections['2y']!.value).toBeCloseTo(10000 * 2.25, 2); // 1.5^2
    });

    it('1D: clamps a negative day to the -90% floor', async () => {
      mockGetPortfolio.mockResolvedValue(portfolio(10000, { dayChangePercent: -1, dayChange: -100 }));
      const r = await getCurrentPaceProjection('u1', '1D');
      expect(r.annualizedPacePct).toBe(-90);
      expect(r.capped).toBe(true);
    });

    it('YTD: returns no_data with null projections when reconstruction is empty', async () => {
      mockGetPortfolio.mockResolvedValue(portfolio(10000));
      mockReconstruct.mockResolvedValue([] as any);
      const r = await getCurrentPaceProjection('u1', 'YTD');
      expect(r.dataStatus).toBe('no_data');
      expect(r.projections['1y']).toBeNull();
    });

    it('1M: computes window return from reconstructed history and annualizes ×12', async () => {
      mockGetPortfolio.mockResolvedValue(portfolio(10200));
      // baseline 10000 -> current 10200 => +2% window; ×12 = 24% annualized (within clamp)
      mockReconstruct.mockResolvedValue([
        { time: new Date('2026-05-16').getTime(), value: 10000 },
        { time: new Date('2026-06-14').getTime(), value: 10200 },
      ] as any);
      const r = await getCurrentPaceProjection('u1', '1M');
      expect(r.dataStatus).toBe('ok');
      expect(r.windowReturnPct).toBeCloseTo(2, 2);
      expect(r.annualizedPacePct).toBeCloseTo(24, 2);
      expect(r.capped).toBe(false);
    });
  });
});
