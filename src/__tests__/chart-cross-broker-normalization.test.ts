import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { generateTestToken, testUser } from './helpers';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// Mock rate limiters — auto-passthrough for all exports
vi.mock('../middleware/rateLimiter', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const passthrough = (_req: any, _res: any, next: any) => next();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? passthrough : v]),
  );
});

// Mock email verification middleware
vi.mock('../middleware/email-verification.middleware', () => ({
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
}));

// Mock portfolio service
vi.mock('../services/portfolio.service', async () => {
  const actual = await vi.importActual<typeof import('../services/portfolio.service')>('../services/portfolio.service');
  return {
    ...actual,
    upsertHolding: vi.fn().mockResolvedValue({}),
    getHoldings: vi.fn().mockResolvedValue([]),
  };
});

// Mock snapshot service
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

/**
 * Cross-broker normalization test suite.
 *
 * Fixture: 5-trade history representing the same portfolio activity:
 *   1. Buy 10 AAPL @ $150  (01/15/2026)
 *   2. Buy 20 MSFT @ $400  (01/20/2026)
 *   3. Buy 5 GOOG @ $180   (02/01/2026)
 *   4. Sell 5 AAPL @ $160   (02/05/2026)
 *   5. Buy 3 AAPL @ $155    (02/10/2026)
 *
 * Expected end state:
 *   AAPL: 8 shares, avg cost = (10*150 - 5*150 + 3*155) / 8 = (1500 - 750 + 465) / 8 = $151.875
 *   MSFT: 20 shares, avg cost = $400.00
 *   GOOG: 5 shares, avg cost = $180.00
 */
describe('Cross-broker normalization', () => {
  const token = generateTestToken(testUser);

  beforeEach(() => {
    vi.clearAllMocks();

    (prismaMock as any).user.findUnique.mockResolvedValue({
      id: testUser.userId,
      username: testUser.username,
      plan: 'free',
      profilePublic: true,
    });
  });

  // Robinhood CSV: newest-first, Trans Code column
  const robinhoodCsv = [
    'Activity Date,Trans Code,Instrument,Quantity,Price,Amount',
    '02/10/2026,Buy,AAPL,3,$155.00,$465.00',        // newest first
    '02/05/2026,Sell,AAPL,5,$160.00,$800.00',
    '02/01/2026,Buy,GOOG,5,$180.00,$900.00',
    '01/20/2026,Buy,MSFT,20,$400.00,$8000.00',
    '01/15/2026,Buy,AAPL,10,$150.00,$1500.00',       // oldest last
  ].join('\n');

  // Schwab CSV: newest-first, Action column, quoted fields
  const schwabCsv = [
    '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"',
    '"02/10/2026","Buy","AAPL","APPLE INC","3","$155.00","$0.00","$465.00"',
    '"02/05/2026","Sell","AAPL","APPLE INC","5","$160.00","$0.00","$800.00"',
    '"02/01/2026","Buy","GOOG","ALPHABET INC CL C","5","$180.00","$0.00","$900.00"',
    '"01/20/2026","Buy","MSFT","MICROSOFT CORP","20","$400.00","$0.00","$8000.00"',
    '"01/15/2026","Buy","AAPL","APPLE INC","10","$150.00","$0.00","$1500.00"',
  ].join('\n');

  // Schwab CSV with account header line (real-world format)
  const schwabCsvWithHeader = [
    '"Transactions  for account XXXX-1234 as of 02/22/2026"',
    '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"',
    '"02/10/2026","Buy","AAPL","APPLE INC","3","$155.00","$0.00","$465.00"',
    '"02/05/2026","Sell","AAPL","APPLE INC","5","$160.00","$0.00","$800.00"',
    '"02/01/2026","Buy","GOOG","ALPHABET INC CL C","5","$180.00","$0.00","$900.00"',
    '"01/20/2026","Buy","MSFT","MICROSOFT CORP","20","$400.00","$0.00","$8000.00"',
    '"01/15/2026","Buy","AAPL","APPLE INC","10","$150.00","$0.00","$1500.00"',
    '"Transactions Total","","","","","","","$11665.00"',
  ].join('\n');

  it('Robinhood and Schwab produce identical canonical trade types', async () => {
    const app = (await import('../app')).default;

    const robinhoodRes = await request(app)
      .post('/portfolio/import/csv')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `authToken=${token}`)
      .attach('file', Buffer.from(robinhoodCsv), 'robinhood.csv');

    const schwabRes = await request(app)
      .post('/portfolio/import/csv')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `authToken=${token}`)
      .attach('file', Buffer.from(schwabCsv), 'schwab.csv');

    expect(robinhoodRes.status).toBe(200);
    expect(schwabRes.status).toBe(200);

    const rhTrades = robinhoodRes.body.trades;
    const schTrades = schwabRes.body.trades;

    expect(rhTrades).toHaveLength(5);
    expect(schTrades).toHaveLength(5);

    // Both should produce identical canonical trade sequence (after chronological reversal)
    for (let i = 0; i < 5; i++) {
      expect(rhTrades[i].ticker).toBe(schTrades[i].ticker);
      expect(rhTrades[i].type).toBe(schTrades[i].type);
      expect(rhTrades[i].shares).toBe(schTrades[i].shares);
      expect(rhTrades[i].price).toBe(schTrades[i].price);
      expect(rhTrades[i].rowIndex).toBe(schTrades[i].rowIndex);
    }
  });

  it('both brokers produce identical end positions', async () => {
    const app = (await import('../app')).default;

    const robinhoodRes = await request(app)
      .post('/portfolio/import/csv')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `authToken=${token}`)
      .attach('file', Buffer.from(robinhoodCsv), 'robinhood.csv');

    const schwabRes = await request(app)
      .post('/portfolio/import/csv')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `authToken=${token}`)
      .attach('file', Buffer.from(schwabCsv), 'schwab.csv');

    expect(robinhoodRes.status).toBe(200);
    expect(schwabRes.status).toBe(200);

    const rhParsed = robinhoodRes.body.parsed;
    const schParsed = schwabRes.body.parsed;

    // Same number of positions
    expect(rhParsed).toHaveLength(schParsed.length);

    // Sort by ticker for comparison
    const sortByTicker = (a: any, b: any) => a.ticker.localeCompare(b.ticker);
    rhParsed.sort(sortByTicker);
    schParsed.sort(sortByTicker);

    for (let i = 0; i < rhParsed.length; i++) {
      expect(rhParsed[i].ticker).toBe(schParsed[i].ticker);
      expect(rhParsed[i].shares).toBe(schParsed[i].shares);
      expect(rhParsed[i].averageCost).toBeCloseTo(schParsed[i].averageCost, 2);
    }
  });

  it('produces correct absolute end positions (AAPL=8, MSFT=20, GOOG=5)', async () => {
    const app = (await import('../app')).default;

    const res = await request(app)
      .post('/portfolio/import/csv')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `authToken=${token}`)
      .attach('file', Buffer.from(robinhoodCsv), 'robinhood.csv');

    expect(res.status).toBe(200);
    const parsed = res.body.parsed;
    const byTicker = Object.fromEntries(parsed.map((p: any) => [p.ticker, p]));

    // AAPL: Buy 10@150, Sell 5 (avg was $150), Buy 3@155
    // Remaining after sell: 5 shares @ $150 avg = $750 cost
    // After buy 3@155: 8 shares, cost = $750 + $465 = $1215, avg = $151.875
    expect(byTicker['AAPL'].shares).toBe(8);
    expect(byTicker['AAPL'].averageCost).toBeCloseTo(151.88, 1);

    // MSFT: Buy 20@400 = $400 avg
    expect(byTicker['MSFT'].shares).toBe(20);
    expect(byTicker['MSFT'].averageCost).toBe(400);

    // GOOG: Buy 5@180 = $180 avg
    expect(byTicker['GOOG'].shares).toBe(5);
    expect(byTicker['GOOG'].averageCost).toBe(180);
  });

  it('Schwab parser handles account header line and totals footer', async () => {
    const app = (await import('../app')).default;

    const res = await request(app)
      .post('/portfolio/import/csv')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `authToken=${token}`)
      .attach('file', Buffer.from(schwabCsvWithHeader), 'schwab-full.csv');

    expect(res.status).toBe(200);
    expect(res.body.warning).toContain('Schwab');

    const parsed = res.body.parsed;
    const byTicker = Object.fromEntries(parsed.map((p: any) => [p.ticker, p]));

    expect(byTicker['AAPL'].shares).toBe(8);
    expect(byTicker['MSFT'].shares).toBe(20);
    expect(byTicker['GOOG'].shares).toBe(5);
  });

  it('Schwab parser correctly detects broker format', async () => {
    const app = (await import('../app')).default;

    const schwabRes = await request(app)
      .post('/portfolio/import/csv')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `authToken=${token}`)
      .attach('file', Buffer.from(schwabCsv), 'schwab.csv');

    expect(schwabRes.status).toBe(200);
    expect(schwabRes.body.warning).toContain('Schwab');

    const robinhoodRes = await request(app)
      .post('/portfolio/import/csv')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `authToken=${token}`)
      .attach('file', Buffer.from(robinhoodCsv), 'robinhood.csv');

    expect(robinhoodRes.status).toBe(200);
    expect(robinhoodRes.body.warning).toContain('Robinhood');
  });

  it('trade dates are preserved across both formats', async () => {
    const app = (await import('../app')).default;

    const robinhoodRes = await request(app)
      .post('/portfolio/import/csv')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `authToken=${token}`)
      .attach('file', Buffer.from(robinhoodCsv), 'robinhood.csv');

    const schwabRes = await request(app)
      .post('/portfolio/import/csv')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `authToken=${token}`)
      .attach('file', Buffer.from(schwabCsv), 'schwab.csv');

    const rhDates = robinhoodRes.body.trades.map((t: any) => t.date);
    const schDates = schwabRes.body.trades.map((t: any) => t.date);

    // Both should have same dates in same order (chronological after reversal)
    expect(rhDates).toEqual(schDates);
    // First trade should be oldest
    expect(rhDates[0]).toBe('01/15/2026');
    // Last trade should be newest
    expect(rhDates[4]).toBe('02/10/2026');
  });

  describe('Schwab-specific transaction types', () => {
    it('handles stock split transactions', async () => {
      const app = (await import('../app')).default;

      const csv = [
        '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"',
        '"02/10/2026","Stock Split","AAPL","APPLE INC 4:1 SPLIT","30","$0.00","$0.00","$0.00"',
        '"01/15/2026","Buy","AAPL","APPLE INC","10","$600.00","$0.00","$6000.00"',
      ].join('\n');

      const res = await request(app)
        .post('/portfolio/import/csv')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .attach('file', Buffer.from(csv), 'schwab-split.csv');

      expect(res.status).toBe(200);
      const trades = res.body.trades;

      // After reversal: Buy 10@600, Split +30
      expect(trades).toHaveLength(2);
      expect(trades[0].type).toBe('buy');
      expect(trades[1].type).toBe('split');
      expect(trades[1].shares).toBe(30);

      // End position: 10 + 30 = 40 shares, cost = $6000, avg = $150
      const aapl = res.body.parsed.find((p: any) => p.ticker === 'AAPL');
      expect(aapl.shares).toBe(40);
      expect(aapl.averageCost).toBe(150);
    });

    it('handles security transfer transactions', async () => {
      const app = (await import('../app')).default;

      const csv = [
        '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"',
        '"01/15/2026","Security Transfer","TSLA","TESLA INC","15","$250.00","$0.00","$3750.00"',
      ].join('\n');

      const res = await request(app)
        .post('/portfolio/import/csv')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .attach('file', Buffer.from(csv), 'schwab-transfer.csv');

      expect(res.status).toBe(200);
      const trades = res.body.trades;
      expect(trades).toHaveLength(1);
      expect(trades[0].type).toBe('transfer');
      expect(trades[0].ticker).toBe('TSLA');
      expect(trades[0].shares).toBe(15);
    });

    it('handles reinvest shares as a DIV_REINVEST ledger event, not a double-counted buy', async () => {
      const app = (await import('../app')).default;

      const csv = [
        '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"',
        '"02/01/2026","Reinvest Shares","VTI","VANGUARD TOTAL STOCK","0.5","$280.00","$0.00","$140.00"',
        '"01/15/2026","Buy","VTI","VANGUARD TOTAL STOCK","10","$275.00","$0.00","$2750.00"',
      ].join('\n');

      const res = await request(app)
        .post('/portfolio/import/csv')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .attach('file', Buffer.from(csv), 'schwab-reinvest.csv');

      expect(res.status).toBe(200);
      const trades = res.body.trades;

      // Reinvest emits a DIV_REINVEST ledger event, NOT a 'buy' trade — emitting both
      // made the ledger replay add the reinvested shares twice (buy posting +
      // DIV_REINVEST posting). Only the real Buy is a trade. F-H-6.
      expect(trades).toHaveLength(1);
      expect(trades[0].type).toBe('buy');
      expect(trades[0].shares).toBe(10);

      // The holding still reflects the reinvested shares once (via position aggregation).
      const vti = res.body.parsed.find((p: any) => p.ticker === 'VTI');
      expect(vti.shares).toBeCloseTo(10.5, 4);
    });

    it('skips non-trade actions (dividends, interest, fees)', async () => {
      const app = (await import('../app')).default;

      const csv = [
        '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"',
        '"02/10/2026","Cash Dividend","AAPL","APPLE INC","","","","$25.00"',
        '"02/05/2026","Bank Interest","","BANK INT","","","","$1.50"',
        '"01/20/2026","Buy","AAPL","APPLE INC","10","$150.00","$0.00","$1500.00"',
      ].join('\n');

      const res = await request(app)
        .post('/portfolio/import/csv')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .attach('file', Buffer.from(csv), 'schwab-dividends.csv');

      expect(res.status).toBe(200);
      // Only the Buy should produce a trade
      expect(res.body.trades).toHaveLength(1);
      expect(res.body.trades[0].type).toBe('buy');
    });
  });
});
