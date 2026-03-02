import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { generateTestToken, testUser } from './helpers';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// Mock rate limiters
vi.mock('../middleware/rateLimiter', async () => {
  const actual = await vi.importActual<typeof import('../middleware/rateLimiter')>('../middleware/rateLimiter');
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    ...actual,
    loginLimiter: passthrough,
    signupLimiter: passthrough,
    generalLimiter: passthrough,
    mutationLimiter: passthrough,
    chartLimiter: passthrough,
    importLimiter: passthrough,
    mfaVerifyLimiter: passthrough,
    mfaSendLimiter: passthrough,
    setPasswordLimiter: passthrough,
    heavyReadLimiter: passthrough,
    apiLimiter: passthrough,
    oauthLimiter: passthrough,
    waitlistJoinLimiter: passthrough,
  };
});

// Mock email verification middleware
vi.mock('../middleware/email-verification.middleware', () => ({
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
}));

// Mock portfolio service (upsertHolding is called by confirm handler)
vi.mock('../services/portfolio.service', async () => {
  const actual = await vi.importActual<typeof import('../services/portfolio.service')>('../services/portfolio.service');
  return {
    ...actual,
    upsertHolding: vi.fn().mockResolvedValue({}),
    getHoldings: vi.fn().mockResolvedValue([]),
  };
});

// Mock snapshot service (composition change tracking)
vi.mock('../services/snapshot.service', async () => {
  const actual = await vi.importActual<typeof import('../services/snapshot.service')>('../services/snapshot.service');
  return {
    ...actual,
    recordCompositionChange: vi.fn().mockResolvedValue({}),
    resetSnapshotsForCompositionChange: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock Sentry
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  Handlers: { requestHandler: () => (_req: any, _res: any, next: any) => next(), errorHandler: () => (_err: any, _req: any, _res: any, next: any) => next() },
  captureException: vi.fn(),
  setUser: vi.fn(),
  startSpan: vi.fn((_: any, cb: any) => cb({})),
}));

describe('Deterministic trade replay', () => {
  const token = generateTestToken(testUser);

  beforeEach(() => {
    vi.clearAllMocks();

    // Base user mock
    (prismaMock as any).user.findUnique.mockResolvedValue({
      id: testUser.userId,
      username: testUser.username,
      plan: 'free',
      profilePublic: true,
    });
  });

  describe('CSV parser rowIndex', () => {
    it('emits sequential rowIndex for each trade in chronological order', async () => {
      const app = (await import('../app')).default;

      // Same-day mixed transactions CSV
      const csv = [
        'Activity Date,Trans Code,Instrument,Quantity,Price,Amount',
        '02/10/2026,Buy,XYZ,10,$100.00,$1000.00',
        '02/10/2026,Sell,XYZ,5,$110.00,$550.00',
        '02/10/2026,Buy,XYZ,3,$120.00,$360.00',
        '02/10/2026,Buy,ABC,20,$50.00,$1000.00',
      ].join('\n');

      const res = await request(app)
        .post('/portfolio/import/csv')
        .set('Cookie', `authToken=${token}`)
        .attach('file', Buffer.from(csv), 'trades.csv');

      expect(res.status).toBe(200);
      expect(res.body.trades).toBeDefined();
      expect(res.body.trades).toHaveLength(4);

      // Robinhood CSVs are newest-first, reversed to chronological during parse.
      // Since all are same date, rowIndex determines replay order.
      // After reversal: ABC Buy(row0), XYZ Buy(row1), XYZ Sell(row2), XYZ Buy(row3)
      const rowIndices = res.body.trades.map((t: any) => t.rowIndex);
      expect(rowIndices).toEqual([0, 1, 2, 3]);

      // Verify each trade has a rowIndex
      for (const trade of res.body.trades) {
        expect(typeof trade.rowIndex).toBe('number');
        expect(trade.rowIndex).toBeGreaterThanOrEqual(0);
      }
    });

    it('produces correct end-of-day position for same-day ordering fixture', async () => {
      const app = (await import('../app')).default;

      // Codex fixture: Buy 10, Sell 5, Buy 3 on same day = 8 shares
      const csv = [
        'Activity Date,Trans Code,Instrument,Quantity,Price,Amount',
        '02/10/2026,Buy,XYZ,3,$120.00,$360.00',   // newest first (Robinhood order)
        '02/10/2026,Sell,XYZ,5,$110.00,$550.00',
        '02/10/2026,Buy,XYZ,10,$100.00,$1000.00',  // oldest first after reversal
      ].join('\n');

      const res = await request(app)
        .post('/portfolio/import/csv')
        .set('Cookie', `authToken=${token}`)
        .attach('file', Buffer.from(csv), 'trades.csv');

      expect(res.status).toBe(200);

      // After chronological reversal: Buy 10@100, Sell 5@110, Buy 3@120
      // End position: 10 - 5 + 3 = 8 shares
      const xyzHolding = res.body.parsed.find((h: any) => h.ticker === 'XYZ');
      expect(xyzHolding).toBeDefined();
      expect(xyzHolding.shares).toBe(8);

      // Avg cost: Buy 10@100 = $1000, Sell 5 (avg was $100), remaining 5@$100 = $500
      // Then Buy 3@120 = $360, total cost = $500 + $360 = $860, shares = 8
      // Avg = $860/8 = $107.50
      expect(xyzHolding.averageCost).toBeCloseTo(107.5, 1);
    });
  });

  describe('Confirm handler sourceFileId', () => {
    it('persists trades with sourceFileId and rowIndex on confirm', async () => {
      const app = (await import('../app')).default;

      // Mock prisma operations used by confirm handler
      (prismaMock as any).holding.findMany.mockResolvedValue([]);
      (prismaMock as any).holding.deleteMany.mockResolvedValue({ count: 0 });
      (prismaMock as any).holding.upsert.mockResolvedValue({});
      (prismaMock as any).portfolioTrade.findMany.mockResolvedValue([]);
      (prismaMock as any).portfolioTrade.deleteMany.mockResolvedValue({ count: 0 });
      (prismaMock as any).portfolioTrade.createMany.mockResolvedValue({ count: 3 });
      (prismaMock as any).portfolioCompositionChange.create.mockResolvedValue({});
      (prismaMock as any).userSettings.upsert.mockResolvedValue({});

      const trades = [
        { date: '02/10/2026', ticker: 'XYZ', type: 'buy', shares: 10, price: 100, rowIndex: 0 },
        { date: '02/10/2026', ticker: 'XYZ', type: 'sell', shares: 5, price: 110, rowIndex: 1 },
        { date: '02/10/2026', ticker: 'XYZ', type: 'buy', shares: 3, price: 120, rowIndex: 2 },
      ];

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set('Cookie', `authToken=${token}`)
        .send({
          holdings: [{ ticker: 'XYZ', shares: 8, averageCost: 107.5 }],
          mode: 'replace',
          trades,
        });

      expect(res.status).toBe(200);

      // Verify createMany was called with sourceFileId and rowIndex
      expect(prismaMock.portfolioTrade.createMany).toHaveBeenCalledTimes(1);
      const createCall = (prismaMock.portfolioTrade.createMany as any).mock.calls[0][0];
      const records = createCall.data;

      expect(records).toHaveLength(3);

      // All records share the same sourceFileId (UUID)
      const sourceFileIds = new Set(records.map((r: any) => r.sourceFileId));
      expect(sourceFileIds.size).toBe(1);
      const sourceFileId = records[0].sourceFileId;
      expect(sourceFileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      // rowIndex preserved from input
      expect(records.map((r: any) => r.rowIndex)).toEqual([0, 1, 2]);

      // Tickers normalized to uppercase
      expect(records.every((r: any) => r.ticker === 'XYZ')).toBe(true);
    });

    it('generates different sourceFileId for each import batch', async () => {
      const app = (await import('../app')).default;

      (prismaMock as any).holding.findMany.mockResolvedValue([]);
      (prismaMock as any).holding.deleteMany.mockResolvedValue({ count: 0 });
      (prismaMock as any).holding.upsert.mockResolvedValue({});
      (prismaMock as any).portfolioTrade.findMany.mockResolvedValue([]);
      (prismaMock as any).portfolioTrade.deleteMany.mockResolvedValue({ count: 0 });
      (prismaMock as any).portfolioTrade.createMany.mockResolvedValue({ count: 1 });
      (prismaMock as any).portfolioCompositionChange.create.mockResolvedValue({});
      (prismaMock as any).userSettings.upsert.mockResolvedValue({});

      const payload = {
        holdings: [{ ticker: 'AAPL', shares: 10, averageCost: 200 }],
        mode: 'replace' as const,
        trades: [{ date: '02/10/2026', ticker: 'AAPL', type: 'buy', shares: 10, price: 200, rowIndex: 0 }],
      };

      // First import
      await request(app)
        .post('/portfolio/import/confirm')
        .set('Cookie', `authToken=${token}`)
        .send(payload);

      // Second import
      await request(app)
        .post('/portfolio/import/confirm')
        .set('Cookie', `authToken=${token}`)
        .send(payload);

      expect(prismaMock.portfolioTrade.createMany).toHaveBeenCalledTimes(2);
      const batch1 = (prismaMock.portfolioTrade.createMany as any).mock.calls[0][0].data;
      const batch2 = (prismaMock.portfolioTrade.createMany as any).mock.calls[1][0].data;

      expect(batch1[0].sourceFileId).not.toBe(batch2[0].sourceFileId);
    });
  });
});
