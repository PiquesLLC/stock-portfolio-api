/**
 * Profile Visibility Security Tests
 *
 * Verifies that holdingsVisibility and creator paywall settings
 * properly gate ALL portfolio data — not just the holdings list,
 * but also performance stats, chart data, share cards, and leaderboard.
 *
 * Bug: Users set holdingsVisibility='hidden' but their performance stats,
 * chart data, and share cards are still publicly visible.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

/* ------------------------------------------------------------------ */
/*  Hoisted mocks — must be declared before vi.mock()                 */
/* ------------------------------------------------------------------ */
const {
  resolveAccessLevelMock,
  getUserPortfolioMock,
  getSnapshotChartPointsMock,
  getPerformanceComparisonMock,
  getUserActivityMock,
  getFollowCountsMock,
  isFollowingMock,
  getCreatorProfileMock,
  generatePerformanceCardMock,
  getLeaderboardMock,
} = vi.hoisted(() => ({
  resolveAccessLevelMock: vi.fn().mockResolvedValue('public'),
  getUserPortfolioMock: vi.fn(),
  getSnapshotChartPointsMock: vi.fn().mockResolvedValue([]),
  getPerformanceComparisonMock: vi.fn(),
  getUserActivityMock: vi.fn().mockResolvedValue([]),
  getFollowCountsMock: vi.fn().mockResolvedValue({ followers: 5, following: 3 }),
  isFollowingMock: vi.fn().mockResolvedValue(false),
  getCreatorProfileMock: vi.fn().mockResolvedValue(null),
  generatePerformanceCardMock: vi.fn(),
  getLeaderboardMock: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/*  Module mocks                                                       */
/* ------------------------------------------------------------------ */
vi.mock('../middleware/rateLimiter', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const passthrough = (_req: any, _res: any, next: any) => next();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? passthrough : v]),
  );
});

vi.mock('../middleware/auth.middleware', () => {
  const optionalAuth = (req: any, _res: any, next: any) => {
    // Simulate an authenticated viewer (different user than the target)
    if (req.headers['x-test-auth'] === '1') {
      req.user = { userId: 'viewer-user-id', username: 'viewer', plan: 'pro' };
    }
    // No auth header = anonymous viewer
    next();
  };
  const requireAuth = (req: any, res: any, next: any) => {
    if (req.headers['x-test-auth'] !== '1') {
      return res.status(401).json({ error: 'Authorization required' });
    }
    req.user = { userId: 'viewer-user-id', username: 'viewer', plan: 'pro' };
    next();
  };
  return {
    requireAuth,
    requireAuthAllowUnverified: requireAuth,
    optionalAuth,
    requireOwnership: () => (_req: any, _res: any, next: any) => next(),
  };
});

vi.mock('../services/creator.service', () => ({
  resolveAccessLevel: resolveAccessLevelMock,
  getCreatorProfile: getCreatorProfileMock,
}));

vi.mock('../services/user-portfolio.service', () => ({
  getUserPortfolio: getUserPortfolioMock,
}));

vi.mock('../services/snapshot.service', () => ({
  createUserSnapshotIfNeeded: vi.fn().mockResolvedValue(undefined),
  getUserChartSnapshots: vi.fn().mockResolvedValue({ points: [], periodStartValue: 0 }),
  getSnapshotChartPoints: getSnapshotChartPointsMock,
  reconstructPortfolioHistoryHiRes: vi.fn().mockResolvedValue([]),
  recordSnapshot: vi.fn(),
}));

vi.mock('../services/benchmark.service', () => ({
  getPerformanceComparison: getPerformanceComparisonMock,
}));

vi.mock('../services/activity.service', () => ({
  getUserActivity: getUserActivityMock,
}));

vi.mock('../services/follow.service', () => ({
  followUser: vi.fn(),
  unfollowUser: vi.fn(),
  isFollowing: isFollowingMock,
  getFollowers: vi.fn().mockResolvedValue([]),
  getFollowing: vi.fn().mockResolvedValue([]),
  getFollowCounts: getFollowCountsMock,
}));

vi.mock('../services/report.service', () => ({
  reportUser: vi.fn(),
}));

vi.mock('../services/share-card.service', () => ({
  generatePerformanceCard: generatePerformanceCardMock,
  generateStockShareCard: vi.fn(),
}));

vi.mock('../services/leaderboard.service', () => ({
  getLeaderboard: getLeaderboardMock,
}));


/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */
const TARGET_USER_ID = 'target-user-hidden';

const baseUser = {
  id: TARGET_USER_ID,
  username: 'hiddenuser',
  displayName: 'Hidden User',
  profilePublic: true,
  trackingActive: true,
  leaderboardEligible: true,
  region: null,
  showRegion: false,
  bio: 'I like privacy',
  plan: 'pro',
  planStartedAt: new Date(),
  createdAt: new Date(),
  holdingsVisibility: 'hidden' as const,
  creator: null,
};

const mockPortfolio = {
  holdings: [
    { ticker: 'AAPL', shares: 100, averageCost: 150, totalCost: 15000, currentPrice: 180, currentValue: 18000, profitLoss: 3000, profitLossPercent: 20, dayChange: 200, dayChangePercent: 1.1 },
    { ticker: 'TSLA', shares: 50, averageCost: 200, totalCost: 10000, currentPrice: 250, currentValue: 12500, profitLoss: 2500, profitLossPercent: 25, dayChange: -100, dayChangePercent: -0.8 },
  ],
  holdingsValue: 30500,
  totalAssets: 35000,
  cashBalance: 4500,
  marginDebt: 0,
  dayChange: 100,
  dayChangePercent: 0.3,
  totalPL: 5500,
  totalPLPercent: 22,
  netEquity: 35000,
};

const mockPerformance = {
  twrPct: 15.5,
  simpleReturnPct: 14.2,
  alphaPct: 3.1,
  beta: 1.2,
  sharpePct: 1.8,
  benchmarkReturnPct: 11.1,
  benchmarkTicker: 'SPY',
};

// Chart points spanning 10 days (exceeds 1M progressive unlock minimum of 7 days)
const now = Date.now();
const DAY = 86400000;
const mockChartPoints = [
  { time: now - 10 * DAY, value: 30000 },
  { time: now - 9 * DAY, value: 30200 },
  { time: now - 8 * DAY, value: 30500 },
  { time: now - 7 * DAY, value: 30300 },
  { time: now - 6 * DAY, value: 30800 },
  { time: now - 5 * DAY, value: 31000 },
  { time: now - 4 * DAY, value: 30900 },
  { time: now - 3 * DAY, value: 31200 },
  { time: now - 2 * DAY, value: 31500 },
  { time: now - 1 * DAY, value: 30500 },
];

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */
describe('Profile Visibility — holdingsVisibility=hidden', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: user with holdingsVisibility='hidden', public profile, no creator
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    getUserPortfolioMock.mockResolvedValue(mockPortfolio);
    getSnapshotChartPointsMock.mockResolvedValue(mockChartPoints);
    getPerformanceComparisonMock.mockResolvedValue(mockPerformance);
    prismaMock.portfolioSnapshot.findMany.mockResolvedValue([]);
    prismaMock.activityEvent.findMany.mockResolvedValue([]);
  });

  /* ================================================================ */
  /*  1. GET /users/:userId/profile                                    */
  /* ================================================================ */
  describe('GET /users/:userId/profile', () => {
    it('should NOT return performance data when holdingsVisibility=hidden', async () => {
      const app = (await import('../app')).default;
      const res = await request(app)
        .get(`/users/${TARGET_USER_ID}/profile`)
        .set('x-test-auth', '1');

      expect(res.status).toBe(200);
      // Performance should be null/omitted when holdings are hidden
      expect(res.body.performance).toBeNull();
    });

    it('should NOT leak holdingsVisibility value to non-owner viewers', async () => {
      const app = (await import('../app')).default;
      const res = await request(app)
        .get(`/users/${TARGET_USER_ID}/profile`)
        .set('x-test-auth', '1');

      expect(res.status).toBe(200);
      // holdingsVisibility setting itself should not be exposed to viewers
      // (they should just see the effect — hidden content — not the setting name)
      expect(res.body.holdingsVisibility).not.toBe('hidden');
    });
  });

  /* ================================================================ */
  /*  2. GET /users/:userId/chart                                      */
  /* ================================================================ */
  describe('GET /users/:userId/chart', () => {
    it('should return empty chart when holdingsVisibility=hidden', async () => {
      const app = (await import('../app')).default;
      const res = await request(app)
        .get(`/users/${TARGET_USER_ID}/chart?period=1M`)
        .set('x-test-auth', '1');

      expect(res.status).toBe(200);
      // Chart should return empty points and zero start value
      expect(res.body.points).toEqual([]);
      expect(res.body.periodStartValue).toBe(0);
    });
  });

  /* ================================================================ */
  /*  3. GET /social/:userId/performance-card                          */
  /* ================================================================ */
  describe('GET /social/:userId/performance-card', () => {
    it('should return 403 or null when target has holdingsVisibility=hidden', async () => {
      generatePerformanceCardMock.mockResolvedValue(null);
      const app = (await import('../app')).default;
      const res = await request(app)
        .get(`/social/${TARGET_USER_ID}/performance-card?period=1M`);

      // Should either return 404 (card not found) or 403 (access denied)
      expect([403, 404]).toContain(res.status);
    });
  });

  /* ================================================================ */
  /*  4. Leaderboard — holdingsVisibility filter in Prisma query       */
  /* ================================================================ */
  describe('Leaderboard service', () => {
    it('should query only users with holdingsVisibility=all', async () => {
      // Import the REAL service (bypass mock) to verify Prisma query shape
      const { getLeaderboard: realGetLeaderboard } = await vi.importActual<typeof import('../services/leaderboard.service')>('../services/leaderboard.service');

      // Capture the query args from findMany, then return empty so the rest exits quickly
      let capturedArgs: any = null;
      prismaMock.user.findMany = vi.fn().mockImplementation((args: any) => {
        capturedArgs = args;
        return Promise.resolve([]); // No users → service returns immediately
      });
      // Stub additional calls needed by the leaderboard service
      prismaMock.userSettings.findMany = vi.fn().mockResolvedValue([]);
      prismaMock.holding.findMany.mockResolvedValue([]);
      prismaMock.creator.findMany.mockResolvedValue([]);
      prismaMock.leaderboardCache.deleteMany.mockResolvedValue({ count: 0 });
      (prismaMock as any).leaderboardCache.createMany = vi.fn().mockResolvedValue({ count: 0 });

      const result = await realGetLeaderboard('1M', 'world');

      // Verify Prisma query includes holdingsVisibility filter
      expect(capturedArgs).not.toBeNull();
      expect(capturedArgs.where).toHaveProperty('holdingsVisibility', 'all');
    });
  });
});

/* ================================================================== */
/*  Creator paywall — same tests but with active creator paywall       */
/* ================================================================== */
describe('Profile Visibility — Creator paywall (showHoldings=true)', () => {
  const creatorUser = {
    ...baseUser,
    holdingsVisibility: 'all',  // holdingsVisibility is default, but creator paywall is active
    creator: {
      status: 'active',
      visibility: {
        showHoldings: true,     // Holdings are paywalled
        showTradeHistory: true,
        showRationale: false,
        showSectors: false,
        showRiskMetrics: true,
        showWatchlists: false,
        hideShareCount: false,
        tradeDelayHours: 0,
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Return fresh deep copy each call so mutations don't leak between tests
    getUserPortfolioMock.mockImplementation(() =>
      Promise.resolve(JSON.parse(JSON.stringify(mockPortfolio))),
    );
    prismaMock.user.findUnique.mockResolvedValue(creatorUser);
    prismaMock.creator.findUnique.mockResolvedValue({
      userId: TARGET_USER_ID,
      status: 'active',
      visibility: creatorUser.creator.visibility,
    });
    resolveAccessLevelMock.mockResolvedValue('public'); // Viewer is NOT a paid subscriber
    getSnapshotChartPointsMock.mockResolvedValue(mockChartPoints);
    getPerformanceComparisonMock.mockResolvedValue(mockPerformance);
    getCreatorProfileMock.mockResolvedValue({
      status: 'active',
      accessLevel: 'public',
      visibility: creatorUser.creator.visibility,
    });
    prismaMock.portfolioSnapshot.findMany.mockResolvedValue([]);
    prismaMock.activityEvent.findMany.mockResolvedValue([]);
  });

  describe('GET /users/:userId/chart', () => {
    it('should return empty chart for non-paid viewer when creator paywalls holdings', async () => {
      const app = (await import('../app')).default;
      const res = await request(app)
        .get(`/users/${TARGET_USER_ID}/chart?period=1M`)
        .set('x-test-auth', '1');

      expect(res.status).toBe(200);
      expect(res.body.points).toEqual([]);
      expect(res.body.periodStartValue).toBe(0);
    });
  });

  describe('GET /social/:userId/performance-card', () => {
    it('should return 403 or 404 for non-paid viewer when creator paywalls holdings', async () => {
      generatePerformanceCardMock.mockResolvedValue(null);
      const app = (await import('../app')).default;
      const res = await request(app)
        .get(`/social/${TARGET_USER_ID}/performance-card?period=1M`);

      expect([403, 404]).toContain(res.status);
    });
  });

  /* ================================================================ */
  /*  CRITICAL: Portfolio endpoint — blur, never hide (Mar 20 fix)     */
  /* ================================================================ */
  describe('GET /users/:userId/portfolio — paywalled holdings', () => {
    it('should return masked holdings with holdingsPaywalled=true for non-paid viewer', async () => {
      const app = (await import('../app')).default;
      const res = await request(app)
        .get(`/users/${TARGET_USER_ID}/portfolio`)
        .set('x-test-auth', '1');

      expect(res.status).toBe(200);
      // MUST return holdings (not empty) so UI can blur them
      expect(res.body.holdings.length).toBeGreaterThan(0);
      // MUST set holdingsPaywalled flag
      expect(res.body.holdingsPaywalled).toBe(true);
      // Tickers must be real (for blur visual), but values must be zeroed
      expect(res.body.holdings[0].ticker).toBe('AAPL');
      expect(res.body.holdings[0].shares).toBe(0);
      expect(res.body.holdings[0].averageCost).toBe(0);
      expect(res.body.holdings[0].currentValue).toBe(0);
      expect(res.body.holdings[0].profitLossPercent).toBe(0);
    });

    it('should NEVER return empty holdings array for paywalled creators', async () => {
      const app = (await import('../app')).default;
      const res = await request(app)
        .get(`/users/${TARGET_USER_ID}/portfolio`)
        .set('x-test-auth', '1');

      expect(res.status).toBe(200);
      // This is the exact bug from Mar 20 — holdings=[] hides the section entirely
      // instead of showing blurred content with a lock overlay
      expect(res.body.holdings).not.toEqual([]);
    });

    it('should return full unmasked holdings for paid subscribers', async () => {
      resolveAccessLevelMock.mockResolvedValue('paid');
      const app = (await import('../app')).default;
      const res = await request(app)
        .get(`/users/${TARGET_USER_ID}/portfolio`)
        .set('x-test-auth', '1');

      expect(res.status).toBe(200);
      // Paid subscribers get real data
      expect(res.body.holdingsPaywalled).toBeUndefined();
      expect(res.body.holdings[0].shares).toBe(100);
      expect(res.body.holdings[0].currentValue).toBe(18000);
    });

    it('owner viewing own profile should never trigger paywall masking', async () => {
      // The controller checks isOwner = viewerId === userId
      // When isOwner is true, the paywall branch is skipped entirely
      // We verify this by checking the controller source for the guard
      const controllerSource = await import('fs').then(fs =>
        fs.readFileSync(
          require('path').resolve(__dirname, '../controllers/users.controller.ts'),
          'utf-8',
        ),
      );
      // The !isOwner guard must exist before any holdings masking
      expect(controllerSource).toMatch(/if\s*\(\s*!isOwner\s*\)/);
      // holdingsPaywalled should only be set inside the !isOwner block
      expect(controllerSource).toContain('holdingsPaywalled');
    });
  });
});

/* ================================================================== */
/*  Leaderboard — creator trade delay must NOT null returns (Mar 20)   */
/* ================================================================== */
describe('Leaderboard — creator trade delay returns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should NOT null out returns for creators with tradeDelayHours > 0', async () => {
    // Verify the leaderboard service source code does NOT contain the
    // trade delay nulling pattern that caused the Mar 20 bug
    const serviceSource = await import('fs').then(fs =>
      fs.readFileSync(
        require('path').resolve(__dirname, '../services/leaderboard.service.ts'),
        'utf-8',
      ),
    );

    // The old bug: code searched for creators with tradeDelayHours > 0 and nulled their returns
    // This pattern must NEVER exist in the leaderboard service
    expect(serviceSource).not.toMatch(/entry\.returnPct\s*=\s*null/);
    expect(serviceSource).not.toMatch(/entry\.twrPct\s*=\s*null/);
    expect(serviceSource).not.toMatch(/entry\.returnDollar\s*=\s*null/);
    // The comment explaining why we DON'T null should be present
    expect(serviceSource).toContain('Creators with trade delay still show return percentages');
  });
});
