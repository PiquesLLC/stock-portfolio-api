import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import {
  __TEST_ONLY_ENQUEUE_SQL,
  type QueueClient,
  type AppleEnvironment,
} from '../services/apple-reconciliation-queue.service';
import {
  reconcileOnce,
  buildSnapshot,
  selectEntry,
  DEFAULT_RATE_LIMIT_FALLBACK_MS,
} from '../services/apple-reconciler.service';
import {
  AppleInvalidResponseError,
  AppleRateLimitError,
  AppleTransientError,
  APPLE_BASE_URL,
  APPLE_STATUS,
  parseRetryAfterMs,
  type AppleStatusResponse,
  type AppleTransport,
} from '../services/apple-server-api';
import {
  getAppleRateLimiter,
  __resetAppleRateLimitersForTests,
  APPLE_RATE_LIMITS,
} from '../services/apple-rate-limiter';

/**
 * Reconciler against a real libsql engine with a MOCKED Apple transport.
 *
 * The rule under test throughout: a successful HTTP call earns nothing. The
 * generation + fencing CAS from the queue decides whether a fetched snapshot may
 * commit. Every "in flight" race is driven deterministically by mutating the row
 * from INSIDE the fake transport, which is exactly the window a real network
 * call opens.
 */

const MIGRATION = path.join(
  __dirname, '..', '..', 'prisma', 'migrations',
  '20260824000000_apple_authoritative_state', 'migration.sql',
);

const OTI = '2000000123456789';
const iso = (msFromNow = 0) => new Date(Date.now() + msFromNow).toISOString();

function statusResponse(over: Partial<{
  environment: string; status: number; oti: string; productId: string;
  expiresDate: number; gracePeriodExpiresDate: number; groupId: string;
  transactionId: string; txEnvironment: string;
}> = {}): AppleStatusResponse {
  return {
    environment: over.environment ?? 'Production',
    data: [{
      subscriptionGroupIdentifier: over.groupId ?? 'group-1',
      lastTransactions: [{
        originalTransactionId: over.oti ?? OTI,
        status: over.status ?? APPLE_STATUS.ACTIVE,
        transaction: {
          transactionId: over.transactionId ?? 'txn-1',
          originalTransactionId: over.oti ?? OTI,
          productId: over.productId ?? 'com.nala.pro.monthly',
          expiresDate: over.expiresDate ?? Date.now() + 30 * 86_400_000,
          environment: over.txEnvironment,
          signedDate: Date.now(),
        },
        renewal: {
          autoRenewStatus: 1,
          autoRenewProductId: over.productId ?? 'com.nala.pro.monthly',
          gracePeriodExpiresDate: over.gracePeriodExpiresDate,
        },
      }],
    }],
  };
}

const transportOf = (fn: AppleTransport['getAllSubscriptionStatuses']): AppleTransport =>
  ({ getAllSubscriptionStatuses: fn });

describe('apple reconciler (real engine, mocked Apple transport)', () => {
  let db: Client;

  const adapter: QueueClient = {
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) =>
      Number((await db.execute({ sql, args: args as never })).rowsAffected),
    $queryRawUnsafe: async <T,>(sql: string, ...args: unknown[]) =>
      (await db.execute({ sql, args: args as never })).rows as T[],
    $transaction: async <T,>(fn: (tx: QueueClient) => Promise<T>): Promise<T> => {
      await db.execute('BEGIN');
      try {
        const out = await fn(adapter);
        await db.execute('COMMIT');
        return out;
      } catch (err) {
        await db.execute('ROLLBACK');
        throw err;
      }
    },
  };

  const enqueue = async (environment: AppleEnvironment = 'Production', oti = OTI) => {
    const now = iso();
    await db.execute({
      sql: __TEST_ONLY_ENQUEUE_SQL,
      args: [crypto.randomUUID(), environment, oti, now, now, now],
    });
  };
  const job = async (oti = OTI) =>
    (await db.execute({
      sql: `SELECT * FROM "AppleReconciliation" WHERE "originalTransactionId"=?`, args: [oti],
    })).rows[0] as Record<string, unknown>;
  const sub = async (oti = OTI) =>
    (await db.execute({
      sql: `SELECT * FROM "AppleSubscription" WHERE "originalTransactionId"=?`, args: [oti],
    })).rows[0] as Record<string, unknown> | undefined;
  const subCount = async () =>
    Number((await db.execute(`SELECT COUNT(*) AS n FROM "AppleSubscription"`)).rows[0].n);

  beforeEach(async () => {
    __resetAppleRateLimitersForTests();
    db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "plan" TEXT NOT NULL DEFAULT 'free')`);
    await db.execute(`INSERT INTO "User" ("id","plan") VALUES ('user_1','free')`);
    const sql = fs.readFileSync(MIGRATION, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';')) {
      const s = stmt.trim();
      if (s) await db.execute(s);
    }
    await db.execute('PRAGMA foreign_keys = ON');
  });

  afterEach(() => { db.close(); __resetAppleRateLimitersForTests(); });

  // ── happy path ─────────────────────────────────────────────────────

  it('reconciles successfully and writes the authoritative snapshot', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      transport: transportOf(async () => statusResponse()), client: adapter,
    });
    expect(out.kind).toBe('committed');

    const s = (await sub())!;
    expect(String(s.status)).toBe('active');
    expect(String(s.environment)).toBe('Production');
    expect(String(s.currentTransactionId)).toBe('txn-1');
    expect(Number(s.appliedGeneration)).toBe(1);
    expect(String((await job()).reconcileState)).toBe('done');
  });

  it('FIRST CONTACT: reconciles when no AppleSubscription row exists yet', async () => {
    await enqueue();
    expect(await subCount()).toBe(0);   // nothing was invented at intake
    const out = await reconcileOnce('w1', {
      transport: transportOf(async () => statusResponse()), client: adapter,
    });
    expect(out.kind).toBe('committed');
    expect(await subCount()).toBe(1);
  });

  it('a second reconciliation updates the same row rather than duplicating it', async () => {
    await enqueue();
    await reconcileOnce('w1', { transport: transportOf(async () => statusResponse()), client: adapter });
    await enqueue();
    await reconcileOnce('w1', {
      transport: transportOf(async () => statusResponse({ status: APPLE_STATUS.GRACE, gracePeriodExpiresDate: Date.now() + 86_400_000 })),
      client: adapter,
    });
    expect(await subCount()).toBe(1);
    const s = (await sub())!;
    expect(String(s.status)).toBe('grace');
    expect(s.gracePeriodExpiresAt).not.toBeNull();
    expect(Number(s.appliedGeneration)).toBe(2);
  });

  // ── the authority rule ─────────────────────────────────────────────

  it('AUTHORITY: HTTP 200 does not commit when the generation advanced in flight', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter,
      transport: transportOf(async () => {
        await enqueue();               // G=2 arrives while the request is out
        return statusResponse();
      }),
    });
    expect(out.kind).toBe('stale');
    expect(await subCount()).toBe(0);  // nothing was written
    expect(String((await job()).reconcileState)).toBe('pending'); // released for G=2
  });

  it('AUTHORITY: HTTP 200 does not commit when the lease was reclaimed in flight', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter,
      transport: transportOf(async () => {
        // Another worker reclaims the row mid-request.
        await db.execute({
          sql: `UPDATE "AppleReconciliation" SET "leaseOwner"=?, "leaseExpiresAt"=? WHERE "originalTransactionId"=?`,
          args: ['worker-other:tok', iso(60_000), OTI],
        });
        return statusResponse();
      }),
    });
    expect(out.kind).toBe('stale');
    expect(await subCount()).toBe(0);
  });

  // ── rate limiting ──────────────────────────────────────────────────

  it('429 WITH Retry-After persists Apple\'s instruction into retry scheduling', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter,
      transport: transportOf(async () => { throw new AppleRateLimitError(45_000); }),
    });
    expect(out.kind).toBe('rate-limited');
    const j = await job();
    expect(String(j.reconcileState)).toBe('failed');
    // ~45s out, not the 30s first-attempt ladder value.
    expect(String(j.nextAttemptAt) > iso(40_000)).toBe(true);
    expect(String(j.nextAttemptAt) < iso(50_000)).toBe(true);
  });

  it('429 WITHOUT a usable Retry-After falls back conservatively', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter,
      transport: transportOf(async () => { throw new AppleRateLimitError(undefined); }),
    });
    expect(out.kind).toBe('rate-limited');
    expect((out as { retryAfterMs: number }).retryAfterMs).toBe(DEFAULT_RATE_LIMIT_FALLBACK_MS);
    expect(String((await job()).nextAttemptAt) > iso(50_000)).toBe(true);
  });

  it('parseRetryAfterMs rejects values it cannot trust', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs('-5')).toBeUndefined();
    expect(parseRetryAfterMs('999999999')).toBeUndefined();  // absurd
    const httpDate = new Date(Date.now() + 20_000).toUTCString();
    expect(parseRetryAfterMs(httpDate)!).toBeGreaterThan(10_000);
  });

  it('the limiter is GLOBAL per environment, not per worker', () => {
    const a = getAppleRateLimiter('Production');
    const b = getAppleRateLimiter('Production');
    expect(a).toBe(b);                                     // same instance
    expect(getAppleRateLimiter('Sandbox')).not.toBe(a);    // separate budget
    expect(APPLE_RATE_LIMITS.Production).toBe(50);
    expect(APPLE_RATE_LIMITS.Sandbox).toBe(5);
  });

  it('workers share one budget: draining it in one worker defers another', async () => {
    const limiter = getAppleRateLimiter('Production');
    for (let i = 0; i < APPLE_RATE_LIMITS.Production; i++) expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);  // budget is app-wide, not per worker

    await enqueue();
    const out = await reconcileOnce('w2', {
      client: adapter,
      transport: transportOf(async () => { throw new Error('must not be called'); }),
    });
    expect(out.kind).toBe('deferred');
    // The lease was handed back rather than held while waiting.
    expect((await job()).leaseOwner).toBeNull();
    expect(String((await job()).reconcileState)).toBe('pending');
  });

  it('Sandbox has its own, smaller budget that Production cannot drain', () => {
    const prod = getAppleRateLimiter('Production');
    for (let i = 0; i < APPLE_RATE_LIMITS.Production; i++) prod.tryAcquire();
    expect(prod.tryAcquire()).toBe(false);
    expect(getAppleRateLimiter('Sandbox').tryAcquire()).toBe(true);
  });

  // ── transport failures ─────────────────────────────────────────────

  it('5xx / timeout / network failure goes through queue failure and backoff', async () => {
    for (const err of [new AppleTransientError('apple 503'), new AppleTransientError('aborted')]) {
      await db.execute(`DELETE FROM "AppleReconciliation"`);
      await enqueue();
      const out = await reconcileOnce('w1', {
        client: adapter, transport: transportOf(async () => { throw err; }),
      });
      expect(out.kind).toBe('transient');
      const j = await job();
      expect(String(j.reconcileState)).toBe('failed');
      expect(Number(j.attemptCount)).toBe(1);
      expect(String(j.nextAttemptAt) > iso(1_000)).toBe(true);   // parked on backoff
      expect(String(j.lastError)).toContain(err.message);
      expect(await subCount()).toBe(0);
    }
  });

  it('a malformed response cannot project entitlement', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter,
      transport: transportOf(async () => ({ environment: 'Production', data: [] })),
    });
    expect(out.kind).toBe('invalid');
    expect(await subCount()).toBe(0);
    expect(String((await job()).reconcileState)).toBe('failed');
  });

  it('an unverifiable response (transport throws Invalid) cannot project', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter,
      transport: transportOf(async () => { throw new AppleInvalidResponseError('bad jws'); }),
    });
    expect(out.kind).toBe('invalid');
    expect(await subCount()).toBe(0);
  });

  // ── environment isolation ──────────────────────────────────────────

  it('ENVIRONMENT: a Sandbox response to a Production request is rejected', async () => {
    await enqueue('Production');
    const out = await reconcileOnce('w1', {
      client: adapter,
      transport: transportOf(async () => statusResponse({ environment: 'Sandbox' })),
    });
    expect(out.kind).toBe('invalid');
    expect(await subCount()).toBe(0);
  });

  it('ENVIRONMENT: a transaction tagged with the other environment is rejected', () => {
    expect(() => buildSnapshot('Production', OTI, statusResponse({ txEnvironment: 'Sandbox' }), 'g'))
      .toThrow(AppleInvalidResponseError);
  });

  it('ENVIRONMENT: the request targets the endpoint for its own environment', async () => {
    const seen: AppleEnvironment[] = [];
    await enqueue('Production', 'oti-prod');
    await enqueue('Sandbox', 'oti-sand');
    const transport = transportOf(async ({ environment, originalTransactionId }) => {
      seen.push(environment);
      return statusResponse({ environment, oti: originalTransactionId });
    });
    await reconcileOnce('w1', { client: adapter, transport });
    await reconcileOnce('w1', { client: adapter, transport });

    expect(new Set(seen)).toEqual(new Set(['Production', 'Sandbox']));
    expect((await sub('oti-prod'))!.environment).toBe('Production');
    expect((await sub('oti-sand'))!.environment).toBe('Sandbox');
    expect(APPLE_BASE_URL.Production).not.toBe(APPLE_BASE_URL.Sandbox);
  });

  // ── determinism ────────────────────────────────────────────────────

  it('selects by identity across multiple groups, never by position', () => {
    const resp: AppleStatusResponse = {
      environment: 'Production',
      data: [
        { subscriptionGroupIdentifier: 'z-group', lastTransactions: [statusResponse({ oti: 'other-1', transactionId: 'txn-other' }).data[0].lastTransactions[0]] },
        { subscriptionGroupIdentifier: 'a-group', lastTransactions: [statusResponse({ oti: OTI, transactionId: 'txn-mine' }).data[0].lastTransactions[0]] },
      ],
    };
    expect(selectEntry(resp, OTI).transaction.transactionId).toBe('txn-mine');
    expect(() => selectEntry(resp, 'nope')).toThrow(AppleInvalidResponseError);
  });

  // ── atomicity and recovery ─────────────────────────────────────────

  it('ATOMICITY: a failed snapshot write leaves the job recoverable and nothing written', async () => {
    await enqueue();
    // A status Apple could never send makes the CHECK constraint reject the
    // INSERT from inside the transaction, after the CAS has already succeeded.
    const bad = statusResponse();
    bad.data[0].lastTransactions[0].status = 99;
    await expect(reconcileOnce('w1', {
      client: adapter, transport: transportOf(async () => bad),
    })).resolves.toMatchObject({ kind: 'invalid' });

    expect(await subCount()).toBe(0);
    const j = await job();
    expect(String(j.reconcileState)).not.toBe('done');
    expect(j.leaseOwner).toBeNull();          // lease handed back
  });

  it('RECOVERY: pending/failed work survives a restart and reconciles later', async () => {
    await enqueue();
    await reconcileOnce('w1', {
      client: adapter, transport: transportOf(async () => { throw new AppleTransientError('apple 500'); }),
    });
    expect(String((await job()).reconcileState)).toBe('failed');

    // "Restart": nothing in memory, the row is the only state. Make it due again.
    await db.execute({
      sql: `UPDATE "AppleReconciliation" SET "nextAttemptAt"=? WHERE "originalTransactionId"=?`,
      args: [iso(-1000), OTI],
    });
    const out = await reconcileOnce('w2', {
      client: adapter, transport: transportOf(async () => statusResponse()),
    });
    expect(out.kind).toBe('committed');
    expect(String((await job()).reconcileState)).toBe('done');
  });

  // ── scope guarantees ───────────────────────────────────────────────

  it('never writes User.plan — entitlement projection is a later stage', async () => {
    await enqueue();
    await reconcileOnce('w1', { client: adapter, transport: transportOf(async () => statusResponse()), });
    const u = (await db.execute(`SELECT "plan" FROM "User" WHERE "id"='user_1'`)).rows[0];
    expect(String(u.plan)).toBe('free');   // untouched despite an active subscription
  });

  it('returns idle when there is no work', async () => {
    const out = await reconcileOnce('w1', {
      client: adapter, transport: transportOf(async () => { throw new Error('must not be called'); }),
    });
    expect(out.kind).toBe('idle');
  });
});
