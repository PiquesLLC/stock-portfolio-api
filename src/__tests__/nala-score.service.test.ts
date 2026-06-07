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

import { getNalaScore, gradeFromScore } from '../services/nala-score.service';

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
