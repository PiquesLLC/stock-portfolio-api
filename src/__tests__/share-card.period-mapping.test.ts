import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

const { reconstructPortfolioHistoryHiResMock, getPortfolioChartDataMock } = vi.hoisted(() => ({
  reconstructPortfolioHistoryHiResMock: vi.fn(),
  getPortfolioChartDataMock: vi.fn(),
}));

vi.mock('../services/snapshot.service', () => ({
  reconstructPortfolioHistoryHiRes: reconstructPortfolioHistoryHiResMock,
  getPortfolioChartData: getPortfolioChartDataMock,
}));

vi.mock('sharp', () => {
  const chain = {
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('png')),
  };
  const sharpMock = vi.fn(() => chain);
  return { default: sharpMock };
});

import { generatePerformanceCard } from '../services/share-card.service';

describe('performance share card period mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    if (!(prismaMock.portfolioSnapshot as any).findFirst) {
      (prismaMock.portfolioSnapshot as any).findFirst = vi.fn();
    }

    prismaMock.user.findUnique.mockResolvedValue({
      username: 'nala_user',
      displayName: 'Nala User',
      profilePublic: true,
    } as any);

    prismaMock.creator.findUnique.mockResolvedValue({
      status: 'inactive',
      visibility: { tradeDelayHours: 0 },
    } as any);

    prismaMock.holding.findMany.mockResolvedValue([
      { ticker: 'AAPL', shares: 10 },
    ] as any);

    (prismaMock.portfolioSnapshot as any).findFirst.mockResolvedValue({
      cashBalance: 500,
      timestamp: new Date('2026-03-01T16:00:00.000Z'),
    } as any);

    prismaMock.userSettings.findUnique.mockResolvedValue({
      marginDebt: 100,
    } as any);

    reconstructPortfolioHistoryHiResMock.mockResolvedValue([
      { time: new Date('2025-01-01T16:00:00.000Z').getTime(), value: 10000 },
      { time: new Date('2026-03-01T16:00:00.000Z').getTime(), value: 11000 },
    ]);

    getPortfolioChartDataMock.mockResolvedValue({
      points: [
        { time: new Date('2025-01-01T16:00:00.000Z').getTime(), value: 10000 },
        { time: new Date('2026-03-01T16:00:00.000Z').getTime(), value: 11000 },
      ],
      periodStartValue: 10000,
    });
  });

  it.each([
    { period: 'YTD', expectedRange: 'ytd', expectedInterval: '1d' },
    { period: '1Y', expectedRange: '1y', expectedInterval: '1d' },
    { period: 'ALL', expectedRange: '5y', expectedInterval: '1d' },
  ])('maps $period and generates a card', async ({ period }) => {
    const card = await generatePerformanceCard('user-1', period);
    expect(card).toBeTruthy();

    // Service now uses getPortfolioChartData instead of reconstructPortfolioHistoryHiRes
    expect(getPortfolioChartDataMock).toHaveBeenCalledTimes(1);
    expect(getPortfolioChartDataMock).toHaveBeenCalledWith('user-1', period);
  });
});
