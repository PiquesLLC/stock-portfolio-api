import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import {
  __TEST_ONLY_ENQUEUE_SQL,
  type QueueClient,
  type AppleEnvironment,
} from '../services/apple-reconciliation-queue.service';
import { reconcileOnce } from '../services/apple-reconciler.service';
import {
  createPurchaseContext,
  issueAppAccountToken,
  activatePurchase,
  restoreAppleSubscriptions,
  AppleStripeRailActiveError,
  AppleOwnershipRejectedError,
  ApplePostChargeRailConflictError,
  AppleWorkerUnavailableError,
  MAX_RESTORE_TRANSACTIONS,
} from '../services/apple-activation.service';
import {
  bindSubscriptionOwner,
  AppleOwnershipConflictError,
} from '../services/apple-ownership.service';
import {
  AppleVerificationPermanentError,
  AppleVerificationTransientError,
  type AppleVerifier,
} from '../services/apple-verifier';
import type { DecodedTransaction, AppleStatusResponse, AppleTransport } from '../services/apple-server-api';
import { __resetAppleRateLimitersForTests } from '../services/apple-rate-limiter';
import { Status } from '@apple/app-store-server-library';

/**
 * Apple purchase ownership, against a real libsql engine.
 *
 * THE PROPERTY UNDER TEST:
 *
 *   Possessing a valid signed Apple transaction is not a claim to it.
 *
 * The path this replaces took the originalTransactionId out of a client-supplied
 * JWS and wrote it onto whichever account was calling, so anyone holding someone
 * else's signed transaction could attach that subscription to their own account.
 * Ownership now rests on a token the SERVER minted, which Apple echoes back
 * inside the signed payload.
 */

const MIGRATION = path.join(
  __dirname, '..', '..', 'prisma', 'migrations',
  '20260824000000_apple_authoritative_state', 'migration.sql',
);

const OTI = '2000000123456789';
const PRODUCT = 'nala_pro_monthly';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const DAY = 86_400_000;
const at = (ms: number) => NOW.getTime() + ms;

function txn(over: Partial<DecodedTransaction> = {}): DecodedTransaction {
  return {
    transactionId: 'txn-1',
    originalTransactionId: OTI,
    productId: PRODUCT,
    purchaseDate: at(-DAY),
    expiresDate: at(30 * DAY),
    signedDate: at(0),
    environment: 'Production',
    ...over,
  } as DecodedTransaction;
}

/** Maps a JWS string to a verified payload; unknown strings fail permanently. */
function verifierFor(
  table: Record<string, { environment: AppleEnvironment; transaction: DecodedTransaction }>,
  opts: { transientEnvironments?: AppleEnvironment[] } = {},
): AppleVerifier {
  return {
    async verifyNotification() { throw new Error('not used'); },
    async verifyRenewal() { throw new Error('not used'); },
    async verifyTransaction(environment, jws) {
      if (opts.transientEnvironments?.includes(environment)) {
        throw new AppleVerificationTransientError('ocsp unreachable');
      }
      const entry = table[jws];
      if (!entry || entry.environment !== environment) {
        throw new AppleVerificationPermanentError('not verifiable in this environment');
      }
      return entry.transaction;
    },
  };
}

describe('apple activation and ownership (real engine)', () => {
  let db: Client;

  const adapter: QueueClient = {
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) =>
      Number((await db.execute({ sql, args: args as never })).rowsAffected),
    $queryRawUnsafe: async <T,>(sql: string, ...args: unknown[]) =>
      (await db.execute({ sql, args: args as never })).rows as T[],
    $transaction: async <T,>(fn: (tx: QueueClient) => Promise<T>): Promise<T> => {
      await db.execute('BEGIN');
      try { const out = await fn(adapter); await db.execute('COMMIT'); return out; }
      catch (err) {
        try { await db.execute('ROLLBACK'); } catch { /* already unwound */ }
        throw err;
      }
    },
  };

  const deps = (over: Partial<Parameters<typeof activatePurchase>[2]> = {}) => ({
    verifier: verifierFor({}),
    workerAvailable: () => true,
    client: adapter,
    now: () => NOW,
    ...over,
  });

  const rows = async (t: string) =>
    (await db.execute(`SELECT * FROM "${t}"`)).rows as Record<string, unknown>[];
  const user = async (id: string) =>
    (await db.execute({ sql: `SELECT * FROM "User" WHERE "id"=?`, args: [id] })).rows[0] as Record<string, unknown>;

  const addUser = async (id: string, over: Record<string, unknown> = {}) => {
    const u = { plan: 'free', stripeSubscriptionId: null, appleAppAccountToken: null, appleOriginalTransactionId: null, ...over };
    await db.execute({
      sql: `INSERT INTO "User" ("id","plan","planExpiresAt","planStartedAt","stripeSubscriptionId","applePurchaseSource","appleOriginalTransactionId","appleAppAccountToken")
            VALUES (?,?,NULL,NULL,?,NULL,?,?)`,
      args: [id, u.plan, u.stripeSubscriptionId, u.appleOriginalTransactionId, u.appleAppAccountToken] as never,
    });
  };

  const addSubscription = async (over: Record<string, unknown> = {}) => {
    const s = {
      environment: 'Production', originalTransactionId: OTI, userId: null,
      plan: 'pro', status: 'active', appAccountToken: null, ...over,
    };
    await db.execute({
      sql: `INSERT INTO "AppleSubscription"
        ("id","environment","originalTransactionId","userId","productId","plan","status",
         "expiresAt","autoRenewStatus","appAccountToken","currentTransactionId","appliedGeneration","createdAt","updatedAt")
        VALUES (?,?,?,?,?,?,?,?,1,?,'txn-1',1,?,?)`,
      args: [crypto.randomUUID(), s.environment, s.originalTransactionId, s.userId, PRODUCT,
        s.plan, s.status, new Date(at(30 * DAY)).toISOString(), s.appAccountToken,
        NOW.toISOString(), NOW.toISOString()] as never,
    });
  };

  beforeEach(async () => {
    __resetAppleRateLimitersForTests();
    db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE "User" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "plan" TEXT NOT NULL DEFAULT 'free',
      "planExpiresAt" DATETIME, "planStartedAt" DATETIME,
      "stripeSubscriptionId" TEXT, "applePurchaseSource" TEXT,
      "appleOriginalTransactionId" TEXT,
      "appleAppAccountToken" TEXT
    )`);
    await db.execute(`CREATE UNIQUE INDEX "User_appleAppAccountToken_key" ON "User"("appleAppAccountToken")`);
    const sql = fs.readFileSync(MIGRATION, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';')) { const t = stmt.trim(); if (t) await db.execute(t); }
    await db.execute('PRAGMA foreign_keys = ON');
    await addUser('user_a');
    await addUser('user_b');
  });

  afterEach(() => { db.close(); __resetAppleRateLimitersForTests(); });

  // ── purchase context ────────────────────────────────────────────────────

  it('issues a stable server-generated token and reuses it', async () => {
    const first = await createPurchaseContext('user_a', deps());
    const second = await createPurchaseContext('user_a', deps());
    expect(first.appAccountToken).toBe(second.appAccountToken);
    expect(first.appAccountToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    // Never the account id, and never anything the client supplied.
    expect(first.appAccountToken).not.toBe('user_a');
  });

  it('CONCURRENT purchase-context calls persist ONE token', async () => {
    /**
     * Two tokens for one account would be silent data loss: the purchase made
     * with the discarded UUID would come back from Apple resolving to nobody.
     */
    const results = await Promise.all([
      issueAppAccountToken('user_a', deps()),
      issueAppAccountToken('user_a', deps()),
      issueAppAccountToken('user_a', deps()),
    ]);
    expect(new Set(results).size).toBe(1);
    expect(String((await user('user_a')).appleAppAccountToken)).toBe(results[0]);
  });

  it('REFUSES a purchase when a Stripe rail exists, even at plan free', async () => {
    // A non-null subscription id means Stripe may still collect through dunning.
    await addUser('user_stripe', { plan: 'free', stripeSubscriptionId: 'sub_live' });
    await expect(createPurchaseContext('user_stripe', deps()))
      .rejects.toBeInstanceOf(AppleStripeRailActiveError);
    expect((await user('user_stripe')).appleAppAccountToken).toBe(null);   // no token minted
  });

  it('REFUSES a purchase when reconciliation is unavailable', async () => {
    // Sending a customer into StoreKit that the backend cannot honour takes
    // their money and grants nothing.
    await expect(createPurchaseContext('user_a', deps({ workerAvailable: () => false })))
      .rejects.toBeInstanceOf(AppleWorkerUnavailableError);
    expect((await user('user_a')).appleAppAccountToken).toBe(null);
  });

  it('an existing Apple rail does NOT block purchase context', async () => {
    // Upgrades and downgrades go through StoreKit.
    const token = await issueAppAccountToken('user_a', deps());
    await addSubscription({ userId: 'user_a', appAccountToken: token });
    await expect(createPurchaseContext('user_a', deps())).resolves.toMatchObject({ appAccountToken: token });
  });

  // ── activation ownership ────────────────────────────────────────────────

  it('accepts a purchase carrying THIS account’s token and queues reconciliation', async () => {
    const token = await issueAppAccountToken('user_a', deps());
    const t = txn({ appAccountToken: token });
    const r = await activatePurchase('user_a', 'jws', deps({
      verifier: verifierFor({ jws: { environment: 'Production', transaction: t } }),
    }));

    expect(r.status).toBe('pending');
    const job = (await rows('AppleReconciliation'))[0];
    expect(String(job.originalTransactionId)).toBe(OTI);
    expect(Number(job.targetGeneration)).toBe(1);

    // No entitlement was granted by the request.
    const u = await user('user_a');
    expect({ plan: u.plan, exp: u.planExpiresAt, src: u.applePurchaseSource })
      .toEqual({ plan: 'free', exp: null, src: null });
  });

  it('REJECTS a purchase carrying another account’s token', async () => {
    const tokenB = await issueAppAccountToken('user_b', deps());
    await expect(activatePurchase('user_a', 'jws', deps({
      verifier: verifierFor({ jws: { environment: 'Production', transaction: txn({ appAccountToken: tokenB }) } }),
    }))).rejects.toBeInstanceOf(AppleOwnershipRejectedError);

    expect(await rows('AppleReconciliation')).toHaveLength(0);
    expect((await user('user_a')).appleOriginalTransactionId).toBe(null);
  });

  it('REJECTS an unregistered token — a client cannot mint its own', async () => {
    /**
     * A modified client picking a random UUID must not be able to register it by
     * sending it. Apple's fact may exist; Nala binds nobody.
     */
    await expect(activatePurchase('user_a', 'jws', deps({
      verifier: verifierFor({ jws: { environment: 'Production', transaction: txn({ appAccountToken: crypto.randomUUID() }) } }),
    }))).rejects.toBeInstanceOf(AppleOwnershipRejectedError);
    expect(await rows('AppleReconciliation')).toHaveLength(0);
  });

  it('a TOKENLESS purchase cannot create new ownership', async () => {
    await expect(activatePurchase('user_a', 'jws', deps({
      verifier: verifierFor({ jws: { environment: 'Production', transaction: txn() } }),
    }))).rejects.toBeInstanceOf(AppleOwnershipRejectedError);
    expect(await rows('AppleReconciliation')).toHaveLength(0);
  });

  it('a TOKENLESS purchase INHERITS ownership from an existing subscription binding', async () => {
    await addSubscription({ userId: 'user_a' });
    const r = await activatePurchase('user_a', 'jws', deps({
      verifier: verifierFor({ jws: { environment: 'Production', transaction: txn() } }),
    }));
    expect(r.status).toBe('pending');
    expect(await rows('AppleReconciliation')).toHaveLength(1);
  });

  it('a TOKENLESS purchase INHERITS ownership from the transitional OTI column', async () => {
    await addUser('user_legacy', { appleOriginalTransactionId: OTI });
    const r = await activatePurchase('user_legacy', 'jws', deps({
      verifier: verifierFor({ jws: { environment: 'Production', transaction: txn() } }),
    }));
    expect(r.status).toBe('pending');
  });

  it('a TOKENLESS purchase owned by someone else is refused', async () => {
    await addSubscription({ userId: 'user_b' });
    await expect(activatePurchase('user_a', 'jws', deps({
      verifier: verifierFor({ jws: { environment: 'Production', transaction: txn() } }),
    }))).rejects.toBeInstanceOf(AppleOwnershipRejectedError);
  });

  it('an unknown product fails closed', async () => {
    const token = await issueAppAccountToken('user_a', deps());
    await expect(activatePurchase('user_a', 'jws', deps({
      verifier: verifierFor({ jws: { environment: 'Production', transaction: txn({ appAccountToken: token, productId: 'nala_mystery' }) } }),
    }))).rejects.toBeInstanceOf(AppleVerificationPermanentError);
    expect(await rows('AppleReconciliation')).toHaveLength(0);
  });

  it('a transient verification failure is transient, not "invalid purchase"', async () => {
    await expect(activatePurchase('user_a', 'jws', deps({
      verifier: verifierFor({}, { transientEnvironments: ['Production', 'Sandbox'] }),
    }))).rejects.toBeInstanceOf(AppleVerificationTransientError);
  });

  it('environment comes from verification, not from the request', async () => {
    const token = await issueAppAccountToken('user_a', deps());
    const r = await activatePurchase('user_a', 'jws', deps({
      verifier: verifierFor({ jws: { environment: 'Sandbox', transaction: txn({ appAccountToken: token, environment: 'Sandbox' }) } }),
    }));
    expect(r.environment).toBe('Sandbox');
    expect(String((await rows('AppleReconciliation'))[0].environment)).toBe('Sandbox');
  });

  // ── the post-charge Stripe race ─────────────────────────────────────────

  it('POST-CHARGE RACE: a Stripe rail appearing after the Apple charge still records the purchase', async () => {
    /**
     * Apple already has the customer's money by the time a signed transaction
     * exists. Discarding the Apple fact to keep a tidy database would erase a
     * purchase they actually made — so the enqueue must survive the 409.
     */
    const token = await issueAppAccountToken('user_a', deps());
    await db.execute(`UPDATE "User" SET "stripeSubscriptionId"='sub_live' WHERE "id"='user_a'`);

    await expect(activatePurchase('user_a', 'jws', deps({
      verifier: verifierFor({ jws: { environment: 'Production', transaction: txn({ appAccountToken: token }) } }),
    }))).rejects.toBeInstanceOf(ApplePostChargeRailConflictError);

    // The conflict is reported, and the work is still durably queued.
    const job = (await rows('AppleReconciliation'))[0];
    expect(job).toBeDefined();
    expect(String(job.originalTransactionId)).toBe(OTI);
  });

  // ── binding, inside the fence ───────────────────────────────────────────

  const transportOf = (fn: AppleTransport['getAllSubscriptionStatuses']): AppleTransport =>
    ({ getAllSubscriptionStatuses: fn });

  const statusResponse = (over: { appAccountToken?: string; oti?: string } = {}): AppleStatusResponse => ({
    environment: 'Production',
    data: [{
      subscriptionGroupIdentifier: 'group-1',
      lastTransactions: [{
        outerOriginalTransactionId: over.oti ?? OTI,
        status: Status.ACTIVE,
        transaction: {
          transactionId: 'txn-1', originalTransactionId: over.oti ?? OTI, productId: PRODUCT,
          expiresDate: at(30 * DAY), signedDate: at(0),
          appAccountToken: over.appAccountToken,
        },
        renewal: { originalTransactionId: over.oti ?? OTI, autoRenewStatus: 1, autoRenewProductId: PRODUCT },
      }],
    }],
  });

  const enqueue = async (oti = OTI, environment: AppleEnvironment = 'Production') => {
    const iso = NOW.toISOString();
    await db.execute({
      sql: __TEST_ONLY_ENQUEUE_SQL,
      args: [crypto.randomUUID(), environment, oti, iso, iso, iso] as never,
    });
  };

  it('WEBHOOK BEFORE CLIENT: the authoritative token binds the user with no client request', async () => {
    /**
     * The client verify endpoint must not be required to establish ownership.
     * Apple can notify first, and the token inside the authoritative snapshot is
     * enough.
     */
    const token = await issueAppAccountToken('user_a', deps());
    await enqueue();

    const out = await reconcileOnce('w1', {
      client: adapter, now: () => NOW,
      transport: transportOf(async () => statusResponse({ appAccountToken: token })),
    });
    expect(out.kind).toBe('committed');

    const sub = (await rows('AppleSubscription'))[0];
    expect(String(sub.userId)).toBe('user_a');
    // Compatibility dual-write, Production only.
    expect(String((await user('user_a')).appleOriginalTransactionId)).toBe(OTI);
    // And entitlement was projected by the projector, not by any request.
    expect(String((await user('user_a')).plan)).toBe('pro');
  });

  it('an ARBITRARY unregistered token binds NOBODY', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter, now: () => NOW,
      transport: transportOf(async () => statusResponse({ appAccountToken: crypto.randomUUID() })),
    });
    expect(out.kind).toBe('committed');

    const sub = (await rows('AppleSubscription'))[0];
    expect(sub.userId).toBe(null);          // fact recorded, nobody bound
    expect(String((await user('user_a')).plan)).toBe('free');
    expect(String((await user('user_b')).plan)).toBe('free');
  });

  it('a token belonging to another account never rebinds an owned subscription', async () => {
    const tokenB = await issueAppAccountToken('user_b', deps());
    await addSubscription({ userId: 'user_a' });
    await enqueue();

    const out = await reconcileOnce('w1', {
      client: adapter, now: () => NOW,
      transport: transportOf(async () => statusResponse({ appAccountToken: tokenB })),
    });
    expect(out.kind).toBe('permanently-invalid');   // parked for an operator

    expect(String((await rows('AppleSubscription'))[0].userId)).toBe('user_a');   // unchanged
  });

  it('a token conflicting with the transitional OTI column is an ownership conflict', async () => {
    const tokenA = await issueAppAccountToken('user_a', deps());
    await db.execute(`UPDATE "User" SET "appleOriginalTransactionId"='${OTI}' WHERE "id"='user_b'`);
    await enqueue();

    const out = await reconcileOnce('w1', {
      client: adapter, now: () => NOW,
      transport: transportOf(async () => statusResponse({ appAccountToken: tokenA })),
    });
    expect(out.kind).toBe('permanently-invalid');

    // Nobody's link was stolen or deleted.
    expect(String((await user('user_b')).appleOriginalTransactionId)).toBe(OTI);
    expect((await rows('AppleSubscription'))[0]?.userId ?? null).toBe(null);
  });

  it('a tokenless snapshot may inherit legacy ownership', async () => {
    await db.execute(`UPDATE "User" SET "appleOriginalTransactionId"='${OTI}' WHERE "id"='user_a'`);
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter, now: () => NOW,
      transport: transportOf(async () => statusResponse()),
    });
    expect(out.kind).toBe('committed');
    expect(String((await rows('AppleSubscription'))[0].userId)).toBe('user_a');
  });

  it('binding is direct: an existing owner is never silently reassigned', async () => {
    await addSubscription({ userId: 'user_a' });
    const r = await bindSubscriptionOwner(adapter, { environment: 'Production', originalTransactionId: OTI }, NOW);
    expect(r).toEqual({ outcome: 'already-bound', userId: 'user_a' });
  });

  it('a conflicting owner raises the TYPED ownership error, not a generic failure', async () => {
    // The type is what routes it to permanent parking rather than a retry ladder.
    const tokenB = await issueAppAccountToken('user_b', deps());
    await addSubscription({ userId: 'user_a', appAccountToken: tokenB });
    await expect(
      bindSubscriptionOwner(adapter, { environment: 'Production', originalTransactionId: OTI }, NOW),
    ).rejects.toBeInstanceOf(AppleOwnershipConflictError);
    expect(String((await rows('AppleSubscription'))[0].userId)).toBe('user_a');
  });

  it('SANDBOX binds for audit but never projects Production entitlement', async () => {
    const token = await issueAppAccountToken('user_a', deps());
    await enqueue(OTI, 'Sandbox');

    const out = await reconcileOnce('w1', {
      client: adapter, now: () => NOW,
      transport: transportOf(async () => ({
        environment: 'Sandbox',
        data: [{
          subscriptionGroupIdentifier: 'group-1',
          lastTransactions: [{
            outerOriginalTransactionId: OTI, status: Status.ACTIVE,
            transaction: {
              transactionId: 'txn-1', originalTransactionId: OTI, productId: PRODUCT,
              expiresDate: at(30 * DAY), signedDate: at(0), appAccountToken: token,
              environment: 'Sandbox',
            },
            renewal: { originalTransactionId: OTI, autoRenewStatus: 1, autoRenewProductId: PRODUCT, environment: 'Sandbox' },
          }],
        }],
      })),
    });
    expect(out.kind).toBe('committed');

    const sub = (await rows('AppleSubscription'))[0];
    expect(String(sub.environment)).toBe('Sandbox');
    expect(String(sub.userId)).toBe('user_a');            // bound for audit
    expect(String((await user('user_a')).plan)).toBe('free');   // but NOT projected
    expect((await user('user_a')).appleOriginalTransactionId).toBe(null);  // no dual-write
  });

  it('STALE GENERATION cannot bind', async () => {
    const token = await issueAppAccountToken('user_a', deps());
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter, now: () => NOW,
      transport: transportOf(async () => {
        await enqueue();      // G2 arrives mid-flight
        return statusResponse({ appAccountToken: token });
      }),
    });
    expect(out.kind).toBe('stale');
    expect(await rows('AppleSubscription')).toHaveLength(0);
    expect(String((await user('user_a')).plan)).toBe('free');
  });

  it('a projection failure rolls a fresh BINDING back with it', async () => {
    const token = await issueAppAccountToken('user_a', deps());
    await enqueue();
    await db.executeMultiple(`CREATE TRIGGER block_user BEFORE UPDATE ON "User"
      WHEN NEW."plan" IS NOT OLD."plan" BEGIN SELECT RAISE(ABORT, 'projection blocked'); END;`);

    const out = await reconcileOnce('w1', {
      client: adapter, now: () => NOW,
      transport: transportOf(async () => statusResponse({ appAccountToken: token })),
    });
    expect(out.kind).toBe('persistence-failed');

    // Binding, snapshot and queue transition all rolled back together.
    expect(await rows('AppleSubscription')).toHaveLength(0);
    expect(String((await rows('AppleReconciliation'))[0].reconcileState)).not.toBe('done');
  });

  // ── restore ─────────────────────────────────────────────────────────────

  it('restore queues every qualified subscription and grants nothing', async () => {
    const token = await issueAppAccountToken('user_a', deps());
    const r = await restoreAppleSubscriptions('user_a', ['j1', 'j2'], deps({
      verifier: verifierFor({
        j1: { environment: 'Production', transaction: txn({ appAccountToken: token }) },
        j2: { environment: 'Production', transaction: txn({ appAccountToken: token, originalTransactionId: 'OTI-2', transactionId: 'txn-2' }) },
      }),
    }));
    expect(r).toEqual({ status: 'pending', queued: 2 });
    expect(await rows('AppleReconciliation')).toHaveLength(2);
    expect(String((await user('user_a')).plan)).toBe('free');
  });

  it('restore DEDUPES multiple JWS for the same subscription into one request', async () => {
    // The old implementation picked whichever had the largest expiry; there is
    // no "latest JWS wins" any more.
    const token = await issueAppAccountToken('user_a', deps());
    const r = await restoreAppleSubscriptions('user_a', ['j1', 'j2', 'j3'], deps({
      verifier: verifierFor({
        j1: { environment: 'Production', transaction: txn({ appAccountToken: token, expiresDate: at(DAY) }) },
        j2: { environment: 'Production', transaction: txn({ appAccountToken: token, expiresDate: at(90 * DAY) }) },
        j3: { environment: 'Production', transaction: txn({ appAccountToken: token, expiresDate: at(45 * DAY) }) },
      }),
    }));
    expect(r.queued).toBe(1);
    const jobs = await rows('AppleReconciliation');
    expect(jobs).toHaveLength(1);
    expect(Number(jobs[0].targetGeneration)).toBe(1);
  });

  it('restore skips another account’s purchases without failing the whole call', async () => {
    const tokenA = await issueAppAccountToken('user_a', deps());
    const tokenB = await issueAppAccountToken('user_b', deps());
    const r = await restoreAppleSubscriptions('user_a', ['mine', 'theirs'], deps({
      verifier: verifierFor({
        mine: { environment: 'Production', transaction: txn({ appAccountToken: tokenA }) },
        theirs: { environment: 'Production', transaction: txn({ appAccountToken: tokenB, originalTransactionId: 'OTI-B' }) },
      }),
    }));
    expect(r.queued).toBe(1);
    expect(String((await rows('AppleReconciliation'))[0].originalTransactionId)).toBe(OTI);
  });

  it('restore ignores unregistered tokens and unknown products', async () => {
    const r = await restoreAppleSubscriptions('user_a', ['unknown-token', 'bad-product'], deps({
      verifier: verifierFor({
        'unknown-token': { environment: 'Production', transaction: txn({ appAccountToken: crypto.randomUUID() }) },
        'bad-product': { environment: 'Production', transaction: txn({ productId: 'nala_mystery', originalTransactionId: 'OTI-X' }) },
      }),
    }));
    expect(r).toEqual({ status: 'no-restorable-purchases', queued: 0 });
    expect(await rows('AppleReconciliation')).toHaveLength(0);
  });

  it('restore of a tokenless purchase works only through existing ownership', async () => {
    await addSubscription({ userId: 'user_a' });
    const r = await restoreAppleSubscriptions('user_a', ['j1'], deps({
      verifier: verifierFor({ j1: { environment: 'Production', transaction: txn() } }),
    }));
    expect(r.queued).toBe(1);

    const none = await restoreAppleSubscriptions('user_b', ['j1'], deps({
      verifier: verifierFor({ j1: { environment: 'Production', transaction: txn() } }),
    }));
    expect(none.status).toBe('no-restorable-purchases');
  });

  it('a TRANSIENT verifier failure during restore is never "you own nothing"', async () => {
    // Converting an incomplete security check into absence of entitlement would
    // tell a paying customer they have no purchases because our OCSP was down.
    await expect(restoreAppleSubscriptions('user_a', ['j1'], deps({
      verifier: verifierFor({}, { transientEnvironments: ['Production', 'Sandbox'] }),
    }))).rejects.toBeInstanceOf(AppleVerificationTransientError);
  });

  it('restore refuses an oversized batch rather than doing unbounded OCSP work', async () => {
    const many = Array.from({ length: MAX_RESTORE_TRANSACTIONS + 1 }, (_, i) => `j${i}`);
    await expect(restoreAppleSubscriptions('user_a', many, deps()))
      .rejects.toBeInstanceOf(AppleVerificationPermanentError);
  });

  it('restore with nothing restorable does not assert plan=free', async () => {
    const r = await restoreAppleSubscriptions('user_a', [], deps());
    expect(r).toEqual({ status: 'no-restorable-purchases', queued: 0 });
    expect(r).not.toHaveProperty('plan');
  });

  // ── source boundary ─────────────────────────────────────────────────────

  it('activation and ownership contain no entitlement writes', () => {
    /**
     * Strips comments first. These files DESCRIBE the legacy behaviour they
     * replaced, naming those columns in prose; the assertion is about what the
     * code does, not what the documentation mentions.
     */
    const stripComments = (src: string): string => src
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    const read = (p: string) =>
      stripComments(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
    for (const file of ['services/apple-activation.service.ts', 'services/apple-ownership.service.ts']) {
      const src = read(file);
      for (const forbidden of ['planExpiresAt', 'planStartedAt', 'applePurchaseSource']) {
        expect(src, `${file} mentions ${forbidden}`).not.toContain(forbidden);
      }
      expect(/UPDATE\s+"User"\s+SET\s+"plan"/i.test(src), `${file} writes User.plan`).toBe(false);
      // Projection stays behind the reconciler's fence.
      expect(src).not.toContain('projectAppleEntitlementForUser');
      // No synchronous Apple Server API call from a request path.
      expect(src).not.toContain('getAllSubscriptionStatuses');
    }
  });

  it('the legacy verifier singleton and duplicate product map are gone', () => {
    expect(fs.existsSync(path.join(__dirname, '..', 'services/apple-iap.service.ts'))).toBe(false);
    const controller = fs.readFileSync(path.join(__dirname, '..', 'controllers/apple-iap.controller.ts'), 'utf8');
    expect(controller).not.toContain('verifyAndActivatePlan');
    expect(controller).not.toContain('already have an active subscription');   // no message sniffing
    expect(controller).toContain('AppleOwnershipRejectedError');
  });
});
