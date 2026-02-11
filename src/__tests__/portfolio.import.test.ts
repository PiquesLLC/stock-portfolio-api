import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { generateTestToken, testUser } from './helpers';
import { __mockPrisma as prismaMock } from '../utils/prisma';

function authHeader() {
  return { Authorization: `Bearer ${generateTestToken(testUser)}` };
}

describe('Portfolio import', () => {
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
    prismaMock.holding.deleteMany.mockResolvedValue({ count: 4 });
    prismaMock.userSettings.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/portfolio/clear')
      .set(authHeader())
      .send({ confirmation: 'CLEAR' });

    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
    expect(res.body.holdingsRemoved).toBe(4);
  });

  it('rejects clear without confirmation', async () => {
    const res = await request(app)
      .post('/portfolio/clear')
      .set(authHeader())
      .send({ confirmation: 'NOPE' });

    expect(res.status).toBe(400);
  });
});
