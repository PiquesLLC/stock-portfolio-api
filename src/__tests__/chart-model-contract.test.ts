import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { generateTestToken, testUser } from './helpers';
import { __mockPrisma as prismaMock } from '../utils/prisma';

const {
  getPortfolioMock,
  getHoldingsMock,
  reconstructPortfolioHistoryFromLedgerWithDiagnosticsMock,
} = vi.hoisted(() => ({
  getPortfolioMock: vi.fn(),
  getHoldingsMock: vi.fn(),
  reconstructPortfolioHistoryFromLedgerWithDiagnosticsMock: vi.fn(),
}));

vi.mock('../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    loginLimiter: passthrough,
    signupLimiter: passthrough,
    generalLimiter: passthrough,
    mutationLimiter: passthrough,
    heavyReadLimiter: passthrough,
    importLimiter: passthrough,
    mfaVerifyLimiter: passthrough,
    mfaSendLimiter: passthrough,
    setPasswordLimiter: passthrough,
    apiLimiter: passthrough,
    oauthLimiter: passthrough,
    enumerationLimiter: passthrough,
    webhookLimiter: passthrough,
    billingMutationLimiter: passthrough,
    billingWebhookLimiter: passthrough,
    chartLimiter: passthrough,
  };
});

vi.mock('../middleware/email-verification.middleware', () => ({
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../services/portfolio.service', async () => {
  const actual = await vi.importActual<typeof import('../services/portfolio.service')>('../services/portfolio.service');
  return {
    ...actual,
    getPortfolio: getPortfolioMock,
    getHoldings: getHoldingsMock,
  };
});

vi.mock('../services/snapshot.service', async () => {
  const actual = await vi.importActual<typeof import('../services/snapshot.service')>('../services/snapshot.service');
  return {
    ...actual,
    reconstructPortfolioHistoryFromLedgerWithDiagnostics: reconstructPortfolioHistoryFromLedgerWithDiagnosticsMock,
  };
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

describe('GET /portfolio/history/chart model contract', () => {
  const token = generateTestToken(testUser);

  beforeEach(() => {
    vi.clearAllMocks();

    getPortfolioMock.mockResolvedValue({
      holdings: [],
      options: [],
      cashBalance: 0,
      marginDebt: 0,
      holdingsValue: 51000,
      totalAssets: 51000,
      netEquity: 51000,
      totalValue: 51000,
      totalCost: 45000,
      totalPL: 6000,
      totalPLPercent: 13.33,
      dayChange: 250,
      dayChangePercent: 0.49,
      regularDayChange: 250,
      regularDayChangePercent: 0.49,
      afterHoursChange: 0,
      afterHoursChangePercent: 0,
      quotesStale: false,
      quotesUnavailableCount: 0,
      quotesMeta: {},
      session: 'regular',
    });
    getHoldingsMock.mockResolvedValue([]);
    prismaMock.ledgerEvent.count.mockResolvedValue(2);
    reconstructPortfolioHistoryFromLedgerWithDiagnosticsMock.mockResolvedValue({
      points: [
        { time: Date.UTC(2026, 1, 20), value: 50000, confidence: 72, estimated: true },
        { time: Date.UTC(2026, 1, 21), value: 50500, confidence: 78, estimated: true },
      ],
      gaps: [{ start: '2026-02-20T00:00:00.000Z', end: '2026-02-20T00:00:00.000Z', reason: 'Missing price coverage below 80%' }],
      confidenceThreshold: 80,
    });
  });

  it('includes estimated + confidenceThreshold when source=model', async () => {
    const app = (await import('../app')).default;
    const res = await request(app)
      .get('/portfolio/history/chart?period=1W')
      .set('Cookie', `authToken=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('model');
    expect(res.body.estimated).toBe(true);
    expect(res.body.confidenceThreshold).toBe(80);
    expect(Array.isArray(res.body.points)).toBe(true);
    expect(res.body.points[0]).toEqual(
      expect.objectContaining({ confidence: 72, estimated: true }),
    );
  });
});

