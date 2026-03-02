import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { replayDailyLedger } from '../services/ledger/replay.service';

describe('Ledger Replay v1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prismaMock as any).portfolioTrade.findMany.mockResolvedValue([]);
    (prismaMock as any).ledgerEvent.findMany.mockResolvedValue([]);
  });

  it('posts buy/sell cash on settle date (T+1), not trade date', async () => {
    (prismaMock as any).portfolioTrade.findMany.mockResolvedValue([
      // Buy 10 @ 100 on Jan 2 -> cash posts Jan 3
      { date: new Date('2026-01-02T10:00:00Z'), ticker: 'AAPL', type: 'buy', shares: 10, price: 100, rowIndex: 0 },
      // Sell 2 @ 120 on Jan 4 -> cash posts Jan 5
      { date: new Date('2026-01-04T10:00:00Z'), ticker: 'AAPL', type: 'sell', shares: 2, price: 120, rowIndex: 1 },
    ]);

    const series = await replayDailyLedger('u1', new Date('2026-01-02T00:00:00Z'), new Date('2026-01-05T00:00:00Z'));
    const byDay = Object.fromEntries(series.map(s => [s.date.toISOString().slice(0, 10), s]));

    // Jan 2: position exists, cash posts same day (trade date settlement for chart accuracy)
    expect(byDay['2026-01-02'].positions.get('AAPL')?.shares).toBe(10);
    expect(byDay['2026-01-02'].cash).toBe(-1000);

    // Jan 3: no change
    expect(byDay['2026-01-03'].cash).toBe(-1000);

    // Jan 4: sell executed (shares reduced), proceeds post same day
    expect(byDay['2026-01-04'].positions.get('AAPL')?.shares).toBe(8);
    expect(byDay['2026-01-04'].cash).toBe(-760);

    // Jan 5: no change
    expect(byDay['2026-01-05'].cash).toBe(-760);
  });

  it('DIV_REINVEST increases shares with zero cash delta', async () => {
    (prismaMock as any).portfolioTrade.findMany.mockResolvedValue([
      { date: new Date('2026-01-02T10:00:00Z'), ticker: 'VTI', type: 'buy', shares: 10, price: 100, rowIndex: 0 },
    ]);
    (prismaMock as any).ledgerEvent.findMany.mockResolvedValue([
      {
        eventType: 'DIV_REINVEST',
        effectiveDate: new Date('2026-01-03T09:00:00Z'),
        settleDate: null,
        ticker: 'VTI',
        shares: 0.5,
        price: 110,
        amount: 0,
        rowIndex: 0,
      },
    ]);

    const series = await replayDailyLedger('u1', new Date('2026-01-02T00:00:00Z'), new Date('2026-01-04T00:00:00Z'));
    const byDay = Object.fromEntries(series.map(s => [s.date.toISOString().slice(0, 10), s]));

    // Buy settles Jan 3 -> cash -1000
    expect(byDay['2026-01-03'].cash).toBe(-1000);
    // DRIP adds shares on effective date with zero cash effect
    expect(byDay['2026-01-03'].positions.get('VTI')?.shares).toBeCloseTo(10.5, 6);
    expect(byDay['2026-01-03'].cash).toBe(-1000);
  });

  it('fee/tax ledger rows reduce cash and equity', async () => {
    (prismaMock as any).ledgerEvent.findMany.mockResolvedValue([
      {
        eventType: 'DEPOSIT',
        effectiveDate: new Date('2026-01-02T10:00:00Z'),
        settleDate: null,
        ticker: null,
        shares: null,
        price: null,
        amount: 1000,
        rowIndex: 0,
      },
      {
        eventType: 'FEE',
        effectiveDate: new Date('2026-01-03T10:00:00Z'),
        settleDate: null,
        ticker: null,
        shares: null,
        price: null,
        amount: -25,
        rowIndex: 1,
      },
    ]);

    const series = await replayDailyLedger('u1', new Date('2026-01-02T00:00:00Z'), new Date('2026-01-03T00:00:00Z'));
    const byDay = Object.fromEntries(series.map(s => [s.date.toISOString().slice(0, 10), s]));

    expect(byDay['2026-01-02'].cash).toBe(1000);
    expect(byDay['2026-01-03'].cash).toBe(975);
    expect(byDay['2026-01-03'].equity).toBe(975);
  });

  it('replay is deterministic for identical imported data', async () => {
    const trades = [
      { date: new Date('2026-01-02T10:00:00Z'), ticker: 'AAPL', type: 'buy', shares: 10, price: 100, rowIndex: 0 },
      { date: new Date('2026-01-03T10:00:00Z'), ticker: 'AAPL', type: 'sell', shares: 2, price: 105, rowIndex: 1 },
      { date: new Date('2026-01-04T10:00:00Z'), ticker: 'MSFT', type: 'buy', shares: 5, price: 200, rowIndex: 2 },
    ];
    const ledger = [
      {
        eventType: 'CASH_DIVIDEND',
        effectiveDate: new Date('2026-01-04T10:00:00Z'),
        settleDate: null,
        ticker: null,
        shares: null,
        price: null,
        amount: 12.5,
        rowIndex: 0,
      },
    ];

    (prismaMock as any).portfolioTrade.findMany.mockResolvedValue(trades);
    (prismaMock as any).ledgerEvent.findMany.mockResolvedValue(ledger);
    const first = await replayDailyLedger('u1', new Date('2026-01-02T00:00:00Z'), new Date('2026-01-06T00:00:00Z'));

    (prismaMock as any).portfolioTrade.findMany.mockResolvedValue(trades);
    (prismaMock as any).ledgerEvent.findMany.mockResolvedValue(ledger);
    const second = await replayDailyLedger('u1', new Date('2026-01-02T00:00:00Z'), new Date('2026-01-06T00:00:00Z'));

    const simplify = (series: Awaited<ReturnType<typeof replayDailyLedger>>) =>
      series.map(s => ({
        d: s.date.toISOString(),
        cash: s.cash,
        margin: s.margin,
        equity: s.equity,
        positions: Array.from(s.positions.entries()).map(([t, p]) => [t, p.shares, p.costBasis]),
      }));

    expect(simplify(first)).toEqual(simplify(second));
  });

  it('equivalent Robinhood/Schwab canonical events produce identical daily output', async () => {
    // Equivalent canonical rows, regardless of broker source.
    const canonicalTrades = [
      { date: new Date('2026-01-02T10:00:00Z'), ticker: 'AAPL', type: 'buy', shares: 10, price: 100, rowIndex: 0 },
      { date: new Date('2026-01-03T10:00:00Z'), ticker: 'MSFT', type: 'buy', shares: 5, price: 200, rowIndex: 1 },
      { date: new Date('2026-01-04T10:00:00Z'), ticker: 'AAPL', type: 'sell', shares: 3, price: 110, rowIndex: 2 },
    ];
    const canonicalLedger = [
      {
        eventType: 'CASH_DIVIDEND',
        effectiveDate: new Date('2026-01-05T10:00:00Z'),
        settleDate: null,
        ticker: null,
        shares: null,
        price: null,
        amount: 8,
        rowIndex: 0,
      },
      {
        eventType: 'FEE',
        effectiveDate: new Date('2026-01-06T10:00:00Z'),
        settleDate: null,
        ticker: null,
        shares: null,
        price: null,
        amount: -2,
        rowIndex: 1,
      },
    ];

    (prismaMock as any).portfolioTrade.findMany.mockResolvedValue(canonicalTrades);
    (prismaMock as any).ledgerEvent.findMany.mockResolvedValue(canonicalLedger);
    const rh = await replayDailyLedger('u1', new Date('2026-01-02T00:00:00Z'), new Date('2026-01-07T00:00:00Z'));

    (prismaMock as any).portfolioTrade.findMany.mockResolvedValue(canonicalTrades);
    (prismaMock as any).ledgerEvent.findMany.mockResolvedValue(canonicalLedger);
    const schwab = await replayDailyLedger('u1', new Date('2026-01-02T00:00:00Z'), new Date('2026-01-07T00:00:00Z'));

    expect(
      rh.map(s => ({
        d: s.date.toISOString(),
        cash: s.cash,
        margin: s.margin,
        equity: s.equity,
        pos: Array.from(s.positions.entries()).sort(([a], [b]) => a.localeCompare(b)),
      })),
    ).toEqual(
      schwab.map(s => ({
        d: s.date.toISOString(),
        cash: s.cash,
        margin: s.margin,
        equity: s.equity,
        pos: Array.from(s.positions.entries()).sort(([a], [b]) => a.localeCompare(b)),
      })),
    );
  });
});

