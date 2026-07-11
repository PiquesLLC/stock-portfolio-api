import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { generateTestToken, testUser } from './helpers';
import { __mockPrisma as prismaMock } from '../utils/prisma';

function authHeader() {
  return { Authorization: `Bearer ${generateTestToken(testUser)}` };
}

const MOCK_PORTFOLIO_ID = 'test-portfolio-id';

describe('Portfolio import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.holding.findMany.mockResolvedValue([]);
    prismaMock.portfolioTrade.findMany.mockResolvedValue([]);
    prismaMock.ledgerEvent.findMany.mockResolvedValue([]);
    prismaMock.holding.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.portfolioTrade.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.ledgerEvent.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.portfolioTrade.createMany.mockResolvedValue({ count: 0 });
    prismaMock.ledgerEvent.createMany.mockResolvedValue({ count: 0 });
    prismaMock.holding.upsert.mockResolvedValue({});
    prismaMock.userSettings.upsert.mockResolvedValue({});
    prismaMock.portfolioCompositionChange.create.mockResolvedValue({});
    // Portfolio resolution: getOrCreateDefaultPortfolio needs portfolio.findFirst
    prismaMock.portfolio.findFirst.mockResolvedValue({ id: MOCK_PORTFOLIO_ID, userId: testUser.userId, isDefault: true } as any);
    prismaMock.portfolio.create.mockResolvedValue({ id: MOCK_PORTFOLIO_ID, userId: testUser.userId, isDefault: true } as any);
    // Watermark guard uses findFirst; default to no prior trades
    (prismaMock.portfolioTrade as any).findFirst = vi.fn().mockResolvedValue(null);
    // incremental mode uses tx.holding.update/create; add missing mock methods
    (prismaMock.holding as any).update = vi.fn().mockResolvedValue({});
    (prismaMock.holding as any).create = vi.fn().mockResolvedValue({});
    // Clear: needs portfolioSnapshot + holdingSnapshot + portfolio.updateMany mocks
    (prismaMock.portfolioSnapshot as any).findMany = vi.fn().mockResolvedValue([]);
    (prismaMock.holdingSnapshot as any).deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    (prismaMock.portfolioSnapshot as any).deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    (prismaMock.portfolio as any).updateMany = vi.fn().mockResolvedValue({ count: 0 });
    // Composition change tracking
    (prismaMock.portfolioCompositionChange as any).create = vi.fn().mockResolvedValue({});
  });

  it('parses a valid CSV file', async () => {
    const csv = `ticker,shares,averageCost
AAPL,10,150
MSFT,5,320.5`;

    const res = await request(app)
      .post('/portfolio/import/csv')
      .set(authHeader())
      .attach('file', Buffer.from(csv), 'holdings.csv');

    expect(res.status).toBe(200);
    expect(res.body.parsed).toHaveLength(2);
    expect(res.body.validRows).toBe(2);
    expect(res.body.skippedRows).toBe(0);
  });

  it('rejects CSV missing required columns', async () => {
    const csv = `symbol,qty
AAPL,10`;

    const res = await request(app)
      .post('/portfolio/import/csv')
      .set(authHeader())
      .attach('file', Buffer.from(csv), 'holdings.csv');

    expect(res.status).toBe(400);
  });

  it('skips bad rows and reports warnings', async () => {
    const csv = `ticker,shares,averageCost,notes
AAPL,10,150,ok
BADTICKER,5,100,bad
MSFT,-2,320,bad
GOOG,3,0,ok`;

    const res = await request(app)
      .post('/portfolio/import/csv')
      .set(authHeader())
      .attach('file', Buffer.from(csv), 'holdings.csv');

    expect(res.status).toBe(200);
    expect(res.body.validRows).toBe(2);
    expect(res.body.skippedRows).toBe(2);
    expect(res.body.warnings.length).toBeGreaterThan(0);
  });

  it('clears portfolio with confirmation', async () => {
    prismaMock.portfolioSnapshot.findMany.mockResolvedValue([{ id: 'snap-1' }, { id: 'snap-2' }]);
    prismaMock.holding.deleteMany.mockResolvedValue({ count: 4 });
    prismaMock.portfolioTrade.deleteMany.mockResolvedValue({ count: 3 });
    prismaMock.ledgerEvent.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.holdingSnapshot.deleteMany.mockResolvedValue({ count: 6 });
    prismaMock.portfolioSnapshot.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.userSettings.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/portfolio/clear')
      .set(authHeader())
      .send({ confirmation: 'CLEAR' });

    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
    expect(res.body.holdingsRemoved).toBe(4);
    expect(res.body.tradesRemoved).toBe(3);
    expect(res.body.ledgerEventsRemoved).toBe(2);
  });

  it('rejects clear without confirmation', async () => {
    const res = await request(app)
      .post('/portfolio/clear')
      .set(authHeader())
      .send({ confirmation: 'NOPE' });

    expect(res.status).toBe(400);
  });

  describe('POST /portfolio/import/confirm incremental mode', () => {
    it('updates weighted average cost on buy', async () => {
      prismaMock.holding.findMany.mockResolvedValue([
        { ticker: 'AAPL', shares: 10, averageCost: 100 },
      ]);
      // findFirst for tx.holding.findFirst in incremental mode
      (prismaMock.holding as any).findFirst = vi.fn().mockResolvedValue({ id: 'hold-1', ticker: 'AAPL', shares: 10, averageCost: 100 });

      // Dedup check queries all trades (no ticker filter) — return empty (no prior trades)
      prismaMock.portfolioTrade.findMany.mockResolvedValue([]);

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({
          mode: 'incremental',
          trades: [
            { date: '2026-02-20', ticker: 'AAPL', type: 'buy', shares: 5, price: 200, sourceBroker: 'robinhood' },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ added: 0, updated: 1, removed: 0 });
      expect((prismaMock.holding as any).update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'hold-1' },
          data: { shares: 15, averageCost: expect.closeTo(133.3333333333, 6) },
        }),
      );
    });

    it('handles partial sell and full close', async () => {
      prismaMock.holding.findMany.mockResolvedValue([
        { ticker: 'AAPL', shares: 10, averageCost: 100 },
        { ticker: 'MSFT', shares: 2, averageCost: 300 },
      ]);
      // findFirst for tx.holding.findFirst — called for AAPL update
      (prismaMock.holding as any).findFirst = vi.fn().mockResolvedValue({ id: 'hold-aapl', ticker: 'AAPL', shares: 10, averageCost: 100 });

      // Dedup check queries all trades — return empty (no prior trades)
      prismaMock.portfolioTrade.findMany.mockResolvedValue([]);

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({
          mode: 'incremental',
          trades: [
            { date: '2026-02-20', ticker: 'AAPL', type: 'sell', shares: 4, price: 150, sourceBroker: 'robinhood' },
            { date: '2026-02-20', ticker: 'MSFT', type: 'sell', shares: 2, price: 350, sourceBroker: 'robinhood' },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ added: 0, updated: 1, removed: 1 });
      expect((prismaMock.holding as any).update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'hold-aapl' },
          data: { shares: 6, averageCost: 100 },
        }),
      );
      expect(prismaMock.holding.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { portfolioId: MOCK_PORTFOLIO_ID, ticker: 'MSFT' } }),
      );
    });

    it('skips overselling trades silently', async () => {
      prismaMock.holding.findMany.mockResolvedValue([
        { ticker: 'AAPL', shares: 1, averageCost: 100 },
      ]);
      // No prior trades for dedup
      prismaMock.portfolioTrade.findMany.mockResolvedValue([]);

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({
          mode: 'incremental',
          trades: [
            { date: '2026-02-20', ticker: 'AAPL', type: 'sell', shares: 5, price: 150, sourceBroker: 'robinhood' },
          ],
        });

      // Overselling trades are skipped (not blocked) — nothing to apply
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ added: 0, updated: 0, removed: 0, skippedDuplicates: 0 });
    });

    it('rejects overlapping trade dates with INCREMENTAL_OVERLAP', async () => {
      prismaMock.holding.findMany.mockResolvedValue([
        { ticker: 'AAPL', shares: 10, averageCost: 100 },
      ]);
      // Watermark: existing trades up to Feb 20
      (prismaMock.portfolioTrade as any).findFirst.mockResolvedValue({
        date: new Date('2026-02-20T00:00:00.000Z'),
      });

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({
          mode: 'incremental',
          trades: [
            { date: '2026-02-20', ticker: 'AAPL', type: 'buy', shares: 5, price: 200, sourceBroker: 'robinhood' },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INCREMENTAL_OVERLAP');
      expect(res.body.existingMaxDate).toBe('2026-02-20');
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('rejects mixed brokers with INCREMENTAL_MIXED_BROKERS', async () => {
      prismaMock.holding.findMany.mockResolvedValue([
        { ticker: 'AAPL', shares: 10, averageCost: 100 },
      ]);

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({
          mode: 'incremental',
          trades: [
            { date: '2026-02-20', ticker: 'AAPL', type: 'buy', shares: 5, price: 200, sourceBroker: 'robinhood' },
            { date: '2026-02-21', ticker: 'MSFT', type: 'buy', shares: 2, price: 300, sourceBroker: 'schwab' },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INCREMENTAL_MIXED_BROKERS');
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('appends trades after watermark and dedups fingerprint matches', async () => {
      prismaMock.holding.findMany.mockResolvedValue([
        { ticker: 'AAPL', shares: 10, averageCost: 100 },
      ]);
      // findFirst for tx.holding.findFirst
      (prismaMock.holding as any).findFirst = vi.fn().mockResolvedValue({ id: 'hold-aapl', ticker: 'AAPL', shares: 10, averageCost: 100 });
      // Watermark: existing trades up to Feb 19 → Feb 20+ is allowed
      (prismaMock.portfolioTrade as any).findFirst.mockResolvedValue({
        date: new Date('2026-02-19T00:00:00.000Z'),
      });
      // Dedup check: one existing trade that fingerprint-matches the first incoming
      prismaMock.portfolioTrade.findMany.mockResolvedValue([
        {
          date: new Date('2026-02-20T00:00:00.000Z'),
          ticker: 'AAPL',
          type: 'buy',
          shares: 1,
          price: 100,
          sourceBroker: 'robinhood',
        },
      ]);
      prismaMock.ledgerEvent.findMany.mockResolvedValue([
        {
          effectiveDate: new Date('2026-02-20T00:00:00.000Z'),
          eventType: 'CASH_DIVIDEND',
          ticker: 'AAPL',
          amount: 12.5,
          sourceBroker: 'robinhood',
        },
      ]);

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({
          mode: 'incremental',
          trades: [
            { date: '2026-02-20', ticker: 'AAPL', type: 'buy', shares: 1, price: 100, sourceBroker: 'robinhood' }, // fingerprint dup
            { date: '2026-02-21', ticker: 'AAPL', type: 'buy', shares: 2, price: 120, sourceBroker: 'robinhood' }, // new
          ],
          ledgerEvents: [
            { effectiveDate: '2026-02-20', eventType: 'CASH_DIVIDEND', ticker: 'AAPL', amount: 12.5, sourceBroker: 'robinhood' }, // dup
            { effectiveDate: '2026-02-21', eventType: 'DIV_REINVEST', ticker: 'AAPL', shares: 0.2, amount: 0, sourceBroker: 'robinhood' }, // new
          ],
        });

      expect(res.status).toBe(200);
      expect(prismaMock.portfolioTrade.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ ticker: 'AAPL', shares: 2, price: 120 }),
          ]),
        }),
      );
      expect(prismaMock.ledgerEvent.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ eventType: 'DIV_REINVEST', ticker: 'AAPL', amount: 0 }),
          ]),
        }),
      );
    });
  });

  describe('POST /portfolio/import/confirm mode regression', () => {
    it('replace deletes existing holdings before write (preserves trades/ledger)', async () => {
      prismaMock.holding.findMany.mockResolvedValue([
        { ticker: 'AAPL', shares: 1, averageCost: 100 },
      ]);
      // findFirst returns null (new ticker after delete) for MSFT
      (prismaMock.holding as any).findFirst = vi.fn().mockResolvedValue(null);

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({
          mode: 'replace',
          holdings: [{ ticker: 'MSFT', shares: 2, averageCost: 300 }],
        });

      expect(res.status).toBe(200);
      expect(prismaMock.holding.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { portfolioId: MOCK_PORTFOLIO_ID } }),
      );
      // Replace mode uses dedup instead of deleting trades/ledger
      expect(prismaMock.portfolioTrade.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.ledgerEvent.deleteMany).not.toHaveBeenCalled();
      // Replace+merge now uses findFirst+create/update instead of upsert
      expect((prismaMock.holding as any).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ticker: 'MSFT', shares: 2, averageCost: 300 }),
        }),
      );
    });

    it('merge upserts without wiping existing records', async () => {
      prismaMock.holding.findMany.mockResolvedValue([
        { ticker: 'AAPL', shares: 1, averageCost: 100 },
      ]);
      // findFirst: AAPL exists, MSFT doesn't
      (prismaMock.holding as any).findFirst = vi.fn()
        .mockImplementation(({ where }: any) => {
          if (where.ticker === 'AAPL') return Promise.resolve({ id: 'hold-aapl', ticker: 'AAPL' });
          return Promise.resolve(null);
        });

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({
          mode: 'merge',
          holdings: [
            { ticker: 'AAPL', shares: 5, averageCost: 150 },
            { ticker: 'MSFT', shares: 2, averageCost: 300 },
          ],
        });

      expect(res.status).toBe(200);
      // Merge mode must NOT wipe the portfolio (deleteMany with portfolioId).
      // Note: deleteDuplicateOrphanedHoldings may call deleteMany for orphan cleanup,
      // so we check it wasn't called with the portfolio-wipe args specifically.
      expect(prismaMock.holding.deleteMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { portfolioId: MOCK_PORTFOLIO_ID } }),
      );
      expect(prismaMock.portfolioTrade.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.ledgerEvent.deleteMany).not.toHaveBeenCalled();
      // AAPL: findFirst returns existing → update; MSFT: findFirst returns null → create
      expect((prismaMock.holding as any).update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ shares: 5, averageCost: 150 }) }),
      );
      expect((prismaMock.holding as any).create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ticker: 'MSFT', shares: 2, averageCost: 300 }) }),
      );
    });
  });

  describe('POST /portfolio/import/confirm — flow compensation & validation', () => {
    it('records a compensating deposit for injected cost basis', async () => {
      (prismaMock as any).transaction.create.mockClear();
      // Call order: orphan-dedup scan (getOrCreateDefaultPortfolio) →
      // existingHoldings (pre-tx) → beforeRows (in-tx) → afterRows (in-tx)
      prismaMock.holding.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ ticker: 'AMZN', shares: 100, averageCost: 200 }]);
      (prismaMock.holding as any).findFirst = vi.fn().mockResolvedValue(null);

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({ mode: 'replace', holdings: [{ ticker: 'AMZN', shares: 100, averageCost: 200 }] });

      expect(res.status).toBe(200);
      expect((prismaMock as any).transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: 'deposit', amount: 20000 }) }),
      );
    });

    it('records a withdrawal when the import shrinks cost basis', async () => {
      (prismaMock as any).transaction.create.mockClear();
      // orphan scan → existingHoldings → beforeRows → afterRows
      prismaMock.holding.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ ticker: 'AAPL', shares: 100, averageCost: 500 }])
        .mockResolvedValueOnce([{ ticker: 'AAPL', shares: 100, averageCost: 500 }])
        .mockResolvedValueOnce([{ ticker: 'AAPL', shares: 10, averageCost: 500 }]);
      (prismaMock.holding as any).findFirst = vi.fn().mockResolvedValue(null);

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({ mode: 'replace', holdings: [{ ticker: 'AAPL', shares: 10, averageCost: 500 }] });

      expect(res.status).toBe(200);
      expect((prismaMock as any).transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: 'withdrawal', amount: 45000 }) }),
      );
    });

    it('records no Transaction when cost basis is unchanged', async () => {
      (prismaMock as any).transaction.create.mockClear();
      // Same holdings before and after — merge of an identical position
      prismaMock.holding.findMany.mockResolvedValue([{ ticker: 'AAPL', shares: 10, averageCost: 100 }]);
      (prismaMock.holding as any).findFirst = vi.fn().mockResolvedValue({ id: 'hold-1', ticker: 'AAPL', shares: 10, averageCost: 100 });

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({ mode: 'merge', holdings: [{ ticker: 'AAPL', shares: 10, averageCost: 100 }] });

      expect(res.status).toBe(200);
      expect((prismaMock as any).transaction.create).not.toHaveBeenCalled();
    });

    it('rejects non-finite shares', async () => {
      prismaMock.holding.findMany.mockResolvedValue([]);

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({ mode: 'replace', holdings: [{ ticker: 'AAPL', shares: 'Infinity', averageCost: 1 }] });

      expect(res.status).toBe(400);
    });

    it('aggregates duplicate tickers into one weighted-average position', async () => {
      prismaMock.holding.findMany.mockResolvedValue([]);
      (prismaMock.holding as any).findFirst = vi.fn().mockResolvedValue(null);
      (prismaMock.holding as any).create.mockClear();

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({
          mode: 'replace',
          holdings: [
            { ticker: 'AAPL', shares: 10, averageCost: 100 },
            { ticker: 'AAPL', shares: 30, averageCost: 200 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.added).toBe(1);
      expect((prismaMock.holding as any).create).toHaveBeenCalledTimes(1);
      expect((prismaMock.holding as any).create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ticker: 'AAPL', shares: 40, averageCost: 175 }) }),
      );
    });

    it('enforces the free-plan 10-holding cap on import', async () => {
      prismaMock.holding.findMany.mockResolvedValue([]);
      (prismaMock.holding as any).findFirst = vi.fn().mockResolvedValue(null);
      prismaMock.user.findUnique.mockResolvedValueOnce({ plan: 'free' } as any);
      (prismaMock.holding as any).count.mockResolvedValueOnce(11);

      const tickers = ['TA', 'TB', 'TC', 'TD', 'TE', 'TF', 'TG', 'TH', 'TI', 'TJ', 'TK'];
      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({ mode: 'replace', holdings: tickers.map(t => ({ ticker: t, shares: 1, averageCost: 1 })) });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('limit_reached');
    });
  });
});
