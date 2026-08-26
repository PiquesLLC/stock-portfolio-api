import { describe, it, expect, beforeAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The drift comparator has one job the previous audit could not do: notice an
 * object CATEGORY that is missing entirely.
 *
 * The 20260826 audit compared tables, columns and indexes. Production was
 * missing two Appeal triggers the whole time, and the audit could not have found
 * them — it never asked SQLite about triggers. So these tests pin coverage of
 * triggers and views alongside the original three, and prove each kind of
 * finding is actually detected rather than normalised into silence.
 */

const REPO = path.join(__dirname, '..', '..');
const requireCjs = createRequire(__filename);
const drift = requireCjs(path.join(REPO, 'scripts', 'db-schema-drift.cjs')) as {
  introspect: (db: Client) => Promise<Map<string, string>>;
  diffFacts: (live: Map<string, string>, reference: Map<string, string>) => Array<Record<string, unknown>>;
  classify: (d: Array<Record<string, unknown>>) => { explained: unknown[]; unexplained: Array<Record<string, unknown>> };
  compare: (liveUrl: string, referenceUrl: string) => Promise<{ explained: unknown[]; unexplained: Array<Record<string, unknown>> }>;
};

const posix = (p: string) => p.split(path.sep).join('/');
const url = (p: string) => `file:${posix(p)}`;

const TRIGGER = `
CREATE TRIGGER appeal_status_check
BEFORE INSERT ON "Appeal"
BEGIN
  SELECT CASE
    WHEN NEW."status" NOT IN ('pending', 'reviewing', 'upheld', 'overturned')
    THEN RAISE(ABORT, 'Invalid appeal status')
  END;
END;`;

/** A small stand-in for history: enough shape to exercise every object kind. */
async function seed(file: string, extra = ''): Promise<void> {
  const db = createClient({ url: url(file) });
  await db.executeMultiple(
    'CREATE TABLE "Appeal" ("id" TEXT NOT NULL PRIMARY KEY, "status" TEXT NOT NULL DEFAULT \'pending\');'
    + ' CREATE INDEX "Appeal_status_idx" ON "Appeal"("status");'
    + TRIGGER,
  );
  if (extra) await db.executeMultiple(extra);
  await db.close();
}

describe('structural schema-drift comparison', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-'));
  });

  const pair = async (liveExtra: string, refExtra = '') => {
    const stamp = Math.random().toString(36).slice(2);
    const live = path.join(dir, `live-${stamp}.db`);
    const reference = path.join(dir, `ref-${stamp}.db`);
    await seed(live, liveExtra);
    await seed(reference, refExtra);
    return drift.compare(url(live), url(reference));
  };

  it('reports no drift between two identical databases', async () => {
    const { explained, unexplained } = await pair('');
    expect(unexplained).toEqual([]);
    expect(explained).toEqual([]);
  });

  it('detects a trigger that is missing from the live database', async () => {
    const { unexplained } = await pair('DROP TRIGGER appeal_status_check;');
    expect(unexplained).toHaveLength(1);
    expect(unexplained[0]).toMatchObject({
      key: 'trigger:Appeal.appeal_status_check',
      kind: 'missing-from-live',
    });
  });

  it('detects a trigger whose definition is wrong', async () => {
    // Same name, same table, enforces a DIFFERENT set. IF NOT EXISTS would
    // silently skip this one, which is exactly why shape is compared.
    const { unexplained } = await pair(
      'DROP TRIGGER appeal_status_check;'
      + TRIGGER.replace("'pending', 'reviewing', 'upheld', 'overturned'", "'pending', 'anything-goes'"),
    );
    expect(unexplained).toHaveLength(1);
    expect(unexplained[0]).toMatchObject({ key: 'trigger:Appeal.appeal_status_check', kind: 'differs' });
    expect(String(unexplained[0].live)).toContain('anything-goes');
  });

  it('is not fooled by whitespace or by IF NOT EXISTS', async () => {
    const { unexplained } = await pair(
      'DROP TRIGGER appeal_status_check;'
      + TRIGGER.replace('CREATE TRIGGER', 'CREATE TRIGGER IF NOT EXISTS').replace(/\n/g, '\n   '),
    );
    expect(unexplained).toEqual([]);
  });

  it('detects an unexpected view', async () => {
    const { unexplained } = await pair('CREATE VIEW "AppealSummary" AS SELECT "id" FROM "Appeal";');
    expect(unexplained).toHaveLength(1);
    expect(unexplained[0]).toMatchObject({ key: 'view:AppealSummary', kind: 'extra-in-live' });
  });

  it('detects a view that history declares but the live database lacks', async () => {
    const { unexplained } = await pair('', 'CREATE VIEW "AppealSummary" AS SELECT "id" FROM "Appeal";');
    expect(unexplained).toHaveLength(1);
    expect(unexplained[0]).toMatchObject({ key: 'view:AppealSummary', kind: 'missing-from-live' });
  });

  it('still detects the original three kinds: table, column and index', async () => {
    const table = await pair('CREATE TABLE "Surprise" ("id" TEXT PRIMARY KEY);');
    expect(table.unexplained.map((d) => d.key)).toContain('table:Surprise');

    const column = await pair('ALTER TABLE "Appeal" ADD COLUMN "extra" TEXT;');
    expect(column.unexplained.map((d) => d.key)).toContain('column:Appeal.extra');

    const index = await pair('DROP INDEX "Appeal_status_idx";');
    expect(index.unexplained).toMatchObject([{ key: 'index:Appeal.Appeal_status_idx', kind: 'missing-from-live' }]);
  });

  it('accepts the reviewed HealthProbe exception without blanket-exempting the table name', async () => {
    const accepted = await pair('CREATE TABLE "HealthProbe" ("id" INTEGER PRIMARY KEY, "ts" TEXT NOT NULL);');
    expect(accepted.unexplained).toEqual([]);
    expect(accepted.explained.length).toBeGreaterThan(0);

    // A HealthProbe object MISSING from production is a different statement and
    // must not be swallowed by the same exception.
    const missing = await pair('', 'CREATE TABLE "HealthProbe" ("id" INTEGER PRIMARY KEY, "ts" TEXT NOT NULL);');
    expect(missing.unexplained.map((d) => d.key)).toContain('table:HealthProbe');
  });

  it('classifies the reviewed updatedAt and ProfileStatsCache differences as accepted', () => {
    const { explained, unexplained } = drift.classify([
      {
        key: 'column:Post.updatedAt',
        kind: 'differs',
        live: 'type=DATETIME notnull=1 dflt=CURRENT_TIMESTAMP pk=0',
        reference: 'type=DATETIME notnull=1 dflt=NULL pk=0',
      },
      {
        key: 'index:ProfileStatsCache.sqlite_autoindex_ProfileStatsCache_2',
        kind: 'extra-in-live',
        live: 'unique=1 partial=0 cols=(userId) where=',
        reference: null,
      },
      {
        key: 'index:ProfileStatsCache.ProfileStatsCache_userId_key',
        kind: 'missing-from-live',
        live: null,
        reference: 'unique=1 partial=0 cols=(userId) where=',
      },
    ]);
    expect(unexplained).toEqual([]);
    expect(explained).toHaveLength(3);
  });

  it('does not let the updatedAt exception hide a real change to those columns', () => {
    const { unexplained } = drift.classify([{
      key: 'column:Post.updatedAt',
      kind: 'differs',
      // Nullability changed too — not the reviewed default-only difference.
      live: 'type=DATETIME notnull=0 dflt=CURRENT_TIMESTAMP pk=0',
      reference: 'type=DATETIME notnull=1 dflt=NULL pk=0',
    }]);
    expect(unexplained).toHaveLength(1);
  });

  it('a full migration replay, repaired the way production will be, shows no unexplained drift', async () => {
    const referenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-replay-'));
    const reference = path.join(referenceDir, 'reference.db');
    const built = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: REPO,
      shell: true,
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...process.env, DATABASE_URL: url(reference) },
    });
    expect(built.status, built.stdout + built.stderr).toBe(0);

    // Reshape a copy into what production actually looks like: the two Appeal
    // triggers never ran there.
    const live = path.join(referenceDir, 'live.db');
    fs.copyFileSync(reference, live);
    const liveDb = createClient({ url: url(live) });
    await liveDb.executeMultiple('DROP TRIGGER appeal_status_check; DROP TRIGGER appeal_status_check_update;');

    const before = await drift.compare(url(live), url(reference));
    expect(before.unexplained.map((d) => d.key).sort()).toEqual([
      'trigger:Appeal.appeal_status_check',
      'trigger:Appeal.appeal_status_check_update',
    ]);

    // Now apply the repair migration exactly as `migrate deploy` will.
    await liveDb.executeMultiple(fs.readFileSync(
      path.join(REPO, 'prisma', 'migrations', '20260827_restore_appeal_status_triggers', 'migration.sql'),
      'utf8',
    ));
    await liveDb.close();

    const after = await drift.compare(url(live), url(reference));
    expect(after.unexplained).toEqual([]);
  }, 360_000);
});
