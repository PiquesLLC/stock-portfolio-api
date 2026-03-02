import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const {
  getLedgerReplayGapSummaryMock,
  ledgerEventCountMock,
} = vi.hoisted(() => ({
  getLedgerReplayGapSummaryMock: vi.fn(),
  ledgerEventCountMock: vi.fn(),
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
    waitlistJoinLimiter: passthrough,
  };
});

vi.mock('../middleware/auth.middleware', () => {
  const authHandler = (req: any, res: any, next: any) => {
    if (req.headers['x-test-auth'] !== '1') {
      res.status(401).json({ error: 'Authorization required' });
      return;
    }
    req.user = { userId: 'user_1', username: 'tester', plan: 'pro' };
    next();
  };
  return {
    requireAuth: authHandler,
    requireAuthAllowUnverified: authHandler,
    optionalAuth: (_req: any, _res: any, next: any) => next(),
    requireOwnership: () => (_req: any, _res: any, next: any) => next(),
  };
});

vi.mock('../services/snapshot.service', async () => {
  const actual = await vi.importActual<typeof import('../services/snapshot.service')>('../services/snapshot.service');
  return {
    ...actual,
    getLedgerReplayGapSummary: getLedgerReplayGapSummaryMock,
  };
});

vi.mock('../utils/prisma', () => ({
  default: {
    ledgerEvent: {
      count: ledgerEventCountMock,
    },
  },
}));

describe('GET /portfolio/history/chart/gaps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ledgerEventCountMock.mockResolvedValue(1);
    getLedgerReplayGapSummaryMock.mockResolvedValue([
      {
        start: '2026-02-20T00:00:00.000Z',
        end: '2026-02-21T00:00:00.000Z',
        reason: 'Missing price coverage below 80%',
      },
    ]);
  });

  it('returns 400 for invalid period', async () => {
    const app = (await import('../app')).default;
    const res = await request(app)
      .get('/portfolio/history/chart/gaps?period=BAD')
      .set('x-test-auth', '1');

    expect(res.status).toBe(400);
    expect(getLedgerReplayGapSummaryMock).not.toHaveBeenCalled();
  });

  it('returns empty gaps when user has no ledger events', async () => {
    ledgerEventCountMock.mockResolvedValueOnce(0);
    const app = (await import('../app')).default;
    const res = await request(app)
      .get('/portfolio/history/chart/gaps?period=1W')
      .set('x-test-auth', '1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ period: '1W', gaps: [] });
    expect(getLedgerReplayGapSummaryMock).not.toHaveBeenCalled();
  });

  it('returns gap summary for valid period', async () => {
    const app = (await import('../app')).default;
    const res = await request(app)
      .get('/portfolio/history/chart/gaps?period=1M')
      .set('x-test-auth', '1');

    expect(res.status).toBe(200);
    expect(res.body.period).toBe('1M');
    expect(res.body.gaps).toHaveLength(1);
    expect(getLedgerReplayGapSummaryMock).toHaveBeenCalledWith('user_1', 30);
  });
});

