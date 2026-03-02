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

vi.mock('../middleware/email-verification.middleware', () => ({
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../services/portfolio.service', async () => {
  const actual = await vi.importActual<typeof import('../services/portfolio.service')>('../services/portfolio.service');
  return { ...actual, upsertHolding: vi.fn().mockResolvedValue({}), getHoldings: vi.fn().mockResolvedValue([]) };
});

vi.mock('../services/snapshot.service', async () => {
  const actual = await vi.importActual<typeof import('../services/snapshot.service')>('../services/snapshot.service');
  return { ...actual, recordCompositionChange: vi.fn().mockResolvedValue({}), resetSnapshotsForCompositionChange: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  Handlers: { requestHandler: () => (_req: any, _res: any, next: any) => next(), errorHandler: () => (_err: any, _req: any, _res: any, next: any) => next() },
  captureException: vi.fn(),
  setUser: vi.fn(),
  startSpan: vi.fn((_: any, cb: any) => cb({})),
}));

describe('POST /portfolio/import/csv/mapped', () => {
  const token = generateTestToken(testUser);

  beforeEach(() => {
    vi.clearAllMocks();
    (prismaMock as any).user.findUnique.mockResolvedValue({
      id: testUser.userId, username: testUser.username, plan: 'free', profilePublic: true,
    });
  });

  function makeCsv(rows: string[]): Buffer {
    return Buffer.from(rows.join('\n'));
  }

  it('basic mapping: ticker + shares + price produces positions', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv([
      'Symbol,Shares,Price,Action',
      'AAPL,10,150.00,Buy',
      'MSFT,20,400.00,Buy',
    ]);

    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ ticker: 'Symbol', shares: 'Shares', price: 'Price', action: 'Action' }))
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(200);
    expect(res.body.parsed).toHaveLength(2);

    const byTicker = Object.fromEntries(res.body.parsed.map((p: any) => [p.ticker, p]));
    expect(byTicker['AAPL'].shares).toBe(10);
    expect(byTicker['AAPL'].averageCost).toBe(150);
    expect(byTicker['MSFT'].shares).toBe(20);
    expect(byTicker['MSFT'].averageCost).toBe(400);
  });

  it('action inference: buy/sell correctly categorized', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv([
      'Ticker,Qty,Cost,Type',
      'AAPL,10,150.00,Purchase',
      'AAPL,5,160.00,Sold',
    ]);

    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ ticker: 'Ticker', shares: 'Qty', price: 'Cost', action: 'Type' }))
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(200);
    expect(res.body.trades).toHaveLength(2);
    expect(res.body.trades[0].type).toBe('buy');
    expect(res.body.trades[1].type).toBe('sell');

    // AAPL: buy 10@150, sell 5 = 5 shares remaining
    const aapl = res.body.parsed.find((p: any) => p.ticker === 'AAPL');
    expect(aapl.shares).toBe(5);
    expect(aapl.averageCost).toBe(150);
  });

  it('derives price from totalAmount / shares', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv([
      'Stock,Count,Total,Action',
      'GOOG,5,$900.00,Buy',
    ]);

    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ ticker: 'Stock', shares: 'Count', totalAmount: 'Total', action: 'Action' }))
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(200);
    const goog = res.body.parsed.find((p: any) => p.ticker === 'GOOG');
    expect(goog.shares).toBe(5);
    expect(goog.averageCost).toBe(180); // 900/5
  });

  it('derives shares from totalAmount / price', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv([
      'Symbol,UnitPrice,Total,Type',
      'TSLA,250.00,$2500.00,Buy',
    ]);

    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ ticker: 'Symbol', price: 'UnitPrice', totalAmount: 'Total', action: 'Type' }))
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(200);
    const tsla = res.body.parsed.find((p: any) => p.ticker === 'TSLA');
    expect(tsla.shares).toBe(10); // 2500/250
  });

  it('excludedRows filters out specific rows', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv([
      'Ticker,Shares,Price,Action',
      'AAPL,10,150,Buy',
      'MSFT,20,400,Buy',
      'GOOG,5,180,Buy',
    ]);

    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ ticker: 'Ticker', shares: 'Shares', price: 'Price', action: 'Action' }))
      .field('excludedRows', JSON.stringify([1])) // Exclude MSFT (index 1)
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(200);
    expect(res.body.parsed).toHaveLength(2);
    const tickers = res.body.parsed.map((p: any) => p.ticker);
    expect(tickers).toContain('AAPL');
    expect(tickers).toContain('GOOG');
    expect(tickers).not.toContain('MSFT');

    expect(res.body.telemetry.skipReasons.excluded_by_user).toBe(1);
  });

  it('unsupported actions are skipped with telemetry', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv([
      'Ticker,Shares,Price,Action',
      'AAPL,10,150,Buy',
      'AAPL,0,0,Dividend',
      'MSFT,0,0,Fee Charged',
    ]);

    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ ticker: 'Ticker', shares: 'Shares', price: 'Price', action: 'Action' }))
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(200);
    expect(res.body.trades).toHaveLength(1); // Only the Buy
    expect(res.body.telemetry.skipReasons.unsupported_action).toBe(2);
  });

  it('invalid ticker rows are skipped with telemetry', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv([
      'Ticker,Shares,Price,Action',
      'AAPL,10,150,Buy',
      'TOOLONGSYMBOL,5,100,Buy',
      ',5,100,Buy',
    ]);

    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ ticker: 'Ticker', shares: 'Shares', price: 'Price', action: 'Action' }))
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(200);
    expect(res.body.trades).toHaveLength(1);
    expect(res.body.telemetry.skipReasons.invalid_ticker).toBe(2);
  });

  it('invalid dates are skipped with telemetry', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv([
      'Ticker,Date,Shares,Price,Action',
      'AAPL,02/10/2026,10,150,Buy',
      'MSFT,not-a-date,20,400,Buy',
    ]);

    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ ticker: 'Ticker', date: 'Date', shares: 'Shares', price: 'Price', action: 'Action' }))
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(200);
    expect(res.body.trades).toHaveLength(1);
    expect(res.body.telemetry.skipReasons.invalid_date).toBe(1);
  });

  it('missing numeric fields are skipped with telemetry', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv([
      'Ticker,Action',
      'AAPL,Buy',
      'MSFT,Buy',
    ]);

    // Only ticker + action mapped, no price/shares/amount
    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ ticker: 'Ticker', action: 'Action', price: 'Price' }))
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(200);
    expect(res.body.trades).toHaveLength(0);
    expect(res.body.telemetry.skipReasons.missing_numeric).toBe(2);
  });

  it('telemetry includes all required fields', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv([
      'Ticker,Shares,Price,Action',
      'AAPL,10,150,Buy',
    ]);

    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ ticker: 'Ticker', shares: 'Shares', price: 'Price', action: 'Action' }))
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(200);
    const t = res.body.telemetry;
    expect(t.rowsParsed).toBe(1);
    expect(typeof t.rowsSkipped).toBe('number');
    expect(typeof t.skipReasons).toBe('object');
    expect(t.brokerDetected).toBe('mapped');
    expect(typeof t.parseDurationMs).toBe('number');
    expect(t.parseDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('sourceBroker and rawAction are present on trade objects', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv([
      'Symbol,Qty,Price,Type',
      'AAPL,10,150,Purchase Stock',
    ]);

    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ ticker: 'Symbol', shares: 'Qty', price: 'Price', action: 'Type' }))
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(200);
    expect(res.body.trades[0].sourceBroker).toBe('mapped');
    expect(res.body.trades[0].rawAction).toBe('Purchase Stock');
  });

  it('rejects missing ticker mapping', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv(['A,B', '1,2']);

    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ shares: 'A', price: 'B' }))
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('ticker');
  });

  it('rejects missing numeric mapping', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv(['Ticker,Action', 'AAPL,Buy']);

    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ ticker: 'Ticker', action: 'Action' }))
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('price');
  });

  it('handles malformed numeric formats ($1,234.56, parenthetical negatives)', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv([
      'Ticker,Shares,Price,Action',
      'AAPL,10,"$1,234.56",Buy',
      'MSFT,5,"($500.00)",Buy',
    ]);

    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ ticker: 'Ticker', shares: 'Shares', price: 'Price', action: 'Action' }))
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(200);
    // AAPL: 10 shares @ $1,234.56
    const aapl = res.body.parsed.find((p: any) => p.ticker === 'AAPL');
    expect(aapl.shares).toBe(10);
    expect(aapl.averageCost).toBe(1234.56);

    // MSFT: parenthetical negative price → treated as absolute value
    // parseNumber('($500.00)') = -500, but price is used as absolute in buy
    const msft = res.body.parsed.find((p: any) => p.ticker === 'MSFT');
    expect(msft).toBeDefined();
  });

  it('auto-detects newest-first ordering and reverses', async () => {
    const app = (await import('../app')).default;
    const csv = makeCsv([
      'Ticker,Date,Shares,Price,Action',
      'AAPL,02/10/2026,3,155,Buy',
      'AAPL,02/05/2026,5,160,Sell',
      'AAPL,01/15/2026,10,150,Buy',
    ]);

    const res = await request(app)
      .post('/portfolio/import/csv/mapped')
      .set('Cookie', `authToken=${token}`)
      .field('mappings', JSON.stringify({ ticker: 'Ticker', date: 'Date', shares: 'Shares', price: 'Price', action: 'Action' }))
      .attach('file', csv, 'trades.csv');

    expect(res.status).toBe(200);
    // After reversal: Buy 10@150, Sell 5, Buy 3@155 = 8 shares
    const aapl = res.body.parsed.find((p: any) => p.ticker === 'AAPL');
    expect(aapl.shares).toBe(8);
    expect(aapl.averageCost).toBeCloseTo(151.88, 1);
  });
});
