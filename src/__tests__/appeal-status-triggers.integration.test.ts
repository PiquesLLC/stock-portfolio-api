import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Appeal.status enforcement, against real SQLite.
 *
 * 20260320_add_appeals defines two BEFORE triggers that reject any status
 * outside the allowed set. Production has had NEITHER: that migration failed
 * partway, was marked rolled back, and scripts/start.sh then resolved it as
 * applied on every boot without re-executing its SQL. The table and its three
 * indexes exist — the startup fallback block creates those — so a
 * table/column/index audit saw a healthy Appeal and moved on.
 *
 * 20260827_restore_appeal_status_triggers restores them with IF NOT EXISTS, so
 * it is a no-op wherever the original migration really ran.
 */

const REPO = path.join(__dirname, '..', '..');
const ORIGINAL = path.join(REPO, 'prisma', 'migrations', '20260320_add_appeals', 'migration.sql');
const REPAIR = path.join(REPO, 'prisma', 'migrations', '20260827_restore_appeal_status_triggers', 'migration.sql');
const SPLIT = '-- CHECK constraints for Appeal.status';

const posix = (p: string) => p.split(path.sep).join('/');
const originalSql = () => fs.readFileSync(ORIGINAL, 'utf8');
const appealTableSql = () => originalSql().split(SPLIT)[0];
const originalTriggersSql = () => originalSql().split(SPLIT)[1];
const repairSql = () => fs.readFileSync(REPAIR, 'utf8');

const VALID = ['pending', 'reviewing', 'upheld', 'overturned'];

describe('Appeal status trigger repair', () => {
  let dir: string;
  let db: Client;

  /** A database shaped like production: Appeal present, triggers absent. */
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appeal-triggers-'));
    db = createClient({ url: `file:${posix(path.join(dir, 'appeal.db'))}` });
    await db.executeMultiple(
      'CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY);'
      + ' CREATE TABLE "ContentStrike" ("id" TEXT NOT NULL PRIMARY KEY);',
    );
    await db.executeMultiple(appealTableSql());
    await db.execute("INSERT INTO \"User\" (\"id\") VALUES ('u1')");
    await db.execute("INSERT INTO \"ContentStrike\" (\"id\") VALUES ('s1')");
    await db.execute("INSERT INTO \"ContentStrike\" (\"id\") VALUES ('s2')");
  });

  afterEach(async () => {
    await db.close();
    // Best-effort: Windows keeps the -wal/-shm handles briefly after close, and
    // failing cleanup must not be reported as a failing assertion.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp directory is the OS's problem now */
    }
  });

  const triggerNames = async (): Promise<string[]> => (await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'Appeal' ORDER BY name",
  )).rows.map((r) => String(r.name));

  const insertAppeal = (id: string, status: string, strikeId = 's1') => db.execute({
    sql: 'INSERT INTO "Appeal" ("id", "strikeId", "userId", "reason", "status", "updatedAt")'
      + ' VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
    args: [id, strikeId, 'u1', 'because', status],
  });

  it('creates both triggers when production has neither', async () => {
    expect(await triggerNames()).toEqual([]);
    await db.executeMultiple(repairSql());
    expect(await triggerNames()).toEqual(['appeal_status_check', 'appeal_status_check_update']);
  });

  it('is idempotent when both triggers already exist, and does not redefine them', async () => {
    await db.executeMultiple(originalTriggersSql());
    const before = (await db.execute(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    )).rows.map((r) => String(r.sql));

    await db.executeMultiple(repairSql());
    await db.executeMultiple(repairSql());

    expect(await triggerNames()).toEqual(['appeal_status_check', 'appeal_status_check_update']);
    const after = (await db.execute(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    )).rows.map((r) => String(r.sql));

    // IF NOT EXISTS must SKIP, not replace: a fresh replay keeps the original
    // definitions, so a repaired database and a replayed one agree.
    expect(after).toEqual(before);
    expect(after.join('\n')).not.toMatch(/IF NOT EXISTS/i);
  });

  it('rejects an invalid status on INSERT', async () => {
    await db.executeMultiple(repairSql());
    await expect(insertAppeal('a-bad', 'definitely-not-valid')).rejects.toThrow(/Invalid appeal status/);
    const rows = await db.execute('SELECT COUNT(*) n FROM "Appeal"');
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('rejects an invalid status on UPDATE', async () => {
    await db.executeMultiple(repairSql());
    await insertAppeal('a1', 'pending');

    await expect(db.execute({
      sql: 'UPDATE "Appeal" SET "status" = ? WHERE "id" = ?',
      args: ['escalated', 'a1'],
    })).rejects.toThrow(/Invalid appeal status/);

    const rows = await db.execute("SELECT \"status\" FROM \"Appeal\" WHERE \"id\" = 'a1'");
    expect(String(rows.rows[0].status)).toBe('pending');
  });

  it('accepts every valid status on INSERT and on UPDATE', async () => {
    await db.executeMultiple(repairSql());

    for (const [i, status] of VALID.entries()) {
      await insertAppeal(`ok-${i}`, status, i === 0 ? 's1' : 's2');
      await db.execute({ sql: 'DELETE FROM "Appeal" WHERE "id" = ?', args: [`ok-${i}`] });
    }

    await insertAppeal('a1', 'pending');
    for (const status of VALID) {
      await db.execute({ sql: 'UPDATE "Appeal" SET "status" = ? WHERE "id" = ?', args: [status, 'a1'] });
      const rows = await db.execute("SELECT \"status\" FROM \"Appeal\" WHERE \"id\" = 'a1'");
      expect(String(rows.rows[0].status)).toBe(status);
    }
  });

  it('does not rebuild Appeal or touch existing rows', async () => {
    const shapeBefore = (await db.execute(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'Appeal'",
    )).rows[0].sql;
    await insertAppeal('kept', 'reviewing');
    const rowBefore = (await db.execute("SELECT * FROM \"Appeal\" WHERE \"id\" = 'kept'")).rows[0];

    await db.executeMultiple(repairSql());

    const shapeAfter = (await db.execute(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'Appeal'",
    )).rows[0].sql;
    const rowAfter = (await db.execute("SELECT * FROM \"Appeal\" WHERE \"id\" = 'kept'")).rows[0];

    expect(shapeAfter).toBe(shapeBefore);
    expect({ ...rowAfter }).toEqual({ ...rowBefore });
  });

  it('restores exactly the definitions history declares', async () => {
    await db.executeMultiple(repairSql());
    const repaired = (await db.execute(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    )).rows.map((r) => String(r.sql).replace(/\bIF\s+NOT\s+EXISTS\s+/gi, '').replace(/\s+/g, ' ').trim());

    const fresh = createClient({ url: `file:${posix(path.join(dir, 'fresh.db'))}` });
    await fresh.executeMultiple(
      'CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY);'
      + ' CREATE TABLE "ContentStrike" ("id" TEXT NOT NULL PRIMARY KEY);',
    );
    await fresh.executeMultiple(appealTableSql());
    await fresh.executeMultiple(originalTriggersSql());
    const declared = (await fresh.execute(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    )).rows.map((r) => String(r.sql).replace(/\s+/g, ' ').trim());
    await fresh.close();

    expect(repaired).toEqual(declared);
  });
});
