import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { getAccountHistory } from '../services/account-history.service';

const prisma = prismaMock as any;

describe('Account History Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.activityEvent.findMany.mockResolvedValue([]);
    prisma.portfolioTrade.findMany.mockResolvedValue([]);
    prisma.ledgerEvent.findMany.mockResolvedValue([]);
  });

  describe('composite cursor pagination across same-timestamp sources', () => {
    const timestamp = new Date('2026-02-24T10:00:00.000Z');

    // 6 entries, 2 per source, ALL at the exact same timestamp.
    // Deterministic sort: date DESC, source priority ASC (activity=0, trade=1, ledger=2), id DESC.
    // Expected order: act-2, act-1, trd-2, trd-1, led-2, led-1
    function setupSameTimestampEntries() {
      prisma.activityEvent.findMany.mockResolvedValue([
        { id: 'act-2', type: 'holding_added', payload: JSON.stringify({ ticker: 'AAPL', shares: 10, averageCost: 185 }), createdAt: timestamp, userId: 'u1' },
        { id: 'act-1', type: 'holding_added', payload: JSON.stringify({ ticker: 'MSFT', shares: 5, averageCost: 410 }), createdAt: timestamp, userId: 'u1' },
      ]);
      prisma.portfolioTrade.findMany.mockResolvedValue([
        { id: 'trd-2', type: 'buy', ticker: 'AAPL', shares: 10, price: 185, date: timestamp, sourceBroker: 'schwab', userId: 'u1' },
        { id: 'trd-1', type: 'sell', ticker: 'MSFT', shares: 5, price: 410, date: timestamp, sourceBroker: 'schwab', userId: 'u1' },
      ]);
      prisma.ledgerEvent.findMany.mockResolvedValue([
        { id: 'led-2', eventType: 'DEPOSIT', ticker: null, shares: null, price: null, amount: 500, effectiveDate: timestamp, sourceBroker: null, userId: 'u1' },
        { id: 'led-1', eventType: 'WITHDRAWAL', ticker: null, shares: null, price: null, amount: 200, effectiveDate: timestamp, sourceBroker: null, userId: 'u1' },
      ]);
    }

    it('page 1 returns entries in deterministic order', async () => {
      setupSameTimestampEntries();

      const page1 = await getAccountHistory({ userId: 'u1', limit: 3 });

      expect(page1.entries).toHaveLength(3);
      expect(page1.entries.map(e => e.id)).toEqual(['act-2', 'act-1', 'trd-2']);
      expect(page1.nextCursor).not.toBeNull();
    });

    it('page 2 via composite cursor returns remaining entries without duplicates', async () => {
      setupSameTimestampEntries();

      // Get page 1 to obtain cursor
      const page1 = await getAccountHistory({ userId: 'u1', limit: 3 });
      const cursor = page1.nextCursor!;

      // Cursor should encode date|source|id of last entry (trd-2)
      expect(cursor).toContain('trade');
      expect(cursor).toContain('trd-2');

      // Page 2: mocks return same data (DB doesn't know about our cursor)
      // The service's post-merge cursor logic should skip past trd-2
      const page2 = await getAccountHistory({ userId: 'u1', limit: 3, cursor });

      expect(page2.entries).toHaveLength(3);
      expect(page2.entries.map(e => e.id)).toEqual(['trd-1', 'led-2', 'led-1']);
      expect(page2.nextCursor).toBeNull();
    });

    it('no duplicates across pages — union of page 1 + page 2 = all 6 entries', async () => {
      setupSameTimestampEntries();

      const page1 = await getAccountHistory({ userId: 'u1', limit: 3 });
      const page2 = await getAccountHistory({ userId: 'u1', limit: 3, cursor: page1.nextCursor! });

      const allIds = [...page1.entries, ...page2.entries].map(e => e.id);
      expect(allIds).toEqual(['act-2', 'act-1', 'trd-2', 'trd-1', 'led-2', 'led-1']);
      expect(new Set(allIds).size).toBe(6); // no duplicates
    });
  });

  describe('category filtering', () => {
    it('category=trade excludes ledger events', async () => {
      prisma.portfolioTrade.findMany.mockResolvedValue([
        { id: 'trd-1', type: 'buy', ticker: 'AAPL', shares: 10, price: 185, date: new Date('2026-02-24T10:00:00Z'), sourceBroker: 'schwab', userId: 'u1' },
      ]);

      const result = await getAccountHistory({ userId: 'u1', category: 'trade' });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].category).toBe('trade');
      // Ledger should not have been queried (empty array types → skipped)
      expect(prisma.ledgerEvent.findMany).not.toHaveBeenCalled();
    });

    it('category=cash excludes trades and activity', async () => {
      prisma.ledgerEvent.findMany.mockResolvedValue([
        { id: 'led-1', eventType: 'DEPOSIT', ticker: null, shares: null, price: null, amount: 500, effectiveDate: new Date('2026-02-24T10:00:00Z'), sourceBroker: null, userId: 'u1' },
      ]);

      const result = await getAccountHistory({ userId: 'u1', category: 'cash' });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].category).toBe('cash');
      expect(prisma.portfolioTrade.findMany).not.toHaveBeenCalled();
      expect(prisma.activityEvent.findMany).not.toHaveBeenCalled();
    });
  });

  describe('ticker normalization', () => {
    it('normalizes ticker to uppercase and trims whitespace', async () => {
      prisma.portfolioTrade.findMany.mockResolvedValue([]);

      await getAccountHistory({ userId: 'u1', ticker: '  aapl  ' });

      expect(prisma.portfolioTrade.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ ticker: 'AAPL' }),
        }),
      );
    });

    it('excludes null-ticker activity entries when ticker filter is set', async () => {
      prisma.activityEvent.findMany.mockResolvedValue([
        { id: 'act-1', type: 'holding_added', payload: JSON.stringify({ shares: 10, averageCost: 185 }), createdAt: new Date('2026-02-24T10:00:00Z'), userId: 'u1' },
        { id: 'act-2', type: 'holding_added', payload: JSON.stringify({ ticker: 'AAPL', shares: 5, averageCost: 190 }), createdAt: new Date('2026-02-24T10:00:00Z'), userId: 'u1' },
      ]);

      const result = await getAccountHistory({ userId: 'u1', ticker: 'AAPL' });

      // Only act-2 (has ticker AAPL), act-1 (no ticker) excluded
      const activityEntries = result.entries.filter(e => e.source === 'activity');
      expect(activityEntries).toHaveLength(1);
      expect(activityEntries[0].id).toBe('act-2');
    });
  });

  describe('signed amount semantics', () => {
    it('buy = negative, sell = positive', async () => {
      prisma.portfolioTrade.findMany.mockResolvedValue([
        { id: 'buy-1', type: 'buy', ticker: 'AAPL', shares: 10, price: 185, date: new Date('2026-02-24T10:00:00Z'), sourceBroker: 'schwab', userId: 'u1' },
        { id: 'sell-1', type: 'sell', ticker: 'AAPL', shares: 5, price: 195, date: new Date('2026-02-23T10:00:00Z'), sourceBroker: 'schwab', userId: 'u1' },
      ]);

      const result = await getAccountHistory({ userId: 'u1' });
      const buy = result.entries.find(e => e.id === 'buy-1')!;
      const sell = result.entries.find(e => e.id === 'sell-1')!;

      expect(buy.amount).toBe(-1850); // 10 * 185 negative (money out)
      expect(sell.amount).toBe(975);  // 5 * 195 positive (money in)
    });

    it('deposit positive, withdrawal/fee negative, split null', async () => {
      prisma.ledgerEvent.findMany.mockResolvedValue([
        { id: 'dep-1', eventType: 'DEPOSIT', ticker: null, shares: null, price: null, amount: 500, effectiveDate: new Date('2026-02-24T10:00:00Z'), sourceBroker: null, userId: 'u1' },
        { id: 'wd-1', eventType: 'WITHDRAWAL', ticker: null, shares: null, price: null, amount: 200, effectiveDate: new Date('2026-02-23T10:00:00Z'), sourceBroker: null, userId: 'u1' },
        { id: 'fee-1', eventType: 'FEE', ticker: null, shares: null, price: null, amount: 5, effectiveDate: new Date('2026-02-22T10:00:00Z'), sourceBroker: null, userId: 'u1' },
      ]);
      prisma.portfolioTrade.findMany.mockResolvedValue([
        { id: 'split-1', type: 'split', ticker: 'AAPL', shares: 10, price: 0, date: new Date('2026-02-21T10:00:00Z'), sourceBroker: 'schwab', userId: 'u1' },
      ]);

      const result = await getAccountHistory({ userId: 'u1' });
      const deposit = result.entries.find(e => e.id === 'dep-1')!;
      const withdrawal = result.entries.find(e => e.id === 'wd-1')!;
      const fee = result.entries.find(e => e.id === 'fee-1')!;
      const split = result.entries.find(e => e.id === 'split-1')!;

      expect(deposit.amount).toBe(500);    // positive
      expect(withdrawal.amount).toBe(-200); // negative
      expect(fee.amount).toBe(-5);          // negative
      expect(split.amount).toBeNull();      // no cash movement
    });
  });
});
