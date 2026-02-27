import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { generateTestToken, testUser } from './helpers';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  getPortfolioMock,
  getSnapshotChartPointsMock,
} = vi.hoisted(() => ({
  getPortfolioMock: vi.fn(),
  getSnapshotChartPointsMock: vi.fn(),
}));

vi.mock('../services/portfolio.service', async () => {
  const actual = await vi.importActual<typeof import('../services/portfolio.service')>('../services/portfolio.service');
  return {
    ...actual,
    getPortfolio: getPortfolioMock,
    getHoldings: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../services/snapshot.service', async () => {
  const actual = await vi.importActual<typeof import('../services/snapshot.service')>('../services/snapshot.service');
  return {
    ...actual,
    getSnapshotChartPoints: getSnapshotChartPointsMock,
    reconstructPortfolioHistoryHiRes: vi.fn().mockResolvedValue([]),
    getAllSnapshots: vi.fn().mockResolvedValue([]),
    getSnapshotsAfter: vi.fn().mockResolvedValue([]),
    getLatestCompositionChangeAfter: vi.fn().mockResolvedValue(null),
    recordCompositionChange: vi.fn().mockResolvedValue(undefined),
    resetSnapshotsForCompositionChange: vi.fn().mockResolvedValue(undefined),
    createSnapshotIfNeeded: vi.fn().mockResolvedValue(null),
    createUserSnapshotIfNeeded: vi.fn().mockResolvedValue(false),
  };
});

vi.mock('../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    loginLimiter: passthrough, signupLimiter: passthrough, generalLimiter: passthrough,
    mutationLimiter: passthrough, heavyReadLimiter: passthrough, importLimiter: passthrough,
    mfaVerifyLimiter: passthrough, mfaSendLimiter: passthrough, setPasswordLimiter: passthrough,
    apiLimiter: passthrough, oauthLimiter: passthrough, enumerationLimiter: passthrough,
    webhookLimiter: passthrough, billingMutationLimiter: passthrough, billingWebhookLimiter: passthrough,
    chartLimiter: passthrough,
  };
});

vi.mock('../middleware/auth.middleware', () => {
  const authHandler = (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-id-123', username: 'testuser', plan: 'pro' };
    next();
  };
  return {
    requireAuth: authHandler,
    requireAuthAllowUnverified: authHandler,
    optionalAuth: authHandler,
    requireOwnership: () => (_req: any, _res: any, next: any) => next(),
  };
});

vi.mock('../middleware/email-verification.middleware', () => ({
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../controllers/users.controller', async () => {
  const actual = await vi.importActual<typeof import('../controllers/users.controller')>('../controllers/users.controller');
  return { ...actual, getUserChartHandler: vi.fn() };
});

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  Handlers: {
    requestHandler: () => (_req: any, _res: any, next: any) => next(),
    errorHandler: () => (_err: any, _req: any, _res: any, next: any) => next(),
  },
  captureException: vi.fn(),
  setUser: vi.fn(),
  startSpan: vi.fn((_: any, cb: any) => cb({})),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePortfolio(overrides: Record<string, any> = {}) {
  return {
    holdings: [], options: [], cashBalance: 5000, marginDebt: 0,
    holdingsValue: 46000, totalAssets: 51000, netEquity: 51000,
    totalValue: 51000, totalCost: 45000, totalPL: 6000,
    totalPLPercent: 13.33, dayChange: 250, dayChangePercent: 0.49,
    regularDayChange: 250, regularDayChangePercent: 0.49,
    afterHoursChange: 0, afterHoursChangePercent: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  getPortfolioMock.mockResolvedValue(makePortfolio());
  // Default: ledger events = 0
  (prismaMock as any).ledgerEvent.count.mockResolvedValue(0);
});

describe('YTD chart with baseline', () => {
  const token = generateTestToken(testUser);
  const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime();

  it('returns synthetic Jan 1 point when baseline is set and only 1 snapshot exists', async () => {
    const app = (await import('../app')).default;

    // getSnapshotChartPoints returns [] because it enforces >= 2 internally
    getSnapshotChartPointsMock.mockResolvedValue([]);

    // Direct snapshot query fallback returns 1 snapshot
    const snapshotTime = jan1 + 10 * 86400000; // 10 days after Jan 1
    (prismaMock as any).portfolioSnapshot.findMany.mockResolvedValue([
      { timestamp: new Date(snapshotTime), totalValue: 52000, netEquity: 52000 },
    ]);

    // User has baseline set
    (prismaMock as any).userSettings.findUnique.mockResolvedValue({
      ytdBaselineValue: 50000,
    });

    const res = await request(app)
      .get('/portfolio/history/chart?period=YTD')
      .set('Cookie', `authToken=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.insufficientData).toBeFalsy();
    expect(res.body.periodStartValue).toBe(50000);
    expect(res.body.points.length).toBeGreaterThanOrEqual(2);
    // First point should be synthetic Jan 1
    expect(res.body.points[0].time).toBe(jan1);
    expect(res.body.points[0].value).toBe(50000);
  });

  it('returns insufficientData when no baseline and < 30 days of snapshots', async () => {
    const app = (await import('../app')).default;

    // Only 5 days of data — not enough for YTD without baseline
    const baseTime = Date.now() - 5 * 86400000;
    getSnapshotChartPointsMock.mockResolvedValue([
      { time: baseTime, value: 50000 },
      { time: baseTime + 86400000, value: 50500 },
    ]);

    // No baseline
    (prismaMock as any).userSettings.findUnique.mockResolvedValue({
      ytdBaselineValue: null,
    });

    const res = await request(app)
      .get('/portfolio/history/chart?period=YTD')
      .set('Cookie', `authToken=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.insufficientData).toBe(true);
  });

  it('uses baseline as periodStartValue even when many snapshots exist', async () => {
    const app = (await import('../app')).default;

    const baseTime = jan1 + 5 * 86400000;
    const points = Array.from({ length: 40 }, (_, i) => ({
      time: baseTime + i * 86400000,
      value: 51000 + i * 100,
    }));
    getSnapshotChartPointsMock.mockResolvedValue(points);

    (prismaMock as any).userSettings.findUnique.mockResolvedValue({
      ytdBaselineValue: 48000,
    });

    const res = await request(app)
      .get('/portfolio/history/chart?period=YTD')
      .set('Cookie', `authToken=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.periodStartValue).toBe(48000);
    // First point should be synthetic Jan 1
    expect(res.body.points[0].time).toBe(jan1);
    expect(res.body.points[0].value).toBe(48000);
  });
});
