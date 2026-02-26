import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { generateTestToken, testUser } from './helpers';
import { __mockPrisma as prismaMock } from '../utils/prisma';

function authHeader() {
  return { Authorization: `Bearer ${generateTestToken(testUser)}` };
}

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
    // incremental mode uses tx.holding.update/create; add missing mock methods
    (prismaMock.holding as any).update = vi.fn().mockResolvedValue({});
    (prismaMock.holding as any).create = vi.fn().mockResolvedValue({});
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
          where: { userId_ticker: { userId: testUser.userId, ticker: 'AAPL' } },
          data: { shares: 15, averageCost: expect.closeTo(133.3333333333, 6) },
        }),
      );
    });

    it('handles partial sell and full close', async () => {
      prismaMock.holding.findMany.mockResolvedValue([
        { ticker: 'AAPL', shares: 10, averageCost: 100 },
        { ticker: 'MSFT', shares: 2, averageCost: 300 },
      ]);

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
          where: { userId_ticker: { userId: testUser.userId, ticker: 'AAPL' } },
          data: { shares: 6, averageCost: 100 },
        }),
      );
      expect(prismaMock.holding.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: testUser.userId, ticker: 'MSFT' } }),
      );
    });

    it('clamps oversell to zero and deletes holding', async () => {
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

      // Oversell is clamped to 0 (historical trade — already happened)
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ added: 0, updated: 0, removed: 1 });
      expect(prismaMock.holding.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: testUser.userId, ticker: 'AAPL' } }),
      );
    });

    it('dedups replayed trades and returns skippedDuplicates without mutation', async () => {
      prismaMock.holding.findMany.mockResolvedValue([
        { ticker: 'AAPL', shares: 10, averageCost: 100 },
      ]);
      prismaMock.portfolioTrade.findMany.mockResolvedValue([
        {
          date: new Date('2026-02-20T00:00:00.000Z'),
          ticker: 'AAPL',
          type: 'buy',
          shares: 5,
          price: 200,
          sourceBroker: 'robinhood',
        },
      ]);

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
      expect(res.body).toEqual({ added: 0, updated: 0, removed: 0, skippedDuplicates: 1 });
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('appends only non-duplicate trade + ledger events', async () => {
      prismaMock.holding.findMany.mockResolvedValue([
        { ticker: 'AAPL', shares: 10, averageCost: 100 },
      ]);
      // Dedup check: return existing trade (the duplicate one)
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
            { date: '2026-02-20', ticker: 'AAPL', type: 'buy', shares: 1, price: 100, sourceBroker: 'robinhood' }, // duplicate
            { date: '2026-02-21', ticker: 'AAPL', type: 'buy', shares: 2, price: 120, sourceBroker: 'robinhood' }, // new
          ],
          ledgerEvents: [
            { effectiveDate: '2026-02-20', eventType: 'CASH_DIVIDEND', ticker: 'AAPL', amount: 12.5, sourceBroker: 'robinhood' }, // duplicate
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

      const res = await request(app)
        .post('/portfolio/import/confirm')
        .set(authHeader())
        .send({
          mode: 'replace',
          holdings: [{ ticker: 'MSFT', shares: 2, averageCost: 300 }],
        });

      expect(res.status).toBe(200);
      expect(prismaMock.holding.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: testUser.userId } }),
      );
      // Replace mode uses dedup instead of deleting trades/ledger
      expect(prismaMock.portfolioTrade.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.ledgerEvent.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.holding.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { userId_ticker: { userId: testUser.userId, ticker: 'MSFT' } },
      }));
    });

    it('merge upserts without wiping existing records', async () => {
      prismaMock.holding.findMany.mockResolvedValue([
        { ticker: 'AAPL', shares: 1, averageCost: 100 },
      ]);

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
      expect(prismaMock.holding.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.portfolioTrade.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.ledgerEvent.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.holding.upsert).toHaveBeenCalledTimes(2);
    });
  });
});
