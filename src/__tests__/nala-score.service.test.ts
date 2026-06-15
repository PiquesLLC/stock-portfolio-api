import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  cacheGetMock,
  cacheSetMock,
  cacheDelMock,
  cacheKeysMock,
  getStockMetricsMock,
  getCompanyFundamentalsMock,
  getAnalystSnapshotMock,
  fetchDailyCandlesMock,
  fetchFastQuoteMock,
  fetchStockDetailsMock,
  getAssetAboutMock,
  dividendFindManyMock,
} = vi.hoisted(() => ({
  cacheGetMock: vi.fn(),
  cacheSetMock: vi.fn(),
  cacheDelMock: vi.fn(),
  cacheKeysMock: vi.fn(),
  getStockMetricsMock: vi.fn(),
  getCompanyFundamentalsMock: vi.fn(),
  getAnalystSnapshotMock: vi.fn(),
  fetchDailyCandlesMock: vi.fn(),
  fetchFastQuoteMock: vi.fn(),
  fetchStockDetailsMock: vi.fn(),
  getAssetAboutMock: vi.fn(),
  dividendFindManyMock: vi.fn(),
}));

vi.mock('../utils/finnhub', () => ({
  insightsCache: {
    get: cacheGetMock,
    set: cacheSetMock,
    del: cacheDelMock,
    keys: cacheKeysMock,
  },
  getStockMetrics: getStockMetricsMock,
}));

vi.mock('../services/polygon-fundamentals.service', () => ({
  getCompanyFundamentals: getCompanyFundamentalsMock,
}));

vi.mock('../services/analyst.service', () => ({
  getAnalystSnapshot: getAnalystSnapshotMock,
}));

vi.mock('../services/market.service', () => ({
  fetchDailyCandles: fetchDailyCandlesMock,
  fetchFastQuote: fetchFastQuoteMock,
  fetchStockDetails: fetchStockDetailsMock,
}));

vi.mock('../utils/yahoo-finance', () => ({
  getAssetAbout: getAssetAboutMock,
}));

vi.mock('../utils/prisma', () => ({
  default: {
    dividendEvent: {
      findMany: dividendFindManyMock,
    },
  },
}));

import { getNalaScore, gradeFromScore, invalidateNalaScoreCache } from '../services/nala-score.service';

describe('nala-score.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    cacheGetMock.mockReturnValue(undefined);
    cacheKeysMock.mockReturnValue([]);
    getStockMetricsMock.mockResolvedValue({
      metric: {
        peBasicExclExtraTTM: 40,
        '52WeekHigh': 1200,
        '52WeekLow': 700,
        dividendYieldIndicatedAnnual: null,
        '10DayAverageTradingVolume': 1000000,
        beta: 1.1,
        epsBasicExclExtraItemsTTM: 8,
      },
    });
    getCompanyFundamentalsMock.mockResolvedValue({
      overview: {
        name: 'ServiceNow, Inc.',
        description: '',
        sector: 'Technology',
        industry: 'Software',
        marketCap: 100_000_000_000,
        peRatio: 40,
        pegRatio: 2,
        forwardPE: 35,
        eps: 8,
        profitMargin: 0.18,
        returnOnEquity: 0.2,
        revenueTTM: 10_000_000_000,
        dividendYield: null,
        beta: 1.1,
        analystTargetPrice: 1100,
        fiftyTwoWeekHigh: 1200,
        fiftyTwoWeekLow: 700,
        bookValue: 0,
        sharesOutstanding: 1_000_000,
      },
      balanceSheets: {
        annual: [{
          longTermDebt: 1_000_000,
          currentDebt: 500_000,
          totalShareholderEquity: 10_000_000,
        }],
      },
      cashFlows: {
        annual: [
          { freeCashFlow: 2_000_000 },
          { freeCashFlow: 1_600_000 },
        ],
      },
      incomeStatements: {
        annual: [
          { totalRevenue: 12_000_000, netIncome: 2_000_000 },
          { totalRevenue: 10_000_000, netIncome: 1_600_000 },
          { totalRevenue: 9_000_000, netIncome: 1_400_000 },
        ],
      },
      dataAge: 'fresh',
    });
    getAnalystSnapshotMock.mockResolvedValue({
      strongBuy: 10,
      buy: 12,
      hold: 4,
      sell: 1,
      strongSell: 0,
    });
    fetchDailyCandlesMock.mockResolvedValue([
      { close: 800 },
      { close: 900 },
      { close: 1000 },
    ]);
    fetchFastQuoteMock.mockResolvedValue({
      ticker: 'NOW',
      currentPrice: 1000,
      previousClose: 980,
      change: 20,
      changePercent: 2.04,
      high: 1005,
      low: 970,
      open: 975,
      timestamp: 1,
      updatedAt: 1,
      isStale: false,
      isRepricing: false,
      quoteAgeSeconds: 0,
      session: 'REG',
    });
    fetchStockDetailsMock.mockRejectedValue(new Error('should not be called'));
    getAssetAboutMock.mockResolvedValue(null);
    dividendFindManyMock.mockResolvedValue([]);
  });

  it('computes the score without depending on fetchStockDetails', async () => {
    const result = await getNalaScore('NOW');

    expect(fetchStockDetailsMock).not.toHaveBeenCalled();
    expect(fetchFastQuoteMock).toHaveBeenCalledWith('NOW');
    expect(getStockMetricsMock).toHaveBeenCalledWith('NOW');
    expect(result).toEqual(expect.objectContaining({
      ticker: 'NOW',
      composite: expect.any(Number),
      grade: expect.any(String),
      isETF: false,
    }));
    expect(cacheSetMock).toHaveBeenCalledTimes(1);
  });

  it('degrades gracefully when optional sources (analyst, dividends, candles) are missing', async () => {
    // Core fundamentals + quote remain (from beforeEach); the optional inputs go away.
    getAnalystSnapshotMock.mockResolvedValue(null);
    dividendFindManyMock.mockResolvedValue([]);
    fetchDailyCandlesMock.mockResolvedValue([]);

    const result = await getNalaScore('NOW');

    // Must still return a valid, bounded score rather than throwing / 500ing.
    expect(typeof result.composite).toBe('number');
    expect(result.composite).toBeGreaterThanOrEqual(0);
    expect(result.composite).toBeLessThanOrEqual(100);
    expect(['Strong', 'Good', 'Fair', 'Weak']).toContain(result.grade);
    expect(result.dimensions).toBeTruthy();
  });

  // ── Test 1: Golden-pin composite + weights (characterization / drift guard) ──
  it('pins the exact composite and per-dimension scores for the NOW fixture', async () => {
    const result = await getNalaScore('NOW');

    // Structural assertions — stock path, the 5 stock dimensions with documented weights.
    expect(result.isETF).toBe(false);

    const { value, quality, growth, dividends, momentum } = result.dimensions;
    expect(value).toBeTruthy();
    expect(quality).toBeTruthy();
    expect(growth).toBeTruthy();
    expect(dividends).toBeTruthy();
    expect(momentum).toBeTruthy();

    expect(value.weight).toBe(0.25);
    expect(quality.weight).toBe(0.25);
    expect(growth.weight).toBe(0.20);
    expect(dividends.weight).toBe(0.15);
    expect(momentum.weight).toBe(0.15);

    // Composite is an integer in [0, 100].
    expect(Number.isInteger(result.composite)).toBe(true);
    expect(result.composite).toBeGreaterThanOrEqual(0);
    expect(result.composite).toBeLessThanOrEqual(100);

    // GOLDEN PINS — characterization values captured from the current scorer.
    // composite == round(56*.25 + 87*.25 + 87*.20 + 50*.15 + 90*.15) == round(74.15) == 74.
    // If the scoring math changes, these break on purpose (drift guard).
    expect(result.composite).toBe(74);
    expect(value.score).toBe(56);
    expect(quality.score).toBe(87);
    expect(growth.score).toBe(87);
    expect(dividends.score).toBe(50);
    expect(momentum.score).toBe(90);
  });

  // ── Test 2: Cache hit short-circuits recompute ──
  it('returns the cached score and skips all recomputation on a cache hit', async () => {
    const cachedScore = {
      ticker: 'NOW',
      composite: 42,
      grade: 'Fair',
      dimensions: {},
      keyInsights: [],
      dataAge: 'cached',
      isETF: false,
      availableDimensions: [],
      lastUpdated: '2026-01-01T00:00:00.000Z',
    };
    cacheGetMock.mockImplementation((key: string) =>
      key === 'nala-score:NOW' ? cachedScore : undefined,
    );

    const result = await getNalaScore('NOW');

    // Returns the exact cached object.
    expect(result).toBe(cachedScore);
    expect(result.composite).toBe(42);

    // No recomputation happened.
    expect(getCompanyFundamentalsMock).not.toHaveBeenCalled();
    expect(fetchFastQuoteMock).not.toHaveBeenCalled();
    expect(cacheSetMock).not.toHaveBeenCalled();
  });

  // ── Test 3: invalidateNalaScoreCache (both modes) ──
  it('invalidates a single ticker cache key (upper-cased)', () => {
    invalidateNalaScoreCache('now');

    expect(cacheDelMock).toHaveBeenCalledWith('nala-score:NOW');
    expect(cacheDelMock).toHaveBeenCalledTimes(1);
  });

  it('invalidates only nala-score:* keys when called with no argument', () => {
    cacheKeysMock.mockReturnValue(['nala-score:AAPL', 'quote:MSFT', 'nala-score:TSLA']);

    invalidateNalaScoreCache();

    expect(cacheDelMock).toHaveBeenCalledWith('nala-score:AAPL');
    expect(cacheDelMock).toHaveBeenCalledWith('nala-score:TSLA');
    expect(cacheDelMock).not.toHaveBeenCalledWith('quote:MSFT');
    expect(cacheDelMock).toHaveBeenCalledTimes(2);
  });

  // ── Test 4: Empty / brand-new fundamentals stays finite & bounded ──
  it('produces a finite, bounded score when all data sources are empty/null', async () => {
    getCompanyFundamentalsMock.mockResolvedValue({
      overview: null,
      incomeStatements: { annual: [], quarterly: [] },
      balanceSheets: { annual: [], quarterly: [] },
      cashFlows: { annual: [], quarterly: [] },
      dataAge: 'fresh',
    });
    getStockMetricsMock.mockResolvedValue(null);
    fetchFastQuoteMock.mockResolvedValue(null); // currentPrice -> 0
    fetchDailyCandlesMock.mockResolvedValue([]);
    dividendFindManyMock.mockResolvedValue([]);
    getAnalystSnapshotMock.mockResolvedValue(null);

    const result = await getNalaScore('NEW');

    expect(Number.isFinite(result.composite)).toBe(true);
    expect(Number.isNaN(result.composite)).toBe(false);
    expect(result.composite).toBeGreaterThanOrEqual(0);
    expect(result.composite).toBeLessThanOrEqual(100);
    expect(['Strong', 'Good', 'Fair', 'Weak']).toContain(result.grade);

    for (const dim of Object.values(result.dimensions)) {
      expect(Number.isFinite(dim.score)).toBe(true);
      expect(Number.isInteger(dim.score)).toBe(true);
    }
  });

  // ── Test 5: Monotonicity — better fundamentals -> higher composite ──
  it('scores strong fundamentals strictly higher than weak fundamentals', async () => {
    cacheGetMock.mockReturnValue(undefined);

    // ---- Run A: weak fundamentals ----
    getCompanyFundamentalsMock.mockResolvedValue({
      overview: {
        name: 'Weak Co.',
        description: '',
        sector: 'Technology',
        industry: 'Software',
        marketCap: 10_000_000_000,
        peRatio: 60,
        pegRatio: 4,
        forwardPE: 65,
        eps: 1,
        profitMargin: -0.02,
        returnOnEquity: -0.05,
        revenueTTM: 1_000_000_000,
        dividendYield: null,
        beta: 2.2,
        analystTargetPrice: 50,
        fiftyTwoWeekHigh: 200,
        fiftyTwoWeekLow: 50,
        bookValue: 0,
        sharesOutstanding: 1_000_000,
      },
      balanceSheets: {
        annual: [{ longTermDebt: 5_000_000, currentDebt: 3_000_000, totalShareholderEquity: 2_000_000 }],
      },
      cashFlows: {
        annual: [{ freeCashFlow: 800_000 }, { freeCashFlow: 1_200_000 }],
      },
      incomeStatements: {
        annual: [
          { totalRevenue: 8_000_000, netIncome: -200_000 },
          { totalRevenue: 10_000_000, netIncome: 400_000 },
          { totalRevenue: 12_000_000, netIncome: 600_000 },
        ],
      },
      dataAge: 'fresh',
    });
    getStockMetricsMock.mockResolvedValue(null);
    getAnalystSnapshotMock.mockResolvedValue({ strongBuy: 0, buy: 1, hold: 3, sell: 6, strongSell: 4 });
    fetchDailyCandlesMock.mockResolvedValue([{ close: 200 }, { close: 120 }, { close: 60 }]);
    fetchFastQuoteMock.mockResolvedValue({
      ticker: 'WEAK', currentPrice: 60, previousClose: 65, change: -5, changePercent: -7.7,
      high: 66, low: 58, open: 64, timestamp: 1, updatedAt: 1,
      isStale: false, isRepricing: false, quoteAgeSeconds: 0, session: 'REG',
    });
    dividendFindManyMock.mockResolvedValue([]);

    const weak = await getNalaScore('WEAK');

    // ---- Run B: strong fundamentals (distinct ticker so cache.get->undefined recomputes) ----
    getCompanyFundamentalsMock.mockResolvedValue({
      overview: {
        name: 'Strong Co.',
        description: '',
        sector: 'Technology',
        industry: 'Software',
        marketCap: 500_000_000_000,
        peRatio: 12,
        pegRatio: 0.8,
        forwardPE: 10,
        eps: 10,
        profitMargin: 0.25,
        returnOnEquity: 0.30,
        revenueTTM: 50_000_000_000,
        dividendYield: null,
        beta: 1.0,
        analystTargetPrice: 150,
        fiftyTwoWeekHigh: 110,
        fiftyTwoWeekLow: 60,
        bookValue: 0,
        sharesOutstanding: 1_000_000,
      },
      balanceSheets: {
        annual: [{ longTermDebt: 500_000, currentDebt: 100_000, totalShareholderEquity: 10_000_000 }],
      },
      cashFlows: {
        annual: [{ freeCashFlow: 3_000_000 }, { freeCashFlow: 2_000_000 }],
      },
      incomeStatements: {
        annual: [
          { totalRevenue: 15_625_000, netIncome: 3_125_000 },
          { totalRevenue: 12_500_000, netIncome: 2_500_000 },
          { totalRevenue: 10_000_000, netIncome: 2_000_000 },
        ],
      },
      dataAge: 'fresh',
    });
    getStockMetricsMock.mockResolvedValue(null);
    getAnalystSnapshotMock.mockResolvedValue({ strongBuy: 18, buy: 6, hold: 1, sell: 0, strongSell: 0 });
    fetchDailyCandlesMock.mockResolvedValue([{ close: 60 }, { close: 85 }, { close: 100 }]);
    fetchFastQuoteMock.mockResolvedValue({
      ticker: 'STRONG', currentPrice: 100, previousClose: 98, change: 2, changePercent: 2.04,
      high: 101, low: 97, open: 99, timestamp: 1, updatedAt: 1,
      isStale: false, isRepricing: false, quoteAgeSeconds: 0, session: 'REG',
    });
    dividendFindManyMock.mockResolvedValue([]);

    const strong = await getNalaScore('STRONG');

    expect(strong.composite).toBeGreaterThan(weak.composite);
  });
});

describe('gradeFromScore boundaries', () => {
  it('maps composite to the documented grade thresholds (>=75 Strong, >=50 Good, >=25 Fair, else Weak)', () => {
    expect(gradeFromScore(100)).toBe('Strong');
    expect(gradeFromScore(75)).toBe('Strong');
    expect(gradeFromScore(74.9)).toBe('Good');
    expect(gradeFromScore(50)).toBe('Good');
    expect(gradeFromScore(49.9)).toBe('Fair');
    expect(gradeFromScore(25)).toBe('Fair');
    expect(gradeFromScore(24.9)).toBe('Weak');
    expect(gradeFromScore(0)).toBe('Weak');
  });
});
