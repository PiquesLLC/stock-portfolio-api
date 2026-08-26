import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { Status } from '@apple/app-store-server-library';
import fs from 'fs';
import path from 'path';
import {
  __TEST_ONLY_ENQUEUE_SQL,
  claimReconciliationJob,
  deferReconciliation,
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
  parseRetryAfterMs,
  type AppleStatusResponse,
  type AppleTransport,
} from '../services/apple-server-api';
import {
  getAppleRateLimiter,
  __resetAppleRateLimitersForTests,
  applyAppleRateLimitCooldown,
  __setAppleLimiterClockForTests,
  APPLE_RATE_LIMITS,
} from '../services/apple-rate-limiter';
import { planForAppleProduct, UnknownAppleProductError } from '../services/apple-product-plan';

/**
 * Reconciler against a real libsql engine with a MOCKED Apple transport.
 *
 * The rule under test throughout: a successful HTTP call earns nothing. The
 * generation + fencing CAS decides whether a fetched snapshot may commit. Every
 * "in flight" race is driven by mutating the row from INSIDE the fake transport,
 * which is exactly the window a real network call opens.
 */

const MIGRATION = path.join(
  __dirname, '..', '..', 'prisma', 'migrations',
  '20260824000000_apple_authoritative_state', 'migration.sql',
);

const OTI = '2000000123456789';
const PRODUCT = 'nala_pro_monthly';
const iso = (msFromNow = 0) => new Date(Date.now() + msFromNow).toISOString();

function entry(over: Partial<{
  oti: string; outerOti: string | undefined; renewalOti: string | undefined;
  status: number; productId: string; transactionId: string;
  expiresDate: number; gracePeriodExpiresDate: number;
  txEnvironment: string; renewalEnvironment: string;
}> = {}) {
  const oti = over.oti ?? OTI;
  return {
    outerOriginalTransactionId: 'outerOti' in over ? over.outerOti : oti,
    status: over.status ?? Status.ACTIVE,
    transaction: {
      transactionId: over.transactionId ?? 'txn-1',
      originalTransactionId: oti,
      productId: over.productId ?? PRODUCT,
      expiresDate: over.expiresDate ?? Date.now() + 30 * 86_400_000,
      environment: over.txEnvironment,
      signedDate: Date.now(),
    },
    renewal: {
      originalTransactionId: 'renewalOti' in over ? over.renewalOti : oti,
      autoRenewStatus: 1,
      autoRenewProductId: over.productId ?? PRODUCT,
      gracePeriodExpiresDate: over.gracePeriodExpiresDate,
      environment: over.renewalEnvironment,
    },
  };
}

function statusResponse(
  over: Parameters<typeof entry>[0] & { environment?: string; groupId?: string } = {},
): AppleStatusResponse {
  return {
    environment: over.environment ?? 'Production',
    data: [{ subscriptionGroupIdentifier: over.groupId ?? 'group-1', lastTransactions: [entry(over)] }],
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
      try { const out = await fn(adapter); await db.execute('COMMIT'); return out; }
      catch (err) { await db.execute('ROLLBACK'); throw err; }
    },
  };

  const enqueue = async (environment: AppleEnvironment = 'Production', oti = OTI) => {
    const now = iso();
    await db.execute({
      sql: __TEST_ONLY_ENQUEUE_SQL,
      args: [crypto.randomUUID(), environment, oti, now, now, now],
    });
  };
  const job = async (oti = OTI) => (await db.execute({
    sql: `SELECT * FROM "AppleReconciliation" WHERE "originalTransactionId"=?`, args: [oti],
  })).rows[0] as Record<string, unknown>;
  const sub = async (oti = OTI) => (await db.execute({
    sql: `SELECT * FROM "AppleSubscription" WHERE "originalTransactionId"=?`, args: [oti],
  })).rows[0] as Record<string, unknown> | undefined;
  const subCount = async () =>
    Number((await db.execute(`SELECT COUNT(*) AS n FROM "AppleSubscription"`)).rows[0].n);

  beforeEach(async () => {
    __resetAppleRateLimitersForTests();
    db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "plan" TEXT NOT NULL DEFAULT 'free', "appleAppAccountToken" TEXT, "appleOriginalTransactionId" TEXT)`);
    await db.execute(`INSERT INTO "User" ("id","plan") VALUES ('user_1','free')`);
    const sql = fs.readFileSync(MIGRATION, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';')) { const s = stmt.trim(); if (s) await db.execute(s); }
    await db.execute('PRAGMA foreign_keys = ON');
  });

  afterEach(() => { db.close(); __resetAppleRateLimitersForTests(); });

  // ── happy path + normalization ─────────────────────────────────────

  it('reconciles successfully and writes the authoritative snapshot', async () => {
    await enqueue();
    expect((await reconcileOnce('w1', {
      transport: transportOf(async () => statusResponse()), client: adapter,
    })).kind).toBe('committed');

    const s = (await sub())!;
    expect(String(s.status)).toBe('active');
    expect(String(s.plan)).toBe('pro');                  // normalized, not the product id
    expect(String(s.productId)).toBe(PRODUCT);
    expect(Number(s.appliedGeneration)).toBe(1);
    expect(String((await job()).reconcileState)).toBe('done');
  });

  it('FIRST CONTACT: reconciles when no AppleSubscription row exists yet', async () => {
    await enqueue();
    expect(await subCount()).toBe(0);
    expect((await reconcileOnce('w1', {
      transport: transportOf(async () => statusResponse()), client: adapter,
    })).kind).toBe('committed');
    expect(await subCount()).toBe(1);
  });

  it('PLAN: maps every known product and REFUSES unknown ones', async () => {
    expect(planForAppleProduct('nala_pro_yearly')).toBe('pro');
    expect(planForAppleProduct('nala_premium_monthly')).toBe('premium');
    expect(planForAppleProduct('nala_elite_yearly')).toBe('elite');
    expect(() => planForAppleProduct('nala_mystery_tier')).toThrow(UnknownAppleProductError);

    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter,
      transport: transportOf(async () => statusResponse({ productId: 'nala_mystery_tier' })),
    });
    // An unrecognised product must FAIL, never normalize to free.
    expect(out.kind).toBe('invalid');
    expect(await subCount()).toBe(0);
  });

  it('a second reconciliation updates the same row rather than duplicating it', async () => {
    await enqueue();
    await reconcileOnce('w1', { transport: transportOf(async () => statusResponse()), client: adapter });
    await enqueue();
    await reconcileOnce('w1', {
      client: adapter,
      transport: transportOf(async () => statusResponse({
        status: Status.BILLING_GRACE_PERIOD, gracePeriodExpiresDate: Date.now() + 86_400_000,
      })),
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
      transport: transportOf(async () => { await enqueue(); return statusResponse(); }),
    });
    expect(out.kind).toBe('stale');
    expect(await subCount()).toBe(0);
    expect(String((await job()).reconcileState)).toBe('pending');
  });

  it('AUTHORITY: HTTP 200 does not commit when the lease was reclaimed in flight', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter,
      transport: transportOf(async () => {
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

  // ── identity bound to VERIFIED data ────────────────────────────────

  it('IDENTITY: the unsigned envelope cannot override the verified transaction', async () => {
    // Outer JSON claims subscription B; the signed payload says A.
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter,
      transport: transportOf(async () => statusResponse({ outerOti: 'B-9999999999' })),
    });
    expect(out.kind).toBe('invalid');
    expect(await subCount()).toBe(0);
  });

  it('IDENTITY: a verified transaction for another subscription is not selected', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter,
      // Envelope says what we asked for, but the SIGNED payload is subscription B.
      transport: transportOf(async () => ({
        environment: 'Production',
        data: [{
          subscriptionGroupIdentifier: 'g',
          lastTransactions: [{ ...entry({ oti: 'B-9999999999' }), outerOriginalTransactionId: OTI }],
        }],
      })),
    });
    expect(out.kind).toBe('invalid');
    expect(await subCount()).toBe(0);
  });

  it('IDENTITY: a foreign transaction is rejected even when the renewal is SILENT', async () => {
    // The sharpest form of the envelope-vs-signed-payload case. The envelope
    // claims the subscription we asked for, the signed transaction is for
    // another, and the renewal omits originalTransactionId entirely — Apple
    // treats that field as optional. Only the VERIFIED transaction check can
    // catch this, so leaning on the renewal cross-check would leave the hole
    // open in exactly the shape a real payload can take.
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter,
      transport: transportOf(async () => ({
        environment: 'Production',
        data: [{
          subscriptionGroupIdentifier: 'g',
          lastTransactions: [{
            ...entry({ oti: 'B-9999999999', renewalOti: undefined }),
            outerOriginalTransactionId: OTI,
          }],
        }],
      })),
    });
    expect(out.kind).toBe('invalid');
    expect(await subCount()).toBe(0);
  });

  it('IDENTITY: a renewal naming a different subscription is rejected', () => {
    expect(() => buildSnapshot('Production', OTI, statusResponse({ renewalOti: 'B-1' })))
      .toThrow(AppleInvalidResponseError);
  });

  it('ENVIRONMENT: mismatches on response, transaction or renewal are all rejected', async () => {
    expect(() => buildSnapshot('Production', OTI, statusResponse({ environment: 'Sandbox' })))
      .toThrow(AppleInvalidResponseError);
    expect(() => buildSnapshot('Production', OTI, statusResponse({ txEnvironment: 'Sandbox' })))
      .toThrow(AppleInvalidResponseError);
    expect(() => buildSnapshot('Production', OTI, statusResponse({ renewalEnvironment: 'Sandbox' })))
      .toThrow(AppleInvalidResponseError);

    await enqueue('Production');
    const out = await reconcileOnce('w1', {
      client: adapter, transport: transportOf(async () => statusResponse({ environment: 'Sandbox' })),
    });
    expect(out.kind).toBe('invalid');
    expect(await subCount()).toBe(0);
  });

  it('ENVIRONMENT: each request targets its own environment and they never cross', async () => {
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
    expect(APPLE_BASE_URL.Production).toBe('https://api.storekit.apple.com');
    expect(APPLE_BASE_URL.Sandbox).toBe('https://api.storekit-sandbox.apple.com');
  });

  // ── selection without cross-transaction ordering ───────────────────

  it('SELECTION: identity match across groups, no ordering between distinct transactions', () => {
    const resp: AppleStatusResponse = {
      environment: 'Production',
      data: [
        { subscriptionGroupIdentifier: 'z', lastTransactions: [entry({ oti: 'other', transactionId: 'txn-other' })] },
        { subscriptionGroupIdentifier: 'a', lastTransactions: [entry({ transactionId: 'txn-mine' })] },
      ],
    };
    const picked = selectEntry(resp, OTI);
    expect(picked.entry.transaction.transactionId).toBe('txn-mine');
    expect(picked.outerGroup).toBe('a');
    expect(() => selectEntry(resp, 'nope')).toThrow(AppleInvalidResponseError);
  });

  it('SELECTION: ANY multiple match is ambiguous, equal transactionIds included', () => {
    // Equal transactionIds are not proof of literal duplication — status, group
    // and renewal data can still differ — so collapsing by array position is
    // refused outright rather than tolerated.
    for (const ids of [['txn-1', 'txn-1'], ['txn-1', 'txn-2']]) {
      const resp: AppleStatusResponse = {
        environment: 'Production',
        data: [{ subscriptionGroupIdentifier: 'g', lastTransactions: ids.map((id) => entry({ transactionId: id })) }],
      };
      expect(() => selectEntry(resp, OTI)).toThrow(/ambiguous/);
    }
  });

  // ── Retry-After and the app-wide cooldown ──────────────────────────

  it('RETRY-AFTER: parses Apple\'s UNIX-millisecond timestamp', () => {
    const now = 1787620000000;
    expect(parseRetryAfterMs(String(now + 45_000), now)).toBe(45_000);
    expect(parseRetryAfterMs(String(now - 45_000), now)).toBeUndefined(); // in the past
    expect(parseRetryAfterMs('30', now)).toBe(30_000);                    // delta-seconds
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
    expect(parseRetryAfterMs('soon', now)).toBeUndefined();
    expect(parseRetryAfterMs('-5', now)).toBeUndefined();
    expect(parseRetryAfterMs(String(now + 40 * 86_400_000), now)).toBeUndefined(); // absurd
  });

  it('429 WITH Retry-After persists Apple\'s instruction into retry scheduling', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter, transport: transportOf(async () => { throw new AppleRateLimitError(45_000); }),
    });
    expect(out.kind).toBe('rate-limited');
    const j = await job();
    expect(String(j.reconcileState)).toBe('failed');
    expect(String(j.nextAttemptAt) > iso(40_000)).toBe(true);
    expect(String(j.nextAttemptAt) < iso(50_000)).toBe(true);
  });

  it('429 WITHOUT a usable Retry-After falls back conservatively', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter, transport: transportOf(async () => { throw new AppleRateLimitError(undefined); }),
    });
    expect((out as { retryAfterMs: number }).retryAfterMs).toBe(DEFAULT_RATE_LIMIT_FALLBACK_MS);
  });

  it('COOLDOWN: a 429 blocks the WHOLE environment, not just the row that got it', async () => {
    let nowMs = Date.now() + 5_000;
    __setAppleLimiterClockForTests(() => nowMs);

    await enqueue('Production', 'oti-A');
    await enqueue('Production', 'oti-B');
    await enqueue('Sandbox', 'oti-S');

    // A receives 429 + 45s.
    const outA = await reconcileOnce('wA', {
      client: adapter, now: () => new Date(nowMs),
      transport: transportOf(async () => { throw new AppleRateLimitError(45_000); }),
    });
    expect(outA.kind).toBe('rate-limited');

    // B is in the same environment and must not reach Apple at all.
    let bCalled = false;
    const outB = await reconcileOnce('wB', {
      client: adapter, now: () => new Date(nowMs),
      transport: transportOf(async ({ originalTransactionId }) => {
        bCalled = true;
        return statusResponse({ oti: originalTransactionId });
      }),
    });
    expect(bCalled).toBe(false);
    expect(outB.kind).toBe('deferred');

    // The other environment is unaffected. The stub ECHOES the requested
    // environment rather than hardcoding one: reconcileOnce claims whatever job
    // is due, so hardcoding would manufacture an environment mismatch if the
    // worker picked a Production row, and mask which case actually ran.
    let sCalled = false;
    let sEnv: AppleEnvironment | undefined;
    const outS = await reconcileOnce('wS', {
      client: adapter, now: () => new Date(nowMs),
      transport: transportOf(async ({ environment, originalTransactionId }) => {
        sCalled = true;
        sEnv = environment;
        return statusResponse({ environment, oti: originalTransactionId });
      }),
    });
    expect(sEnv).toBe('Sandbox');   // the Production rows are all held off
    expect(sCalled).toBe(true);
    expect(outS.kind).toBe('committed');

    // Advance past the cooldown; B may now call Apple.
    nowMs += 46_000;
    await db.execute({
      sql: `UPDATE "AppleReconciliation" SET "nextAttemptAt"=? WHERE "originalTransactionId"='oti-B'`,
      args: [new Date(nowMs - 1000).toISOString()],
    });
    const outB2 = await reconcileOnce('wB', {
      client: adapter, now: () => new Date(nowMs),
      transport: transportOf(async ({ originalTransactionId }) => {
        bCalled = true;
        return statusResponse({ oti: originalTransactionId });
      }),
    });
    expect(bCalled).toBe(true);
    expect(outB2.kind).toBe('committed');
  });

  it('the limiter is GLOBAL per environment and cannot be constructed independently', () => {
    expect(getAppleRateLimiter('Production')).toBe(getAppleRateLimiter('Production'));
    expect(getAppleRateLimiter('Sandbox')).not.toBe(getAppleRateLimiter('Production'));
    expect(APPLE_RATE_LIMITS.Production).toBe(50);
    expect(APPLE_RATE_LIMITS.Sandbox).toBe(5);
  });

  it('DEFERRAL: a tokenless worker releases the job with a future due time', async () => {
    let nowMs = Date.now() + 5_000;
    __setAppleLimiterClockForTests(() => nowMs);
    const limiter = getAppleRateLimiter('Production');
    for (let i = 0; i < APPLE_RATE_LIMITS.Production; i++) expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);

    await enqueue();
    const out = await reconcileOnce('w2', {
      client: adapter, now: () => new Date(nowMs),
      transport: transportOf(async () => { throw new Error('must not be called'); }),
    });
    expect(out.kind).toBe('deferred');

    const j = await job();
    expect(j.leaseOwner).toBeNull();                       // lease handed back
    expect(String(j.reconcileState)).toBe('pending');
    // NOT due immediately — otherwise sustained pressure is a claim/release loop.
    expect(String(j.nextAttemptAt) > new Date(nowMs).toISOString()).toBe(true);
  });

  it('DEFERRAL is generation-aware: a stale worker cannot park newer work', async () => {
    // The deferral equivalent of the stale-failure case. A notification arrives
    // while the tokenless worker still holds the lease; its deferral must not
    // push the brand-new generation out by the cooldown.
    let nowMs = Date.now() + 5_000;
    __setAppleLimiterClockForTests(() => nowMs);
    const limiter = getAppleRateLimiter('Production');
    for (let i = 0; i < APPLE_RATE_LIMITS.Production; i++) limiter.tryAcquire();
    applyAppleRateLimitCooldown('Production', nowMs + 45_000);

    await enqueue();
    // Claim through the production path, then let a notification land while this
    // worker still owns the lease — exactly the window the deferral writes into.
    const claimed = await claimReconciliationJob('w1', { client: adapter });
    expect(claimed!.generation).toBe(1);
    await enqueue();
    expect(Number((await job()).targetGeneration)).toBe(2);
    expect(String((await job()).reconcileState)).toBe('running'); // intake left it running

    // The stale G1 worker defers to +45s.
    await deferReconciliation(claimed!, new Date(nowMs + 45_000), { client: adapter });

    const j = await job();
    expect(Number(j.targetGeneration)).toBe(2);
    expect(String(j.reconcileState)).toBe('pending');
    expect(j.leaseOwner).toBeNull();
    // Due NOW for the new generation — not parked behind the stale cooldown.
    expect(String(j.nextAttemptAt) < new Date(nowMs + 40_000).toISOString()).toBe(true);
  });

  it('DEFERRAL parks the CURRENT generation on the cooldown as intended', async () => {
    // The other half: generation-awareness must not disable the deferral itself.
    const dueAt = new Date(Date.now() + 45_000);
    await enqueue();
    const claimed = await claimReconciliationJob('w1', { client: adapter });
    await deferReconciliation(claimed!, dueAt, { client: adapter });

    const j = await job();
    expect(String(j.reconcileState)).toBe('pending');
    expect(j.leaseOwner).toBeNull();
    expect(String(j.nextAttemptAt) > iso(40_000)).toBe(true);
  });

  // ── transport failures ─────────────────────────────────────────────

  it('5xx / timeout / network failure goes through queue failure and backoff', async () => {
    for (const err of [new AppleTransientError('apple 503'), new AppleTransientError('aborted')]) {
      await db.execute(`DELETE FROM "AppleReconciliation"`);
      await enqueue();
      const out = await reconcileOnce('w1', { client: adapter, transport: transportOf(async () => { throw err; }) });
      expect(out.kind).toBe('transient');
      const j = await job();
      expect(String(j.reconcileState)).toBe('failed');
      expect(Number(j.attemptCount)).toBe(1);
      expect(String(j.nextAttemptAt) > iso(1_000)).toBe(true);
      expect(await subCount()).toBe(0);
    }
  });

  it('malformed and unverifiable responses cannot project entitlement', async () => {
    for (const t of [
      transportOf(async () => ({ environment: 'Production', data: [] })),
      transportOf(async () => { throw new AppleInvalidResponseError('bad jws'); }),
    ]) {
      await db.execute(`DELETE FROM "AppleReconciliation"`);
      await enqueue();
      expect((await reconcileOnce('w1', { client: adapter, transport: t })).kind).toBe('invalid');
      expect(await subCount()).toBe(0);
    }
  });

  // ── atomicity and recovery ─────────────────────────────────────────

  it('ATOMICITY: a snapshot write that fails inside the transaction rolls the CAS back', async () => {
    // A VALID Apple response, so the failure happens at the INSERT itself —
    // after the CAS has already succeeded inside the same transaction. A trigger
    // is used because nothing in the response can produce this.
    await db.execute(`
      CREATE TRIGGER "block_sub_insert" BEFORE INSERT ON "AppleSubscription"
      BEGIN SELECT RAISE(ABORT, 'snapshot write blocked'); END
    `);
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter, transport: transportOf(async () => statusResponse()),
    });
    // Apple's response was VALID; our database failed. That is not 'invalid'.
    expect(out.kind).toBe('persistence-failed');

    expect(await subCount()).toBe(0);                  // snapshot absent
    const j = await job();
    expect(String(j.reconcileState)).toBe('failed');   // durable failure, not due-now
    expect(Number(j.attemptCount)).toBe(1);            // counted
    expect(String(j.lastError)).toContain('snapshot persistence failed');
    expect(String(j.nextAttemptAt) > iso(1_000)).toBe(true);  // backed off, not hammering
    expect(j.leaseOwner).toBeNull();                   // lease released
    expect(Number(j.targetGeneration)).toBe(1);

    // And the work is genuinely recoverable once the write can succeed.
    await db.execute(`DROP TRIGGER "block_sub_insert"`);
    await db.execute({
      sql: `UPDATE "AppleReconciliation" SET "nextAttemptAt"=? WHERE "originalTransactionId"=?`,
      args: [iso(-1000), OTI],
    });
    expect((await reconcileOnce('w2', {
      client: adapter, transport: transportOf(async () => statusResponse()),
    })).kind).toBe('committed');
    expect(await subCount()).toBe(1);
  });

  it('RECOVERY: pending/failed work survives a restart and reconciles later', async () => {
    await enqueue();
    await reconcileOnce('w1', {
      client: adapter, transport: transportOf(async () => { throw new AppleTransientError('apple 500'); }),
    });
    expect(String((await job()).reconcileState)).toBe('failed');
    await db.execute({
      sql: `UPDATE "AppleReconciliation" SET "nextAttemptAt"=? WHERE "originalTransactionId"=?`,
      args: [iso(-1000), OTI],
    });
    expect((await reconcileOnce('w2', {
      client: adapter, transport: transportOf(async () => statusResponse()),
    })).kind).toBe('committed');
  });

  // ── scope guarantees ───────────────────────────────────────────────

  it('never writes User.plan — entitlement projection is a later stage', async () => {
    await enqueue();
    await reconcileOnce('w1', { client: adapter, transport: transportOf(async () => statusResponse()) });
    const u = (await db.execute(`SELECT "plan" FROM "User" WHERE "id"='user_1'`)).rows[0];
    expect(String(u.plan)).toBe('free');
  });

  it('returns idle when there is no work', async () => {
    expect((await reconcileOnce('w1', {
      client: adapter, transport: transportOf(async () => { throw new Error('must not be called'); }),
    })).kind).toBe('idle');
  });
});

describe('apple reconciler — verified group binding and duplicate refusal', () => {
  const OTI2 = '2000000123456789';
  const base = (over: Record<string, unknown> = {}): AppleStatusResponse => ({
    environment: 'Production',
    data: [{
      subscriptionGroupIdentifier: (over.outerGroup as string) ?? 'group-1',
      lastTransactions: [{
        outerOriginalTransactionId: OTI2,
        status: (over.status as number) ?? Status.ACTIVE,
        transaction: {
          transactionId: (over.transactionId as string) ?? 'txn-1',
          originalTransactionId: OTI2,
          productId: 'nala_pro_monthly',
          subscriptionGroupIdentifier: over.verifiedGroup as string | undefined,
          expiresDate: Date.now() + 86_400_000,
        },
        renewal: { originalTransactionId: OTI2, autoRenewStatus: 1 },
      }],
    }],
  });

  it('GROUP: persists the VERIFIED group, not the unsigned envelope copy', () => {
    const snap = buildSnapshot('Production', OTI2, base({ outerGroup: 'group-1', verifiedGroup: 'group-1' }));
    expect(snap.subscriptionGroupId).toBe('group-1');
  });

  it('GROUP: a disagreement between envelope and signed payload fails closed', () => {
    expect(() => buildSnapshot('Production', OTI2, base({ outerGroup: 'group-B', verifiedGroup: 'group-A' })))
      .toThrow(AppleInvalidResponseError);
  });

  it('GROUP: falls back to the envelope only when Apple omitted the signed copy', () => {
    const snap = buildSnapshot('Production', OTI2, base({ outerGroup: 'group-1', verifiedGroup: undefined }));
    expect(snap.subscriptionGroupId).toBe('group-1');
  });

  it('DUPLICATES: same transactionId but different STATUS is ambiguous, not collapsed', () => {
    const a = base({ status: Status.ACTIVE }).data[0].lastTransactions[0];
    const b = base({ status: Status.REVOKED }).data[0].lastTransactions[0];
    const resp: AppleStatusResponse = {
      environment: 'Production',
      data: [{ subscriptionGroupIdentifier: 'g', lastTransactions: [a, b] }],
    };
    // Equal transactionIds do NOT make these literal duplicates; taking [0]
    // would decide active-vs-revoked by array position.
    expect(() => selectEntry(resp, OTI2)).toThrow(/ambiguous/);
  });

  it('DUPLICATES: same transactionId in different GROUPS is ambiguous', () => {
    const resp: AppleStatusResponse = {
      environment: 'Production',
      data: [
        { subscriptionGroupIdentifier: 'group-A', lastTransactions: [base().data[0].lastTransactions[0]] },
        { subscriptionGroupIdentifier: 'group-B', lastTransactions: [base().data[0].lastTransactions[0]] },
      ],
    };
    expect(() => selectEntry(resp, OTI2)).toThrow(/ambiguous/);
  });
});
