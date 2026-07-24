import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';

// Real-engine test for the two raw-SQL day-bucketing queries in
// snapshot.service.ts. The existing unit tests mock getDailyPortfolioValues
// outright, so they asserted the INTENDED shape while the real statement was
// broken: `date(ps.timestamp / 1000, 'unixepoch')` coerced the TEXT ISO-8601
// column to its leading numeric prefix and bucketed every row into
// '1970-01-01', and `timestamp >= <number>` matched everything because SQLite
// orders every TEXT value above every INTEGER. Both defects are only visible
// against a real engine holding rows in the production storage format.
const h = vi.hoisted(() => ({ db: null as Client | null }));

vi.mock('../utils/prisma', () => ({
  default: {
    // Reconstruct the tagged-template SQL with positional params, exactly as
    // Prisma would, and run it on the in-memory engine.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.raw.reduce(
        (acc, part, i) => acc + part + (i < values.length ? '?' : ''),
        '',
      );
      const res = await h.db!.execute({ sql, args: values as never });
      return res.rows;
    },
    holdingSnapshot: {
      findMany: async ({ where }: { where: { snapshotId: { in: string[] } } }) => {
        const ids = where.snapshotId.in;
        if (ids.length === 0) return [];
        const res = await h.db!.execute({
          sql: `SELECT ticker, dayPL, dayPLPercent, timestamp, snapshotId
                FROM "HoldingSnapshot"
                WHERE snapshotId IN (${ids.map(() => '?').join(',')})
                ORDER BY timestamp ASC`,
          args: ids as never,
        });
        return res.rows;
      },
    },
  },
}));

import { getDailyPortfolioValues, getRecentHoldingSnapshots } from '../services/snapshot.service';

// Production storage format, ground-truthed via typeof() on prod 2026-07-11 and
// re-confirmed on dev 2026-07-24: TEXT ISO-8601 with a +00:00 offset.
const iso = (daysAgo: number, hour: number): string => {
  const d = new Date(Date.now() - daysAgo * 86400000);
  d.setUTCHours(hour, 30, 15, 250);
  return d.toISOString().replace('Z', '+00:00');
};
const dayOf = (daysAgo: number): string => iso(daysAgo, 12).slice(0, 10);

describe('snapshot day-bucketing queries (real libsql engine)', () => {
  beforeEach(async () => {
    const db = createClient({ url: ':memory:' });
    h.db = db;
    await db.execute(
      `CREATE TABLE "PortfolioSnapshot" (
         id TEXT PRIMARY KEY, userId TEXT NOT NULL, timestamp TEXT NOT NULL,
         totalValue REAL NOT NULL, netEquity REAL)`,
    );
    // Mirrors schema.prisma — the fixed cutoff must stay index-eligible.
    await db.execute(`CREATE INDEX "ps_user_ts" ON "PortfolioSnapshot"("userId","timestamp")`);
    await db.execute(
      `CREATE TABLE "HoldingSnapshot" (
         id TEXT PRIMARY KEY, snapshotId TEXT NOT NULL, userId TEXT NOT NULL,
         ticker TEXT NOT NULL, dayPL REAL NOT NULL, dayPLPercent REAL NOT NULL,
         timestamp TEXT NOT NULL)`,
    );
  });

  afterEach(() => {
    h.db?.close();
    h.db = null;
  });

  const seedSnapshot = async (
    id: string,
    userId: string,
    daysAgo: number,
    hour: number,
    totalValue: number,
    netEquity: number | null = null,
  ) => {
    await h.db!.execute({
      sql: `INSERT INTO "PortfolioSnapshot" VALUES (?,?,?,?,?)`,
      args: [id, userId, iso(daysAgo, hour), totalValue, netEquity] as never,
    });
  };

  describe('getDailyPortfolioValues', () => {
    it('returns one row per calendar day instead of collapsing into a single bucket', async () => {
      // Three intraday snapshots on each of three days.
      await seedSnapshot('d1a', 'userA', 3, 14, 100);
      await seedSnapshot('d1b', 'userA', 3, 20, 110); // day 3 close
      await seedSnapshot('d2a', 'userA', 2, 14, 200);
      await seedSnapshot('d2b', 'userA', 2, 20, 220); // day 2 close
      await seedSnapshot('d3a', 'userA', 1, 14, 300);
      await seedSnapshot('d3b', 'userA', 1, 20, 330); // day 1 close

      const result = await getDailyPortfolioValues('userA', 30);

      expect(result).toHaveLength(3);
      expect(result.map(r => r.date)).toEqual([dayOf(3), dayOf(2), dayOf(1)]);
      // No row may be bucketed to the epoch — that was the original symptom.
      expect(result.map(r => r.date)).not.toContain('1970-01-01');
    });

    it("uses each day's final snapshot as that day's value", async () => {
      await seedSnapshot('e1', 'userA', 2, 9, 500, 400);
      await seedSnapshot('e2', 'userA', 2, 15, 550, 450);
      await seedSnapshot('e3', 'userA', 2, 21, 575, 475); // end of day

      const result = await getDailyPortfolioValues('userA', 30);

      expect(result).toHaveLength(1);
      expect(result[0].totalValue).toBe(575);
      expect(result[0].netEquity).toBe(475);
    });

    it('honours the days window rather than returning the full history', async () => {
      await seedSnapshot('recent1', 'userA', 1, 20, 100);
      await seedSnapshot('recent2', 'userA', 2, 20, 110);
      await seedSnapshot('old1', 'userA', 40, 20, 900);
      await seedSnapshot('old2', 'userA', 90, 20, 950);

      const result = await getDailyPortfolioValues('userA', 7);

      expect(result).toHaveLength(2);
      expect(result.map(r => r.date)).toEqual([dayOf(2), dayOf(1)]);
      expect(result.map(r => r.totalValue)).not.toContain(900);
    });

    it('scopes results to the requested user', async () => {
      await seedSnapshot('mine', 'userA', 1, 20, 100);
      await seedSnapshot('theirs', 'userB', 1, 20, 999);

      const result = await getDailyPortfolioValues('userA', 30);

      expect(result).toHaveLength(1);
      expect(result[0].totalValue).toBe(100);
    });

    it('returns an empty series when the user has no snapshots in range', async () => {
      await seedSnapshot('ancient', 'userA', 200, 20, 100);
      expect(await getDailyPortfolioValues('userA', 7)).toEqual([]);
    });
  });

  describe('getRecentHoldingSnapshots', () => {
    const seedHolding = async (
      id: string,
      snapshotId: string,
      daysAgo: number,
      hour: number,
      ticker: string,
      dayPL: number,
    ) => {
      await h.db!.execute({
        sql: `INSERT INTO "HoldingSnapshot" VALUES (?,?,?,?,?,?,?)`,
        args: [id, snapshotId, 'userA', ticker, dayPL, dayPL / 100, iso(daysAgo, hour)] as never,
      });
    };

    it("selects one end-of-day snapshot per calendar day, not a single day's", async () => {
      for (const [daysAgo, ids] of [
        [3, ['s3a', 's3b']],
        [2, ['s2a', 's2b']],
        [1, ['s1a', 's1b']],
      ] as [number, string[]][]) {
        await seedSnapshot(ids[0], 'userA', daysAgo, 14, 100);
        await seedSnapshot(ids[1], 'userA', daysAgo, 20, 110); // that day's close
        await seedHolding(`h-${ids[0]}`, ids[0], daysAgo, 14, 'AAPL', 1);
        await seedHolding(`h-${ids[1]}`, ids[1], daysAgo, 20, 'AAPL', 2);
      }

      const rows = await getRecentHoldingSnapshots('userA', 5);

      // One row per day (three days), each from that day's LAST snapshot.
      expect(rows).toHaveLength(3);
      expect(rows.every(r => r.dayPL === 2)).toBe(true);
    });
  });
});
