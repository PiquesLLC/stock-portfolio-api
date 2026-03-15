import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { getUserActivity } from '../services/activity.service';
import { getEarningsData } from '../services/earnings.service';
import { getCompanyFundamentals } from '../services/fundamentals.service';

vi.mock('../services/follow.service', () => ({
  getFollowingIds: vi.fn().mockResolvedValue([]),
}));

vi.mock('../config', () => ({
  config: {
    finnhubApiKey: '',
  },
}));

vi.mock('../utils/alpha-vantage', () => ({
  fetchEarnings: vi.fn().mockResolvedValue(null),
  parseAVNumber: vi.fn((value: unknown) => {
    if (value == null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }),
  getDailyCallsRemaining: vi.fn().mockResolvedValue(0),
  fetchCompanyOverview: vi.fn(),
  fetchIncomeStatement: vi.fn(),
  fetchBalanceSheet: vi.fn(),
  fetchCashFlow: vi.fn(),
}));

describe('crash path guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prismaMock as any).activityEvent = {
      findMany: vi.fn(),
    };
    (prismaMock as any).user = {
      findUnique: vi.fn(),
    };
    (prismaMock as any).fundamentalsCache = {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    (prismaMock as any).creator = {
      findMany: vi.fn().mockResolvedValue([]),
    };
  });

  it('skips malformed activity payloads instead of throwing', async () => {
    (prismaMock as any).user.findUnique.mockResolvedValue({
      username: 'jon',
      displayName: 'Jon',
      profilePublic: true,
    });
    (prismaMock as any).activityEvent.findMany.mockResolvedValue([
      {
        id: 'bad',
        userId: 'u1',
        type: 'holding_added',
        payload: '{bad json',
        createdAt: new Date('2026-03-14T10:00:00.000Z'),
      },
      {
        id: 'good',
        userId: 'u1',
        type: 'holding_updated',
        payload: JSON.stringify({ ticker: 'AAPL', shares: 2 }),
        createdAt: new Date('2026-03-14T11:00:00.000Z'),
      },
    ]);

    const result = await getUserActivity('u1', 20);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'good',
      payload: { ticker: 'AAPL', shares: 2 },
    });
  });

  it('falls back cleanly when cached earnings JSON is malformed', async () => {
    (prismaMock as any).fundamentalsCache.findUnique.mockResolvedValue({
      ticker: 'AAPL',
      earningsJson: '{bad json',
      lastFetchedAt: new Date('2026-03-14T10:00:00.000Z'),
    });

    const result = await getEarningsData('AAPL');

    expect(result).toEqual({
      ticker: 'AAPL',
      quarterly: [],
      annual: [],
      lastUpdated: '',
      dataAge: 'stale',
    });
  });

  it('returns empty sections instead of throwing on malformed cached fundamentals JSON', async () => {
    (prismaMock as any).fundamentalsCache.findUnique.mockResolvedValue({
      ticker: 'AAPL',
      overviewJson: '{bad json',
      incomeJson: '{bad json',
      balanceJson: '{bad json',
      cashFlowJson: '{bad json',
      lastFetchedAt: new Date('2026-03-14T10:00:00.000Z'),
    });

    const result = await getCompanyFundamentals('AAPL');

    expect(result).toMatchObject({
      ticker: 'AAPL',
      overview: null,
      incomeStatements: { annual: [], quarterly: [] },
      balanceSheets: { annual: [], quarterly: [] },
      cashFlows: { annual: [], quarterly: [] },
    });
  });
});
