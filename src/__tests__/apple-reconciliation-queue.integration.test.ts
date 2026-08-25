import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import {
  ENQUEUE_SQL,
  CLAIM_SQL,
  COMPLETE_CAS_SQL,
} from '../services/apple-reconciliation-queue.service';

/**
 * Real-engine test for the generation/lease invariant:
 *
 *   For a given (environment, originalTransactionId), no worker may commit work
 *   for generation G if a newer generation exists, or if that worker no longer
 *   owns the lease.
 *
 * Two deliberate choices about how this is tested:
 *
 * 1. The schema comes from the ACTUAL migration file, not a hand-written stub.
 *    The CHECK constraints and the partial rail index are therefore live while
 *    these interleavings run, so a statement that violates them fails here.
 *
 * 2. The statements under test are the exported SQL constants the service
 *    itself executes — not re-implementations. A mock asserting on SQL
 *    substrings cannot catch a dialect or predicate bug, which is the same
 *    reasoning recorded in snapshot-retention.integration.test.ts.
 *
 * Interleavings are driven deterministically rather than with real threads:
 * genuine concurrency here would be flaky, and every precondition under test
 * lives in a WHERE clause, so statement order is exactly what decides the
 * outcome.
 */

const MIGRATION = path.join(
  __dirname, '..', '..', 'prisma', 'migrations',
  '20260824000000_apple_authoritative_state', 'migration.sql',
);

const ENV = 'Production';
const OTI = '2000000999888777';
/** ISO-8601 UTC compares correctly as TEXT, which is how these columns are stored. */
const at = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

describe('apple reconciliation queue — generation + lease (real libsql engine)', () => {
  let db: Client;

  const row = async () => {
    const r = await db.execute({
      sql: `SELECT * FROM "AppleReconciliation" WHERE "environment"=? AND "originalTransactionId"=?`,
      args: [ENV, OTI],
    });
    return r.rows[0] as Record<string, unknown> | undefined;
  };
  const rowCount = async () => {
    const r = await db.execute(`SELECT COUNT(*) AS n FROM "AppleReconciliation"`);
    return Number(r.rows[0].n);
  };

  const enqueue = async (id = crypto.randomUUID()) => {
    const now = at(0);
    await db.execute({ sql: ENQUEUE_SQL, args: [id, ENV, OTI, now, now, now] });
  };

  /** Claim a specific row on behalf of `owner`; returns rowsAffected. */
  const claim = async (id: string, owner: string, leaseMs = 60_000, nowMs = 0) => {
    const now = at(nowMs);
    const r = await db.execute({
      sql: CLAIM_SQL,
      args: [owner, at(nowMs + leaseMs), now, id, now, now],
    });
    return Number(r.rowsAffected);
  };

  const cas = async (id: string, generation: number, owner: string) => {
    const r = await db.execute({ sql: COMPLETE_CAS_SQL, args: [at(0), id, generation, owner] });
    return Number(r.rowsAffected);
  };

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    // AppleSubscription carries an FK to User, so a minimal parent must exist.
    await db.execute(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY)`);
    await db.execute(`INSERT INTO "User" ("id") VALUES ('user_1')`);

    // Strip comments BEFORE splitting on ';' — the migration's own commentary
    // contains a semicolon, which would otherwise cut a comment in half and
    // leave its tail parsed as a statement.
    const sql = fs.readFileSync(MIGRATION, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    for (const stmt of sql.split(';')) {
      const s = stmt.trim();
      if (s) await db.execute(s);
    }
    await db.execute('PRAGMA foreign_keys = ON');
  });

  afterEach(() => db.close());

  it('creates exactly one durable row per (environment, originalTransactionId)', async () => {
    await enqueue();
    await enqueue();
    await enqueue();
    expect(await rowCount()).toBe(1);
  });

  it('concurrent intake advances the generation once per notification, losing none', async () => {
    await enqueue();
    expect(Number((await row())!.targetGeneration)).toBe(1);
    await enqueue();
    await enqueue();
    // Three notifications -> generation 3, still one row. An increment computed
    // in application code (read, await, write) is exactly what could lose one here.
    expect(Number((await row())!.targetGeneration)).toBe(3);
    expect(await rowCount()).toBe(1);
  });

  it('never resets the generation, even after the job has completed', async () => {
    await enqueue();
    const r1 = (await row())!;
    await claim(String(r1.id), 'worker-1');
    expect(await cas(String(r1.id), 1, 'worker-1')).toBe(1);
    expect(String((await row())!.reconcileState)).toBe('done');

    // A later notification must REUSE this row and advance it, not recreate it.
    await enqueue();
    const r2 = (await row())!;
    expect(r2.id).toBe(r1.id);                       // same durable row
    expect(Number(r2.targetGeneration)).toBe(2);     // advanced, not reset to 1
    expect(String(r2.reconcileState)).toBe('pending');
    expect(await rowCount()).toBe(1);
  });

  it('INVARIANT: a worker cannot commit generation G once G+1 exists', async () => {
    await enqueue();
    const r = (await row())!;
    const id = String(r.id);

    // worker-1 claims and captures G=1, then goes off to call Apple.
    expect(await claim(id, 'worker-1')).toBe(1);
    const G = Number((await row())!.targetGeneration);
    expect(G).toBe(1);

    // A new notification lands mid-flight.
    await enqueue();
    expect(Number((await row())!.targetGeneration)).toBe(2);

    // worker-1 returns with a stale snapshot.
    expect(await cas(id, G, 'worker-1')).toBe(0);
    expect(String((await row())!.reconcileState)).not.toBe('done');
  });

  it('intake does NOT knock a running job back to pending (no duplicate Apple call)', async () => {
    await enqueue();
    const id = String((await row())!.id);
    await claim(id, 'worker-1');
    await enqueue();
    // Still 'running': the in-flight worker releases it after its CAS fails,
    // rather than a second worker claiming while the first is mid-call.
    expect(String((await row())!.reconcileState)).toBe('running');
  });

  it('INVARIANT: a worker whose lease was reclaimed cannot commit', async () => {
    await enqueue();
    const id = String((await row())!.id);

    // worker-1 claims with a lease that has already expired by the time we look.
    expect(await claim(id, 'worker-1', -1_000)).toBe(1);
    // worker-2 reclaims the SAME generation because the lease lapsed.
    expect(await claim(id, 'worker-2')).toBe(1);
    expect(String((await row())!.leaseOwner)).toBe('worker-2');

    // worker-1 comes back. Same generation, but it is no longer the owner.
    expect(await cas(id, 1, 'worker-1')).toBe(0);
    // worker-2 completes normally.
    expect(await cas(id, 1, 'worker-2')).toBe(1);
    expect(String((await row())!.reconcileState)).toBe('done');
  });

  it('a live lease is NOT reclaimable by another worker', async () => {
    await enqueue();
    const id = String((await row())!.id);
    expect(await claim(id, 'worker-1', 60_000)).toBe(1);
    expect(await claim(id, 'worker-2')).toBe(0);   // lease still held
    expect(String((await row())!.leaseOwner)).toBe('worker-1');
  });

  it('a crashed worker leaves the job reclaimable once its lease expires', async () => {
    await enqueue();
    const id = String((await row())!.id);
    await claim(id, 'worker-1', -1_000);           // claimed, then the process dies
    expect(String((await row())!.reconcileState)).toBe('running');
    expect(await claim(id, 'worker-2')).toBe(1);   // recoverable, not stranded
    expect(await cas(id, 1, 'worker-2')).toBe(1);
  });

  it('ATOMICITY: the done transition cannot survive without the snapshot write', async () => {
    // The highest-risk failure in this design is splitting the CAS and the
    // snapshot into two commits. Here the snapshot write fails INSIDE the
    // transaction (invalid status, rejected by the live CHECK constraint) and
    // the done transition must roll back with it.
    await enqueue();
    const id = String((await row())!.id);
    await claim(id, 'worker-1');

    await db.execute('BEGIN');
    expect(Number((await db.execute({ sql: COMPLETE_CAS_SQL, args: [at(0), id, 1, 'worker-1'] })).rowsAffected)).toBe(1);
    let snapshotFailed = false;
    try {
      await db.execute({
        sql: `INSERT INTO "AppleSubscription"
                ("id","environment","originalTransactionId","userId","productId","plan","status","appliedGeneration","createdAt","updatedAt")
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        args: ['sub_1', ENV, OTI, 'user_1', 'p.monthly', 'pro', 'billingRetry', 1, at(0), at(0)],
      });
    } catch {
      snapshotFailed = true;
      await db.execute('ROLLBACK');
    }
    expect(snapshotFailed).toBe(true);

    // Neither half survived.
    expect(String((await row())!.reconcileState)).toBe('running');
    const subs = await db.execute(`SELECT COUNT(*) AS n FROM "AppleSubscription"`);
    expect(Number(subs.rows[0].n)).toBe(0);

    // And the work is still claimable, so nothing was lost.
    expect(await cas(id, 1, 'worker-1')).toBe(1);
  });

  it('ATOMICITY: a committed pair leaves both halves present', async () => {
    await enqueue();
    const id = String((await row())!.id);
    await claim(id, 'worker-1');

    await db.execute('BEGIN');
    await db.execute({ sql: COMPLETE_CAS_SQL, args: [at(0), id, 1, 'worker-1'] });
    await db.execute({
      sql: `INSERT INTO "AppleSubscription"
              ("id","environment","originalTransactionId","userId","productId","plan","status","appliedGeneration","createdAt","updatedAt")
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: ['sub_1', ENV, OTI, 'user_1', 'p.monthly', 'pro', 'active', 1, at(0), at(0)],
    });
    await db.execute('COMMIT');

    expect(String((await row())!.reconcileState)).toBe('done');
    const subs = await db.execute(`SELECT "appliedGeneration" FROM "AppleSubscription"`);
    expect(Number(subs.rows[0].appliedGeneration)).toBe(1);
  });

  it('the claim is atomic: two workers racing produce one winner', async () => {
    await enqueue();
    const id = String((await row())!.id);
    const results = [await claim(id, 'worker-1'), await claim(id, 'worker-2')];
    expect(results.filter((n) => n === 1)).toHaveLength(1);
  });

  it('a job parked on a future nextAttemptAt is not claimable yet', async () => {
    await enqueue();
    const id = String((await row())!.id);
    await db.execute({
      sql: `UPDATE "AppleReconciliation" SET "reconcileState"='failed', "nextAttemptAt"=? WHERE "id"=?`,
      args: [at(60_000), id],
    });
    expect(await claim(id, 'worker-1')).toBe(0);
  });
});
