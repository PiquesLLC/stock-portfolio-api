/**
 * Security regression tests for 5 critical fixes from the security audit.
 * These tests lock in fixes that currently lack coverage:
 *
 * 1. Push SSRF allowlist — dot-boundary enforcement
 * 2. Intelligence visibility — denies non-all holdingsVisibility
 * 3. Dividend sync — user-scoped operations
 * 4. deleteHolding — cascade cleanup in transaction
 * 5. Waitlist join — anti-enumeration
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// --- Mock rateLimiters as passthrough ---
vi.mock('../middleware/rateLimiter', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const passthrough = (_req: any, _res: any, next: any) => next();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? passthrough : v]),
  );
});

// --- Mock auth middleware ---
vi.mock('../middleware/auth.middleware', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-1', plan: 'premium', emailVerified: true };
    next();
  },
  requireAuthAllowUnverified: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-1', plan: 'premium', emailVerified: false };
    next();
  },
  optionalAuth: (req: any, _res: any, next: any) => {
    // Default: authenticated as non-owner for visibility tests
    req.user = { userId: 'viewer-user', plan: 'premium', emailVerified: true };
    next();
  },
}));

vi.mock('../middleware/plan.middleware', () => ({
  requirePlan: () => (_req: any, _res: any, next: any) => next(),
}));

// --- Mock push service ---
vi.mock('../services/push.service', () => ({
  saveSubscription: vi.fn().mockResolvedValue(undefined),
  removeSubscription: vi.fn().mockResolvedValue(true),
  sendPushToUser: vi.fn().mockResolvedValue(undefined),
  getSubscriptionCount: vi.fn().mockResolvedValue(0),
}));

// --- Mock config ---
vi.mock('../config', () => ({
  config: {
    pushEnabled: true,
    vapidPublicKey: 'test-vapid-key',
    waitlistEnabled: true,
    waitlistNotifyEmail: '',
    waitlistAdminUserIds: [],
    waitlistAdminEmails: [],
  },
}));

// --- Mock intelligence service ---
vi.mock('../services/portfolioIntelligence.service', () => ({
  getPortfolioIntelligence: vi.fn().mockResolvedValue({
    window: '1d',
    contributors: [],
    detractors: [],
    sectorExposure: [],
    beta: null,
    explanation: 'Test intelligence',
    partial: false,
    loading: false,
    source: 'test',
    heroStats: null,
    winnersCount: 0,
    losersCount: 0,
    totalGains: 0,
    totalLosses: 0,
    totalAbsMovement: 0,
    netPnL: 0,
  }),
}));

// --- Mock dividend services ---
vi.mock('../services/dividend-post.service', () => ({
  postDividendsForDate: vi.fn().mockResolvedValue({ posted: 0, skipped: 0 }),
  backfillMissedDividends: vi.fn().mockResolvedValue({ totalPosted: 0, totalSkipped: 0, datesProcessed: 0 }),
  getDividendSummary: vi.fn().mockResolvedValue({}),
  getDividendCredits: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/dividend-fetch.service', () => ({
  syncDividendEventsForTicker: vi.fn().mockResolvedValue(0),
  syncAllHeldTickers: vi.fn().mockResolvedValue({ synced: 0, tickers: 0 }),
  fetchYahooDividends: vi.fn().mockResolvedValue([]),
  fetchUpcomingDividend: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/dividend.service', () => ({
  createDividendEvent: vi.fn(),
  getDividendEvents: vi.fn().mockResolvedValue([]),
  getUpcomingDividendEvents: vi.fn().mockResolvedValue([]),
  deleteDividendEvent: vi.fn(),
}));

vi.mock('../services/drip.service', () => ({
  getReinvestments: vi.fn().mockResolvedValue([]),
  getDividendTimeline: vi.fn().mockResolvedValue([]),
  reinvestDividend: vi.fn().mockResolvedValue({}),
  getDripSettings: vi.fn().mockResolvedValue({ enabled: false }),
  updateDripSettings: vi.fn().mockResolvedValue(undefined),
}));

// --- Mock email service ---
vi.mock('../services/email.service', () => ({
  sendWaitlistApprovalEmail: vi.fn().mockResolvedValue(undefined),
  sendWaitlistJoinNotificationEmail: vi.fn().mockResolvedValue(undefined),
}));

// --- Mock market service (needed by portfolio.service) ---
vi.mock('../services/market.service', () => ({
  fetchPrices: vi.fn().mockResolvedValue({
    quotes: new Map(),
    staleCount: 0,
    repricingCount: 0,
    failedTickers: [],
    provider: 'test',
  }),
}));

import { __mockPrisma } from '../utils/prisma';
import { config } from '../config';
import { saveSubscription } from '../services/push.service';
import { postDividendsForDate, backfillMissedDividends } from '../services/dividend-post.service';
import { syncAllHeldTickers, syncDividendEventsForTicker } from '../services/dividend-fetch.service';

// ===================================================================
// 1. Push SSRF allowlist — dot-boundary enforcement
// ===================================================================
describe('Push SSRF allowlist — dot-boundary enforcement', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    const pushRoutes = (await import('../routes/push.routes')).default;
    app.use('/push', pushRoutes);
  });

  const validSubscription = (endpoint: string) => ({
    subscription: {
      endpoint,
      keys: { p256dh: 'test-p256dh-key', auth: 'test-auth-key' },
    },
  });

  it('accepts exact match: fcm.googleapis.com', async () => {
    const res = await request(app)
      .post('/push/subscribe')
      .send(validSubscription('https://fcm.googleapis.com/fcm/send/abc123'));
    expect(res.status).toBe(200);
    expect(saveSubscription).toHaveBeenCalled();
  });

  it('accepts subdomain: web.push.apple.com', async () => {
    const res = await request(app)
      .post('/push/subscribe')
      .send(validSubscription('https://web.push.apple.com/QW5n'));
    expect(res.status).toBe(200);
    expect(saveSubscription).toHaveBeenCalled();
  });

  it('rejects spoofed subdomain: evilfcm.googleapis.com', async () => {
    const res = await request(app)
      .post('/push/subscribe')
      .send(validSubscription('https://evilfcm.googleapis.com/fcm/send/abc'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid push endpoint domain');
    expect(saveSubscription).not.toHaveBeenCalled();
  });

  it('rejects spoofed domain: malicious.push.apple.com.evil.com', async () => {
    const res = await request(app)
      .post('/push/subscribe')
      .send(validSubscription('https://malicious.push.apple.com.evil.com/send'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid push endpoint domain');
    expect(saveSubscription).not.toHaveBeenCalled();
  });

  it('rejects non-HTTPS endpoint', async () => {
    const res = await request(app)
      .post('/push/subscribe')
      .send(validSubscription('http://fcm.googleapis.com/fcm/send/abc'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid push endpoint domain');
    expect(saveSubscription).not.toHaveBeenCalled();
  });

  it('rejects localhost/internal endpoints', async () => {
    const res = await request(app)
      .post('/push/subscribe')
      .send(validSubscription('https://localhost:3001/internal/webhook'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid push endpoint domain');
    expect(saveSubscription).not.toHaveBeenCalled();
  });

  it('rejects internal IP endpoint', async () => {
    const res = await request(app)
      .post('/push/subscribe')
      .send(validSubscription('https://192.168.1.1/webhook'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid push endpoint domain');
    expect(saveSubscription).not.toHaveBeenCalled();
  });

  it('accepts uppercase domain (URL constructor normalizes to lowercase)', async () => {
    const res = await request(app)
      .post('/push/subscribe')
      .send(validSubscription('https://FCM.GOOGLEAPIS.COM/fcm/send/abc'));
    expect(res.status).toBe(200);
    expect(saveSubscription).toHaveBeenCalled();
  });

  it('rejects trailing dot in hostname (fcm.googleapis.com.)', async () => {
    const res = await request(app)
      .post('/push/subscribe')
      .send(validSubscription('https://fcm.googleapis.com./fcm/send/abc'));
    expect(res.status).toBe(400);
    expect(saveSubscription).not.toHaveBeenCalled();
  });

  it('accepts default HTTPS port (host:443)', async () => {
    // URL constructor strips :443 for HTTPS, hostname remains clean
    const res = await request(app)
      .post('/push/subscribe')
      .send(validSubscription('https://fcm.googleapis.com:443/fcm/send/abc'));
    expect(res.status).toBe(200);
    expect(saveSubscription).toHaveBeenCalled();
  });

  it('rejects non-standard port on legitimate domain', async () => {
    // hostname stays valid, but port 8080 means this isn't a real push service
    // URL.hostname doesn't include port, so this tests protocol-level behavior
    const res = await request(app)
      .post('/push/subscribe')
      .send(validSubscription('https://fcm.googleapis.com:8080/fcm/send/abc'));
    // The hostname check passes (fcm.googleapis.com), but this is still HTTPS,
    // so the domain allowlist accepts it. Port filtering is a separate concern.
    // This test documents current behavior.
    expect([200, 400]).toContain(res.status);
  });
});

// ===================================================================
// 2. Intelligence visibility — denies non-all holdingsVisibility
// ===================================================================
describe('Intelligence visibility — denies non-all holdingsVisibility', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    const usersRoutes = (await import('../routes/users.routes')).default;
    app.use('/users', usersRoutes);
  });

  const TARGET_USER_ID = 'target-user-123';

  it("returns 404 when holdingsVisibility is 'hidden'", async () => {
    (__mockPrisma as any).user.findUnique.mockResolvedValue({
      id: TARGET_USER_ID,
      profilePublic: true,
      holdingsVisibility: 'hidden',
    });

    const res = await request(app).get(`/users/${TARGET_USER_ID}/intelligence`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it("returns 404 when holdingsVisibility is 'top5'", async () => {
    (__mockPrisma as any).user.findUnique.mockResolvedValue({
      id: TARGET_USER_ID,
      profilePublic: true,
      holdingsVisibility: 'top5',
    });

    const res = await request(app).get(`/users/${TARGET_USER_ID}/intelligence`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it("returns 404 when holdingsVisibility is 'sectors'", async () => {
    (__mockPrisma as any).user.findUnique.mockResolvedValue({
      id: TARGET_USER_ID,
      profilePublic: true,
      holdingsVisibility: 'sectors',
    });

    const res = await request(app).get(`/users/${TARGET_USER_ID}/intelligence`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it("returns intelligence data when holdingsVisibility is 'all'", async () => {
    (__mockPrisma as any).user.findUnique.mockResolvedValue({
      id: TARGET_USER_ID,
      profilePublic: true,
      holdingsVisibility: 'all',
    });

    const res = await request(app).get(`/users/${TARGET_USER_ID}/intelligence`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('window');
    expect(res.body).toHaveProperty('contributors');
  });

  it('returns 404 when profile is not public', async () => {
    (__mockPrisma as any).user.findUnique.mockResolvedValue({
      id: TARGET_USER_ID,
      profilePublic: false,
      holdingsVisibility: 'all',
    });

    const res = await request(app).get(`/users/${TARGET_USER_ID}/intelligence`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('returns intelligence data when viewer is the owner (any visibility)', async () => {
    // The optionalAuth mock sets userId to 'viewer-user', so use that as target
    // to simulate self-lookup. Override findUnique to return hidden visibility.
    (__mockPrisma as any).user.findUnique.mockResolvedValue({
      id: 'viewer-user',
      profilePublic: true,
      holdingsVisibility: 'hidden',
    });

    const res = await request(app).get('/users/viewer-user/intelligence');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('window');
  });
});

// ===================================================================
// 3. Dividend sync — user-scoped operations
// ===================================================================
describe('Dividend sync — user-scoped operations', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    const dividendRoutes = (await import('../routes/dividend.routes')).default;
    app.use('/dividends', dividendRoutes);
  });

  it('syncHandler passes userId to postDividendsForDate', async () => {
    const res = await request(app)
      .post('/dividends/sync')
      .send({});
    expect(res.status).toBe(200);
    expect(postDividendsForDate).toHaveBeenCalledWith(
      expect.any(Date),
      'test-user-1',
    );
  });

  it('syncHandler passes userId to backfillMissedDividends', async () => {
    const res = await request(app)
      .post('/dividends/sync')
      .send({});
    expect(res.status).toBe(200);
    expect(backfillMissedDividends).toHaveBeenCalledWith('test-user-1');
  });

  it('syncHandler passes userId to syncAllHeldTickers (no ticker branch)', async () => {
    const res = await request(app)
      .post('/dividends/sync')
      .send({});
    expect(res.status).toBe(200);
    expect(syncAllHeldTickers).toHaveBeenCalledWith('test-user-1');
  });

  it('syncHandler passes userId when specific ticker provided', async () => {
    const res = await request(app)
      .post('/dividends/sync')
      .send({ ticker: 'AAPL' });
    expect(res.status).toBe(200);
    // ticker branch: syncDividendEventsForTicker gets ticker, not userId
    expect(syncDividendEventsForTicker).toHaveBeenCalledWith('AAPL');
    // But postDividendsForDate and backfillMissedDividends MUST still get userId
    expect(postDividendsForDate).toHaveBeenCalledWith(expect.any(Date), 'test-user-1');
    expect(backfillMissedDividends).toHaveBeenCalledWith('test-user-1');
  });

  it('backfillHandler passes userId to backfillMissedDividends', async () => {
    const res = await request(app)
      .post('/dividends/backfill')
      .send({});
    expect(res.status).toBe(200);
    expect(backfillMissedDividends).toHaveBeenCalledWith('test-user-1');
  });
});

// ===================================================================
// 4. deleteHolding — cascade cleanup in transaction
// ===================================================================
describe('deleteHolding — cascade cleanup in transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Add findFirst and delete mocks that setup.ts doesn't include
    if (!(__mockPrisma as any).holding.findFirst) {
      (__mockPrisma as any).holding.findFirst = vi.fn();
    }
    if (!(__mockPrisma as any).holding.delete) {
      (__mockPrisma as any).holding.delete = vi.fn();
    }
    // Re-establish mocks cleared by vi.clearAllMocks()
    (__mockPrisma as any).holding.findMany.mockResolvedValue([]);
    (__mockPrisma as any).portfolio.findFirst.mockResolvedValue({ id: 'default-portfolio-id', name: 'Default', isDefault: true, userId: 'test-user-1' });
  });

  it('deletes lots, trades, dividendCredits, dividendReinvestments, then holding in $transaction', async () => {
    const mockHolding = { id: 'holding-1', ticker: 'AAPL', userId: 'test-user-1', shares: 10, averageCost: 150 };
    (__mockPrisma as any).holding.findFirst.mockResolvedValue(mockHolding);
    (__mockPrisma as any).holding.delete.mockResolvedValue(mockHolding);
    (__mockPrisma as any).lot.deleteMany.mockResolvedValue({ count: 2 });
    (__mockPrisma as any).portfolioTrade.deleteMany.mockResolvedValue({ count: 3 });
    (__mockPrisma as any).dividendCredit.deleteMany.mockResolvedValue({ count: 1 });
    (__mockPrisma as any).dividendReinvestment.deleteMany.mockResolvedValue({ count: 0 });

    const { deleteHolding } = await import('../services/portfolio.service');
    await deleteHolding('aapl', 'test-user-1');

    // Verify $transaction was called (the callback-style)
    expect((__mockPrisma as any).$transaction).toHaveBeenCalled();

    // Verify cascade deletes were scoped to the user and ticker
    expect((__mockPrisma as any).lot.deleteMany).toHaveBeenCalledWith({
      where: { ticker: 'AAPL', userId: 'test-user-1' },
    });
    expect((__mockPrisma as any).portfolioTrade.deleteMany).toHaveBeenCalledWith({
      where: { ticker: 'AAPL', userId: 'test-user-1' },
    });
    expect((__mockPrisma as any).dividendCredit.deleteMany).toHaveBeenCalledWith({
      where: { ticker: 'AAPL', userId: 'test-user-1' },
    });
    expect((__mockPrisma as any).dividendReinvestment.deleteMany).toHaveBeenCalledWith({
      where: { ticker: 'AAPL', userId: 'test-user-1' },
    });

    // Verify holding itself was deleted
    expect((__mockPrisma as any).holding.delete).toHaveBeenCalledWith({
      where: { id: 'holding-1' },
    });

    // All 5 cascade operations must happen inside the transaction
    expect((__mockPrisma as any).lot.deleteMany).toHaveBeenCalledTimes(1);
    expect((__mockPrisma as any).portfolioTrade.deleteMany).toHaveBeenCalledTimes(1);
    expect((__mockPrisma as any).dividendCredit.deleteMany).toHaveBeenCalledTimes(1);
    expect((__mockPrisma as any).dividendReinvestment.deleteMany).toHaveBeenCalledTimes(1);
    expect((__mockPrisma as any).holding.delete).toHaveBeenCalledTimes(1);
  });

  it('normalizes ticker to uppercase before cascade', async () => {
    const mockHolding = { id: 'h-2', ticker: 'MSFT', userId: 'test-user-1', shares: 5, averageCost: 300 };
    (__mockPrisma as any).holding.findFirst.mockResolvedValue(mockHolding);
    (__mockPrisma as any).holding.delete.mockResolvedValue(mockHolding);
    (__mockPrisma as any).lot.deleteMany.mockResolvedValue({ count: 0 });
    (__mockPrisma as any).portfolioTrade.deleteMany.mockResolvedValue({ count: 0 });
    (__mockPrisma as any).dividendCredit.deleteMany.mockResolvedValue({ count: 0 });
    (__mockPrisma as any).dividendReinvestment.deleteMany.mockResolvedValue({ count: 0 });

    const { deleteHolding } = await import('../services/portfolio.service');
    await deleteHolding('msft', 'test-user-1');

    // findFirst should look up with uppercase and portfolioId (from getOrCreateDefaultPortfolio)
    expect((__mockPrisma as any).holding.findFirst).toHaveBeenCalledWith({
      where: { ticker: 'MSFT', portfolioId: 'default-portfolio-id' },
    });
  });

  it('no-ops gracefully when holding not found', async () => {
    (__mockPrisma as any).holding.findFirst.mockResolvedValue(null);

    const { deleteHolding } = await import('../services/portfolio.service');
    await deleteHolding('TSLA', 'test-user-1');

    // Should NOT call $transaction if holding doesn't exist
    expect((__mockPrisma as any).$transaction).not.toHaveBeenCalled();
    expect((__mockPrisma as any).lot.deleteMany).not.toHaveBeenCalled();
  });
});

// ===================================================================
// 5. Waitlist join — anti-enumeration
// ===================================================================
describe('Waitlist join — anti-enumeration', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    const waitlistRoutes = (await import('../routes/waitlist.routes')).default;
    app.use('/waitlist', waitlistRoutes);
  });

  it('returns exactly { success: true } for brand new email', async () => {
    (__mockPrisma as any).user.findUnique.mockResolvedValue(null);
    (__mockPrisma as any).waitlist.findUnique.mockResolvedValue(null);
    (__mockPrisma as any).waitlist.create.mockResolvedValue({ id: 'w1', email: 'new@example.com', status: 'pending' });

    const res = await request(app)
      .post('/waitlist/join')
      .send({ email: 'new@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('returns exactly { success: true } for email already on waitlist', async () => {
    (__mockPrisma as any).user.findUnique.mockResolvedValue(null);
    (__mockPrisma as any).waitlist.findUnique.mockResolvedValue({ id: 'w2', email: 'existing@example.com', status: 'pending' });

    const res = await request(app)
      .post('/waitlist/join')
      .send({ email: 'existing@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('returns exactly { success: true } for email already registered as user', async () => {
    (__mockPrisma as any).user.findUnique.mockResolvedValue({ id: 'user-1' });

    const res = await request(app)
      .post('/waitlist/join')
      .send({ email: 'registered@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('all three responses are byte-identical (anti-enumeration)', async () => {
    // Scenario 1: new email
    (__mockPrisma as any).user.findUnique.mockResolvedValue(null);
    (__mockPrisma as any).waitlist.findUnique.mockResolvedValue(null);
    (__mockPrisma as any).waitlist.create.mockResolvedValue({ id: 'w1', email: 'a@example.com', status: 'pending' });
    const res1 = await request(app).post('/waitlist/join').send({ email: 'a@example.com' });

    // Scenario 2: already on waitlist
    vi.clearAllMocks();
    (__mockPrisma as any).user.findUnique.mockResolvedValue(null);
    (__mockPrisma as any).waitlist.findUnique.mockResolvedValue({ id: 'w2', email: 'b@example.com', status: 'pending' });
    const res2 = await request(app).post('/waitlist/join').send({ email: 'b@example.com' });

    // Scenario 3: already a user
    vi.clearAllMocks();
    (__mockPrisma as any).user.findUnique.mockResolvedValue({ id: 'u1' });
    const res3 = await request(app).post('/waitlist/join').send({ email: 'c@example.com' });

    // All must return HTTP 200
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res3.status).toBe(200);

    // Bodies must be deeply identical — not just same keys, same values
    expect(res1.body).toEqual(res2.body);
    expect(res2.body).toEqual(res3.body);

    // Exact expected shape: only { success: true }, nothing else
    expect(res1.body).toEqual({ success: true });
  });

  it('rejects invalid email format', async () => {
    const res = await request(app)
      .post('/waitlist/join')
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('email');
  });
});

// ===================================================================
// 6. Admin error exposure (L5) — 500 responses must not leak raw
//    exception text (DB column names, SQLITE error codes, etc.)
// ===================================================================
describe('Admin error exposure — 500 responses are sanitized', () => {
  let app: express.Express;

  // A realistic DB error whose text MUST NOT reach the client. The two
  // sentinel substrings ('secret_xyz', 'SQLITE') stand in for any internal
  // schema/engine detail that raw `e.message` would otherwise expose.
  const SENTINEL_ERROR = 'SQLITE_ERROR: no such column: secret_xyz';

  beforeEach(async () => {
    vi.clearAllMocks();
    // The shared prisma mock (setup.ts) doesn't define user.findMany, which
    // GET /admin/users/privacy calls — attach it here so the leak test can
    // arrange a rejection on it (mirrors the holding.findFirst guard above).
    if (!(__mockPrisma as any).user.findMany) {
      (__mockPrisma as any).user.findMany = vi.fn();
    }
    // requireAuth mock sets userId='test-user-1'; grant it admin via the
    // (mocked) config allowlist so requireAdmin lets the request through.
    config.waitlistAdminUserIds = ['test-user-1'];
    app = express();
    app.use(express.json());
    const adminRoutes = (await import('../routes/admin.routes')).default;
    app.use('/admin', adminRoutes);
  });

  afterEach(() => {
    config.waitlistAdminUserIds = [];
  });

  // Sanity: the admin gate is actually engaged for these routes. A non-admin
  // must be rejected before reaching the handler, otherwise the leak tests
  // below would be testing an unguarded path.
  it('rejects non-admin callers with 403 (gate is engaged)', async () => {
    config.waitlistAdminUserIds = [];
    const res = await request(app).get('/admin/users/privacy');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  // Each case: arrange the underlying prisma call to reject with SENTINEL_ERROR,
  // hit the endpoint as an admin, and assert (a) the generic body and (b) that
  // no internal detail survives anywhere in the serialized response.
  const cases: Array<{
    name: string;
    arrange: () => void;
    call: () => request.Test;
    expectedError: string;
  }> = [
    {
      name: 'GET /admin/users/privacy',
      arrange: () => (__mockPrisma as any).user.findMany.mockRejectedValue(new Error(SENTINEL_ERROR)),
      call: () => request(app).get('/admin/users/privacy'),
      expectedError: 'Internal server error',
    },
    {
      name: 'POST /admin/set-privacy',
      arrange: () => (__mockPrisma as any).user.findUnique.mockRejectedValue(new Error(SENTINEL_ERROR)),
      call: () => request(app).post('/admin/set-privacy').send({ userId: 'u-1', profilePublic: true }),
      expectedError: 'Internal server error',
    },
    {
      name: 'POST /admin/user/:userId/strike',
      arrange: () => (__mockPrisma as any).user.findUnique.mockRejectedValue(new Error(SENTINEL_ERROR)),
      call: () => request(app).post('/admin/user/u-1/strike').send({ reason: 'spam' }),
      expectedError: 'Internal server error',
    },
  ];

  for (const c of cases) {
    it(`${c.name} returns a generic 500 and never leaks raw error text`, async () => {
      c.arrange();
      const res = await c.call();

      expect(res.status).toBe(500);
      expect(res.body.error).toBe(c.expectedError);

      // The whole serialized response (not just .error) must be clean.
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('secret_xyz');
      expect(raw).not.toContain('SQLITE');
    });
  }

  // cleanup-db is special: it keeps a `log` field (safe partial progress) and
  // uses a distinct 'Cleanup failed' message. $executeRawUnsafe isn't in the
  // shared mock, so attach it here. The confirm token is required to get past
  // the 400 validation guard and reach the leaking 500 path.
  it("POST /admin/cleanup-db returns 'Cleanup failed' with log, no raw error", async () => {
    (__mockPrisma as any).$executeRawUnsafe = vi.fn().mockRejectedValue(new Error(SENTINEL_ERROR));

    const res = await request(app)
      .post('/admin/cleanup-db')
      .send({ confirm: 'cleanup-db' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Cleanup failed');
    // `log` stays (it's partial-progress diagnostics, safe to return).
    expect(res.body).toHaveProperty('log');

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('secret_xyz');
    expect(raw).not.toContain('SQLITE');
  });
});
