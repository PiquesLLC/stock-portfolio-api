import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { getFeed, getUserActivity } from '../services/activity.service';
import { getLockedContent } from '../services/creator.service';

vi.mock('../services/follow.service', () => ({
  getFollowingIds: vi.fn().mockResolvedValue(['creator_user_1']),
}));

function ensureMockShape(): void {
  const p = prismaMock as any;
  p.creator ??= {};
  p.creator.findUnique ??= vi.fn();
  p.creator.findMany ??= vi.fn();
  p.creatorSubscription ??= {};
  p.creatorSubscription.findFirst ??= vi.fn();
  p.creatorSubscription.count ??= vi.fn();
  p.follow ??= {};
  p.follow.findUnique ??= vi.fn();
  p.holding ??= {};
  p.holding.findMany ??= vi.fn();
  p.watchlist ??= {};
  p.watchlist.findMany ??= vi.fn();
  p.portfolioTrade ??= {};
  p.portfolioTrade.findMany ??= vi.fn();
  p.activityEvent ??= {};
  p.activityEvent.findMany ??= vi.fn();
  p.user ??= {};
  p.user.findUnique ??= vi.fn();
  p.$transaction ??= vi.fn((arg: unknown) => {
    if (typeof arg === 'function') return arg(p);
    if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
    return Promise.resolve(arg);
  });
}

describe('trade delay filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureMockShape();
    // Reset all mocks to defaults
    (prismaMock as any).creator.findUnique.mockResolvedValue(null);
    (prismaMock as any).creator.findMany.mockResolvedValue([]);
    (prismaMock as any).creatorSubscription.findFirst.mockResolvedValue(null);
    (prismaMock as any).creatorSubscription.count.mockResolvedValue(0);
    (prismaMock as any).follow.findUnique.mockResolvedValue(null);
    (prismaMock as any).holding.findMany.mockResolvedValue([]);
    (prismaMock as any).portfolioTrade.findMany.mockResolvedValue([]);
    (prismaMock as any).activityEvent.findMany.mockResolvedValue([]);
    (prismaMock as any).user.findUnique.mockResolvedValue(null);
  });

  describe('getFeed – hides events within the delay window', () => {
    it('filters out activity events newer than the creator trade delay', async () => {
      const now = Date.now();
      const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);

      // Creator with 24h delay
      (prismaMock as any).creator.findMany.mockResolvedValue([
        {
          userId: 'creator_user_1',
          visibility: { tradeDelayHours: 24 },
        },
      ]);

      // Activity events: one within the delay window (2h ago), one outside (2d ago)
      (prismaMock as any).activityEvent.findMany.mockResolvedValue([
        {
          id: 'evt_recent',
          userId: 'creator_user_1',
          type: 'holding_added',
          payload: JSON.stringify({ ticker: 'BP', shares: 10, averageCost: 30 }),
          createdAt: twoHoursAgo,
          user: { id: 'creator_user_1', username: 'mario', displayName: 'Mario', profilePublic: true },
        },
        {
          id: 'evt_old',
          userId: 'creator_user_1',
          type: 'holding_added',
          payload: JSON.stringify({ ticker: 'AAPL', shares: 5, averageCost: 185 }),
          createdAt: twoDaysAgo,
          user: { id: 'creator_user_1', username: 'mario', displayName: 'Mario', profilePublic: true },
        },
      ]);

      const feed = await getFeed('follower_user_1', 50);

      // Only the old event (2 days ago) should pass the 24h delay filter
      expect(feed).toHaveLength(1);
      expect(feed[0].id).toBe('evt_old');
      expect(feed[0].payload.ticker).toBe('AAPL');
    });

    it('enforces 24hr minimum delay for non-creator users too', async () => {
      const now = Date.now();
      const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);

      // No creators found among followed users
      (prismaMock as any).creator.findMany.mockResolvedValue([]);

      (prismaMock as any).activityEvent.findMany.mockResolvedValue([
        {
          id: 'evt_recent',
          userId: 'creator_user_1',
          type: 'holding_added',
          payload: JSON.stringify({ ticker: 'BP', shares: 10, averageCost: 30 }),
          createdAt: twoHoursAgo,
          user: { id: 'creator_user_1', username: 'regularuser', displayName: 'Regular', profilePublic: true },
        },
        {
          id: 'evt_old',
          userId: 'creator_user_1',
          type: 'holding_added',
          payload: JSON.stringify({ ticker: 'KO', shares: 50, averageCost: 25 }),
          createdAt: twoDaysAgo,
          user: { id: 'creator_user_1', username: 'regularuser', displayName: 'Regular', profilePublic: true },
        },
      ]);

      const feed = await getFeed('follower_user_1', 50);

      // Platform-wide 24hr minimum: 2hr-old event filtered, 2-day-old event passes
      expect(feed).toHaveLength(1);
      expect(feed[0].id).toBe('evt_old');
    });
  });

  describe('getLockedContent – holdings respect trade delay', () => {
    it('filters out holdings added within the trade delay window', async () => {
      const now = Date.now();
      const oneHourAgo = new Date(now - 1 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);

      // Creator with active status and 24h delay, paid viewer
      (prismaMock as any).creator.findUnique.mockResolvedValue({
        id: 'creator_1',
        userId: 'creator_user_1',
        status: 'active',
        pricingCents: 500,
        visibility: {
          showHoldings: true,
          showTradeHistory: false,
          showRationale: false,
          showSectors: true,
          showRiskMetrics: false,
          showWatchlists: false,
          tradeDelayHours: 24,
          hideShareCount: false,
        },
      });
      // Viewer is a paid subscriber
      (prismaMock as any).creatorSubscription.findFirst.mockResolvedValue({ id: 'sub_1' });
      (prismaMock as any).creatorSubscription.count.mockResolvedValue(1);

      // Holdings: AAPL (old) and BP (just added 1h ago)
      (prismaMock as any).holding.findMany.mockResolvedValue([
        { ticker: 'AAPL', shares: 10, averageCost: 185, createdAt: twoDaysAgo },
        { ticker: 'BP', shares: 20, averageCost: 30, createdAt: oneHourAgo },
      ]);

      // Activity events showing BP was added within the delay window
      (prismaMock as any).activityEvent.findMany.mockResolvedValue([
        {
          id: 'evt_bp',
          userId: 'creator_user_1',
          type: 'holding_added',
          payload: JSON.stringify({ ticker: 'BP', shares: 20, averageCost: 30 }),
          createdAt: oneHourAgo,
        },
      ]);

      const result = await getLockedContent('creator_user_1', 'paid_viewer_1', 'holdings') as any[];

      // BP was added within the 24h delay window — it should be hidden
      expect(result).toHaveLength(1);
      expect(result[0].ticker).toBe('AAPL');
    });
  });

  describe('getLockedContent – tradeHistory uses trade delay cutoff', () => {
    it('only returns trades older than the delay cutoff', async () => {
      const now = Date.now();
      const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);

      // Creator with 24h delay, paid viewer
      (prismaMock as any).creator.findUnique.mockResolvedValue({
        id: 'creator_1',
        userId: 'creator_user_1',
        status: 'active',
        pricingCents: 500,
        visibility: {
          showHoldings: true,
          showTradeHistory: true,
          showRationale: false,
          showSectors: true,
          showRiskMetrics: false,
          showWatchlists: false,
          tradeDelayHours: 24,
          hideShareCount: false,
        },
      });
      (prismaMock as any).creatorSubscription.findFirst.mockResolvedValue({ id: 'sub_1' });
      (prismaMock as any).creatorSubscription.count.mockResolvedValue(1);

      // Pre-seed the mock for portfolioTrade.findMany with a trade older than 24h
      (prismaMock as any).portfolioTrade.findMany.mockResolvedValue([
        { ticker: 'AAPL', type: 'buy', date: twoDaysAgo, shares: 10, price: 185 },
      ]);

      const result = await getLockedContent('creator_user_1', 'paid_viewer_1', 'tradeHistory') as any[];

      // The portfolioTrade.findMany call should use the delay cutoff filter
      const findManyCall = (prismaMock as any).portfolioTrade.findMany.mock.calls[0][0];
      expect(findManyCall.where.date).toBeDefined();
      expect(findManyCall.where.date.lte).toBeInstanceOf(Date);
      // The cutoff date should be approximately now - 24h
      const cutoff = findManyCall.where.date.lte.getTime();
      const expectedCutoff = Date.now() - 24 * 60 * 60 * 1000;
      expect(Math.abs(cutoff - expectedCutoff)).toBeLessThan(5000); // within 5 seconds
    });
  });
});
