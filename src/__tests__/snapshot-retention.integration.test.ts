import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { runSnapshotRetention } from '../services/snapshot-retention.service';

// Real-engine test: the unit tests only assert on SQL substrings against a
// mock, which cannot catch SQLite dialect/format bugs (the blind review
// rightly flagged this). Here the actual statements run against an in-memory
// libsql database seeded with rows in the EXACT production storage format
// (TEXT ISO-8601 like '2026-07-11T23:13:38.075+00:00', ground-truthed via
// typeof() on prod 2026-07-11).

const iso = (daysAgo: number, hour = 15, min = 0): string => {
  const d = new Date(Date.now() - daysAgo * 86400000);
  d.setUTCHours(hour, min, 33, 75);
  return d.toISOString().replace('Z', '+00:00');
};

describe('snapshot-retention integration (real libsql engine)', () => {
  let db: Client;

  beforeEach(async () => {
    process.env.SNAPSHOT_RETENTION_ENABLED = 'true';
    db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE "PortfolioSnapshot" (id TEXT PRIMARY KEY, userId TEXT, timestamp TEXT NOT NULL)`);
    // Mirror prod's schema.prisma indexes — the EOD-keeper subquery is O(n²)
    // without them (and prod relies on them too)
    await db.execute(`CREATE INDEX "ps_user_ts" ON "PortfolioSnapshot"("userId","timestamp")`);
    await db.execute(`CREATE INDEX "ps_ts" ON "PortfolioSnapshot"("timestamp")`);
    await db.execute(`CREATE TABLE "HoldingSnapshot" (id TEXT PRIMARY KEY, userId TEXT, timestamp TEXT NOT NULL)`);
    await db.execute(`CREATE TABLE "RefreshToken" (id TEXT PRIMARY KEY, expiresAt TEXT NOT NULL, revokedAt TEXT)`);
    await db.execute(`CREATE TABLE "JobIdempotencyKey" (id TEXT PRIMARY KEY, expiresAt TEXT NOT NULL)`);
    await db.execute(`CREATE TABLE "BackgroundJobRun" (id TEXT PRIMARY KEY, startedAt TEXT NOT NULL)`);
    await db.execute(`CREATE TABLE "AnalyticsEvent" (id TEXT PRIMARY KEY, createdAt TEXT NOT NULL)`);
    await db.execute(`CREATE TABLE "ApiUsageLog" (id TEXT PRIMARY KEY, createdAt TEXT NOT NULL)`);
  });

  afterEach(() => {
    delete process.env.SNAPSHOT_RETENTION_ENABLED;
    db.close();
  });

  const exec = (sql: string) => db.execute(sql).then(r => Number(r.rowsAffected ?? 0));
  const count = async (tbl: string) => Number((await db.execute(`SELECT COUNT(*) AS c FROM "${tbl}"`)).rows[0].c);
  const rows = async (sql: string) => (await db.execute(sql)).rows;

  it('prunes old intraday rows but keeps each (user, day) end-of-day row and all recent rows', async () => {
    // Old day (45d ago): three intraday rows for user A — only the 20:00 EOD row survives
    await db.execute(`INSERT INTO "PortfolioSnapshot" VALUES
      ('a1','userA','${iso(45, 14)}'),
      ('a2','userA','${iso(45, 16)}'),
      ('a3','userA','${iso(45, 20)}'),
      ('b1','userB','${iso(45, 18)}'),
      ('r1','userA','${iso(5, 14)}'),
      ('r2','userA','${iso(5, 16)}')`);

    const res = await runSnapshotRetention(exec);
    expect(res.skipped).toBe(false);

    const remaining = (await rows(`SELECT id FROM "PortfolioSnapshot" ORDER BY id`)).map(r => r.id);
    // a3 = user A's EOD keeper; b1 = user B's only (thus EOD) row; r1/r2 recent
    expect(remaining).toEqual(['a3', 'b1', 'r1', 'r2']);
  });

  it('NULL-userId snapshots are pruned with their own EOD keeper (null-safe join)', async () => {
    await db.execute(`INSERT INTO "PortfolioSnapshot" VALUES
      ('n1',NULL,'${iso(45, 14)}'),
      ('n2',NULL,'${iso(45, 19)}')`);

    await runSnapshotRetention(exec);

    const remaining = (await rows(`SELECT id FROM "PortfolioSnapshot"`)).map(r => r.id);
    expect(remaining).toEqual(['n2']); // keeper kept, older intraday row pruned
  });

  it('deletes old HoldingSnapshot rows and keeps recent ones', async () => {
    await db.execute(`INSERT INTO "HoldingSnapshot" VALUES
      ('h-old','userA','${iso(31, 15)}'),
      ('h-new','userA','${iso(29, 15)}')`);

    await runSnapshotRetention(exec);

    const remaining = (await rows(`SELECT id FROM "HoldingSnapshot"`)).map(r => r.id);
    expect(remaining).toEqual(['h-new']);
  });

  it('only expired/revoked tokens are deleted — active sessions survive', async () => {
    await db.execute(`INSERT INTO "RefreshToken" VALUES
      ('t-live','${iso(-20, 15)}',NULL),
      ('t-expired','${iso(3, 15)}',NULL),
      ('t-revoked','${iso(-20, 15)}','${iso(1, 15)}')`);

    await runSnapshotRetention(exec);

    const remaining = (await rows(`SELECT id FROM "RefreshToken"`)).map(r => r.id);
    expect(remaining).toEqual(['t-live']);
  });

  it('age-window tables keep young rows', async () => {
    await db.execute(`INSERT INTO "BackgroundJobRun" VALUES ('j-old','${iso(8)}'),('j-new','${iso(6)}')`);
    await db.execute(`INSERT INTO "AnalyticsEvent" VALUES ('e-old','${iso(91)}'),('e-new','${iso(89)}')`);
    await db.execute(`INSERT INTO "ApiUsageLog" VALUES ('l-old','${iso(91)}'),('l-new','${iso(89)}')`);

    await runSnapshotRetention(exec);

    expect((await rows(`SELECT id FROM "BackgroundJobRun"`)).map(r => r.id)).toEqual(['j-new']);
    expect((await rows(`SELECT id FROM "AnalyticsEvent"`)).map(r => r.id)).toEqual(['e-new']);
    expect((await rows(`SELECT id FROM "ApiUsageLog"`)).map(r => r.id)).toEqual(['l-new']);
  });

  it('chunking terminates and clears large backlogs completely', { timeout: 60000 }, async () => {
    // 12,003 old rows across 3 days for one user → 3 keepers survive
    const days = [40, 41, 42];
    for (const day of days) {
      const values: string[] = [];
      for (let i = 0; i < 4001; i++) {
        values.push(`('p${day}-${i}','userA','${iso(day, 13 + (i % 7), i % 60)}')`);
      }
      await db.execute(`INSERT INTO "PortfolioSnapshot" VALUES ${values.join(',')}`);
    }
    expect(await count('PortfolioSnapshot')).toBe(12003);

    await runSnapshotRetention(exec);

    // One MAX(timestamp) keeper per (userA, day). Ties on the same max
    // timestamp all survive (<> excludes them all), so allow >= 3 but assert
    // the backlog is gone.
    const remaining = await count('PortfolioSnapshot');
    expect(remaining).toBeGreaterThanOrEqual(3);
    expect(remaining).toBeLessThan(30);
  });
});
