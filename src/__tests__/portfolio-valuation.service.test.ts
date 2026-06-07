import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// Real getPortfolio valuation has no direct coverage — the 4 tests that touch it all
// stub getPortfolio out. This harness exercises the REAL valuation math by mocking only
// the data sources (prices + holdings), locking in the bug-prone bits: the never-$0
// fallback guard and the options 100-share contract multiplier.

const { fetchPricesMock, getOptionQuotesMock } = vi.hoisted(() => ({
  fetchPricesMock: vi.fn(),
  getOptionQuotesMock: vi.fn(),
}));

vi.mock('../services/market.service', async (importOriginal) => ({
  ...(await importOriginal() as object),
  fetchPrices: fetchPricesMock,
}));

vi.mock('../services/options.service', async (importOriginal) => ({
  ...(await importOriginal() as object),
  getOptionQuotes: getOptionQuotesMock,
}));

vi.mock('../services/portfolio-management.service', async (importOriginal) => ({
  ...(await importOriginal() as object),
  getOrCreateDefaultPortfolio: vi.fn().mockResolvedValue({ id: 'pf_1' }),
}));

import { getPortfolio } from '../services/portfolio.service';

function equityQuote(currentPrice: number, previousClose: number) {
  return { currentPrice, previousClose, isStale: false, isRepricing: false };
}

function pricesResult(quotes: Map<string, unknown>, failedTickers: string[] = []) {
  return { quotes, staleCount: 0, repricingCount: 0, failedTickers, provider: 'polygon' };
}

describe('getPortfolio valuation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const p = prismaMock as any;
    p.holding = { findMany: vi.fn() };
    p.userSettings = { findUnique: vi.fn().mockResolvedValue(null) };
    p.portfolio = {
      findMany: vi.fn().mockResolvedValue([{ cashBalance: 0, marginDebt: 0 }]),
      findFirst: vi.fn(),
    };
  });

  it('values an equity holding: value = shares*price, P/L vs cost, day-change vs prevClose', async () => {
    (prismaMock as any).holding.findMany.mockResolvedValue([
      { id: 'h1', userId: 'u1', portfolioId: 'pf_1', ticker: 'AAPL', shares: 10, averageCost: 100, holdingType: 'equity' },
    ]);
    fetchPricesMock.mockResolvedValue(pricesResult(new Map([['AAPL', equityQuote(150, 140)]])));
    getOptionQuotesMock.mockResolvedValue(new Map());

    const pf = await getPortfolio('u1');
    const h = pf.holdings.find((x: any) => x.ticker === 'AAPL') as any;

    expect(h.currentValue).toBe(1500);          // 10 * 150
    expect(h.totalCost).toBe(1000);             // 10 * 100
    expect(h.profitLoss).toBe(500);             // 1500 - 1000
    expect(h.dayChange).toBeCloseTo(100, 6);    // 10*150 - 10*140
    expect(h.priceUnavailable).toBe(false);
    expect(pf.holdingsValue).toBe(1500);
    expect(pf.totalPL).toBe(500);               // holdingsValue - totalCost
  });

  it('never uses a $0 fallback price: a missing quote contributes 0 and is flagged unavailable', async () => {
    (prismaMock as any).holding.findMany.mockResolvedValue([
      { id: 'h1', userId: 'u1', portfolioId: 'pf_1', ticker: 'ZZZZ', shares: 5, averageCost: 50, holdingType: 'equity' },
    ]);
    fetchPricesMock.mockResolvedValue(pricesResult(new Map(), ['ZZZZ'])); // no quote for ZZZZ
    getOptionQuotesMock.mockResolvedValue(new Map());

    const pf = await getPortfolio('u1');
    const h = pf.holdings.find((x: any) => x.ticker === 'ZZZZ') as any;

    expect(h.priceUnavailable).toBe(true);
    expect(h.currentValue).toBe(0);
    expect(h.profitLoss).toBe(0);               // no misleading P/L when price is unknown
    expect(pf.holdingsValue).toBe(0);           // an unavailable holding must NOT inflate the total
    expect(pf.quotesUnavailableCount).toBe(1);
  });

  it('values an option with the 100-share contract multiplier (regression guard)', async () => {
    (prismaMock as any).holding.findMany.mockResolvedValue([
      {
        id: 'o1', userId: 'u1', portfolioId: 'pf_1', ticker: 'AAPL_C150', shares: 2, averageCost: 300,
        holdingType: 'option', optionUnderlying: 'AAPL', optionExpiry: '2026-01-16', optionStrike: 150, optionType: 'call',
      },
    ]);
    fetchPricesMock.mockResolvedValue(pricesResult(new Map())); // no equities
    getOptionQuotesMock.mockResolvedValue(new Map([['AAPL_C150', { midPrice: 4 }]]));

    const pf = await getPortfolio('u1');
    const o = pf.options.find((x: any) => x.ticker === 'AAPL_C150') as any;

    expect(o.currentValue).toBe(800);           // 4 (midPrice) * 2 (contracts) * 100 (shares/contract)
    expect(o.profitLoss).toBe(200);             // 800 - (2 * 300)
    expect(o.priceUnavailable).toBe(false);
    expect(pf.holdingsValue).toBe(800);         // options are included in holdingsValue
  });
});
