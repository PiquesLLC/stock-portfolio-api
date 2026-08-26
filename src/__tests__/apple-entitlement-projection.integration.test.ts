import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { Status } from '@apple/app-store-server-library';
import fs from 'fs';
import path from 'path';
import {
  __TEST_ONLY_ENQUEUE_SQL,
  type QueueClient,
} from '../services/apple-reconciliation-queue.service';
import { reconcileOnce } from '../services/apple-reconciler.service';
import type { AppleStatusResponse, AppleTransport } from '../services/apple-server-api';
import { __resetAppleRateLimitersForTests } from '../services/apple-rate-limiter';
import {
  projectAppleEntitlementForUser,
  findBlockingAppleRail,
  userHasBlockingAppleRail,
  downgradeIfNotAppleOwned,
  evaluateAppleEntitlement,
  isEntitled,
  mayAppleCollect,
  blocksOtherBillingRail,
  toBooleanOrNull,
  parseTimestampOrNull,
  BillingRailConflictError,
  AppleProjectionDataError,
  APPLE_PURCHASE_SOURCE,
  type AppleSubscriptionFacts,
} from '../services/apple-entitlement-projection.service';

/**
 * Entitlement projection against a real libsql engine.
 *
 * Two things are being defended here and they are different:
 *
 *   1. The PREDICATES are exact. `isEntitled`, `mayAppleCollect` and
 *      `blocksOtherBillingRail` answer three different questions and must never
 *      be collapsed into one boolean. Every matrix case asserts all three, so a
 *      "simplification" that makes two of them agree fails loudly.
 *
 *   2. WHERE the projection runs is load-bearing. It happens inside the
 *      reconciler's generation-fenced CAS transaction, so a stale generation can
 *      never write a plan, and a projection failure rolls the snapshot back with
 *      it. Those two are proven against the real engine, not asserted in prose.
 */

const MIGRATION = path.join(
  __dirname, '..', '..', 'prisma', 'migrations',
  '20260824000000_apple_authoritative_state', 'migration.sql',
);

const OTI = '2000000123456789';
const PRODUCT = 'nala_pro_monthly';
const USER = 'user_1';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const iso = (d: Date) => d.toISOString();
const plus = (ms: number) => new Date(NOW.getTime() + ms);
const DAY = 86_400_000;

function facts(over: Partial<AppleSubscriptionFacts> = {}): AppleSubscriptionFacts {
  return {
    environment: 'Production',
    originalTransactionId: OTI,
    userId: USER,
    plan: 'pro',
    status: 'active',
    expiresAt: plus(30 * DAY),
    gracePeriodExpiresAt: null,
    autoRenewStatus: true,
    currentTransactionId: 'txn-1',
    ...over,
  };
}

// ── the frozen predicate matrix ────────────────────────────────────────────

describe('entitlement predicates (frozen)', () => {
  const matrix: Array<{
    name: string;
    f: AppleSubscriptionFacts;
    entitled: boolean; collect: boolean; blocks: boolean;
  }> = [
    { name: 'active, future expiry, auto-renew on',
      f: facts(), entitled: true, collect: true, blocks: true },

    { name: 'active, ELAPSED expiry',
      f: facts({ expiresAt: plus(-1) }), entitled: false, collect: true, blocks: true },

    { name: 'active, expiry EXACTLY now (equality is no longer entitled)',
      f: facts({ expiresAt: new Date(NOW.getTime()) }), entitled: false, collect: true, blocks: true },

    { name: 'active, MISSING expiry (never a zombie subscription)',
      f: facts({ expiresAt: null }), entitled: false, collect: true, blocks: true },

    // The frozen separation: entitled through expiry, but Apple will never charge again.
    { name: 'active, auto-renew OFF',
      f: facts({ autoRenewStatus: false }), entitled: true, collect: false, blocks: true },

    { name: 'active, auto-renew UNKNOWN (null is not true)',
      f: facts({ autoRenewStatus: null }), entitled: true, collect: false, blocks: true },

    { name: 'grace, inside the grace window',
      f: facts({ status: 'grace', expiresAt: plus(-DAY), gracePeriodExpiresAt: plus(5 * DAY) }),
      entitled: true, collect: true, blocks: true },

    { name: 'grace, AFTER the grace window',
      f: facts({ status: 'grace', expiresAt: plus(-DAY), gracePeriodExpiresAt: plus(-1) }),
      entitled: false, collect: true, blocks: true },

    { name: 'grace, MISSING gracePeriodExpiresAt',
      f: facts({ status: 'grace', gracePeriodExpiresAt: null }),
      entitled: false, collect: true, blocks: true },

    // The case that most tempts collapsing: no access, Apple still collecting,
    // Stripe still blocked.
    { name: 'billing_retry',
      f: facts({ status: 'billing_retry', expiresAt: plus(-DAY) }),
      entitled: false, collect: true, blocks: true },

    { name: 'expired', f: facts({ status: 'expired', expiresAt: plus(-DAY), autoRenewStatus: false }),
      entitled: false, collect: false, blocks: false },

    { name: 'revoked', f: facts({ status: 'revoked' }), entitled: false, collect: false, blocks: false },
  ];

  for (const c of matrix) {
    it(`${c.name} -> entitled=${c.entitled} collect=${c.collect} blocks=${c.blocks}`, () => {
      const p = evaluateAppleEntitlement(c.f, NOW);
      expect({ ...p }).toEqual({
        isEntitled: c.entitled,
        mayAppleCollect: c.collect,
        blocksOtherBillingRail: c.blocks,
      });
      // Same answers through the individual exports.
      expect(isEntitled(c.f, NOW)).toBe(c.entitled);
      expect(mayAppleCollect(c.f)).toBe(c.collect);
      expect(blocksOtherBillingRail(c.f)).toBe(c.blocks);
    });
  }

  it('the three predicates are genuinely independent', () => {
    // If any two were the same function, at least one of these would fail.
    const retry = facts({ status: 'billing_retry' });
    expect(isEntitled(retry, NOW)).toBe(false);
    expect(mayAppleCollect(retry)).toBe(true);

    const autoRenewOff = facts({ autoRenewStatus: false });
    expect(isEntitled(autoRenewOff, NOW)).toBe(true);
    expect(mayAppleCollect(autoRenewOff)).toBe(false);
    expect(blocksOtherBillingRail(autoRenewOff)).toBe(true);

    const expired = facts({ status: 'expired' });
    expect(blocksOtherBillingRail(expired)).toBe(false);
  });

  it('SQLite has no boolean: 0/1 normalize, junk becomes unknown not false', () => {
    expect(toBooleanOrNull(1)).toBe(true);
    expect(toBooleanOrNull(0)).toBe(false);
    expect(toBooleanOrNull(true)).toBe(true);
    expect(toBooleanOrNull(null)).toBe(null);
    expect(toBooleanOrNull(7)).toBe(null);
    // A raw integer 1 must satisfy mayAppleCollect's `=== true`.
    expect(mayAppleCollect(facts({ autoRenewStatus: toBooleanOrNull(1) }))).toBe(true);
    expect(mayAppleCollect(facts({ autoRenewStatus: toBooleanOrNull(0) }))).toBe(false);
  });

  it('unparseable timestamps fail closed rather than granting', () => {
    expect(parseTimestampOrNull('not-a-date')).toBe(null);
    expect(parseTimestampOrNull(null)).toBe(null);
    expect(isEntitled(facts({ expiresAt: parseTimestampOrNull('garbage') }), NOW)).toBe(false);
    // Both stored ISO shapes this database contains are understood.
    expect(parseTimestampOrNull('2026-06-02T00:00:00.000Z')?.toISOString())
      .toBe('2026-06-02T00:00:00.000Z');
    expect(parseTimestampOrNull('2026-06-02T00:00:00.000+00:00')?.toISOString())
      .toBe('2026-06-02T00:00:00.000Z');
  });
});

// ── projection against the real engine ─────────────────────────────────────

describe('apple entitlement projection (real engine)', () => {
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

  const user = async (id = USER) => (await db.execute({
    sql: `SELECT * FROM "User" WHERE "id"=?`, args: [id],
  })).rows[0] as Record<string, unknown>;

  const insertUser = async (over: Record<string, unknown> = {}) => {
    const u = {
      id: USER, plan: 'free', planExpiresAt: null, planStartedAt: null,
      stripeCustomerId: null, stripeSubscriptionId: null,
      applePurchaseSource: null, appleOriginalTransactionId: null, ...over,
    };
    await db.execute({
      sql: `INSERT OR REPLACE INTO "User"
        ("id","plan","planExpiresAt","planStartedAt","stripeCustomerId","stripeSubscriptionId","applePurchaseSource","appleOriginalTransactionId")
        VALUES (?,?,?,?,?,?,?,?)`,
      args: [u.id, u.plan, u.planExpiresAt, u.planStartedAt, u.stripeCustomerId,
             u.stripeSubscriptionId, u.applePurchaseSource, u.appleOriginalTransactionId] as never,
    });
  };

  const insertSub = async (over: Record<string, unknown> = {}) => {
    const s = {
      environment: 'Production', originalTransactionId: OTI, userId: USER,
      productId: PRODUCT, plan: 'pro', status: 'active',
      expiresAt: iso(plus(30 * DAY)), gracePeriodExpiresAt: null,
      autoRenewStatus: 1, currentTransactionId: 'txn-1', ...over,
    };
    await db.execute({
      sql: `INSERT INTO "AppleSubscription"
        ("id","environment","originalTransactionId","userId","productId","plan","status",
         "expiresAt","gracePeriodExpiresAt","autoRenewStatus","currentTransactionId",
         "appliedGeneration","createdAt","updatedAt")
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      args: [crypto.randomUUID(), s.environment, s.originalTransactionId, s.userId, s.productId,
             s.plan, s.status, s.expiresAt, s.gracePeriodExpiresAt, s.autoRenewStatus,
             s.currentTransactionId, iso(NOW), iso(NOW)] as never,
    });
  };

  const insertTxn = async (over: Record<string, unknown> = {}) => {
    const t = {
      environment: 'Production', transactionId: 'txn-1', originalTransactionId: OTI,
      productId: PRODUCT, purchaseDate: iso(plus(-30 * DAY)), revokedAt: null,
      revocationType: null, revocationPercentage: null, reversedAt: null, ...over,
    };
    await db.execute({
      sql: `INSERT INTO "AppleTransaction"
        ("id","environment","transactionId","originalTransactionId","productId","purchaseDate",
         "lastAppliedSignedDate","revokedAt","revocationType","revocationPercentage","reversedAt",
         "createdAt","updatedAt")
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [crypto.randomUUID(), t.environment, t.transactionId, t.originalTransactionId,
             t.productId, t.purchaseDate, iso(NOW), t.revokedAt, t.revocationType,
             t.revocationPercentage, t.reversedAt, iso(NOW), iso(NOW)] as never,
    });
  };

  beforeEach(async () => {
    __resetAppleRateLimitersForTests();
    db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE "User" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "plan" TEXT NOT NULL DEFAULT 'free',
      "planExpiresAt" DATETIME,
      "planStartedAt" DATETIME,
      "stripeCustomerId" TEXT,
      "stripeSubscriptionId" TEXT,
      "applePurchaseSource" TEXT,
      "appleOriginalTransactionId" TEXT, "appleAppAccountToken" TEXT
    )`);
    const sql = fs.readFileSync(MIGRATION, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';')) { const s = stmt.trim(); if (s) await db.execute(s); }
    await db.execute('PRAGMA foreign_keys = ON');
    await insertUser();
  });

  afterEach(() => { db.close(); __resetAppleRateLimitersForTests(); });

  // ── grant / downgrade semantics ──────────────────────────────────────────

  it('active + entitled -> plan and planExpiresAt come from the snapshot', async () => {
    await insertSub();
    const r = await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect(r.action).toBe('granted');

    const u = await user();
    expect(u.plan).toBe('pro');
    expect(String(u.planExpiresAt)).toBe(iso(plus(30 * DAY)));
    expect(u.applePurchaseSource).toBe(APPLE_PURCHASE_SOURCE);
    expect(String(u.planStartedAt)).toBe(iso(NOW));
  });

  it('grace -> planExpiresAt is the GRACE expiry, not the subscription expiry', async () => {
    await insertSub({
      status: 'grace', expiresAt: iso(plus(-DAY)), gracePeriodExpiresAt: iso(plus(5 * DAY)),
    });
    const r = await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect(r.action).toBe('granted');
    const u = await user();
    expect(u.plan).toBe('pro');
    expect(String(u.planExpiresAt)).toBe(iso(plus(5 * DAY)));
  });

  it('billing_retry -> no paid access, but the row still blocks Stripe', async () => {
    await insertUser({ plan: 'pro', planExpiresAt: iso(plus(-DAY)), applePurchaseSource: APPLE_PURCHASE_SOURCE });
    await insertSub({ status: 'billing_retry', expiresAt: iso(plus(-DAY)) });

    const r = await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect(r.action).toBe('downgraded');
    expect(r.predicates).toEqual({ isEntitled: false, mayAppleCollect: true, blocksOtherBillingRail: true });

    const u = await user();
    expect(u.plan).toBe('free');
    expect(u.planExpiresAt).toBe(null);
    // Still blocks the other rail even though the user now has nothing.
    expect(await userHasBlockingAppleRail(adapter, USER)).toBe(true);
  });

  it('expired -> Apple-owned plan is cleared', async () => {
    await insertUser({ plan: 'pro', planExpiresAt: iso(plus(-DAY)), applePurchaseSource: APPLE_PURCHASE_SOURCE });
    await insertSub({ status: 'expired', expiresAt: iso(plus(-DAY)) });
    expect((await projectAppleEntitlementForUser(adapter, USER, NOW)).action).toBe('downgraded');
    const u = await user();
    expect(u.plan).toBe('free');
    expect(u.planExpiresAt).toBe(null);
  });

  it('a paid plan is NEVER written with a null expiry (no zombie subscriptions)', async () => {
    // plan.middleware only downgrades when planExpiresAt is non-null, so a paid
    // plan with a null expiry would never expire.
    await insertSub({ expiresAt: null });
    const r = await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect(r.action).not.toBe('granted');
    const u = await user();
    expect(u.plan).toBe('free');
    expect(u.planExpiresAt).toBe(null);
  });

  it('an unknown plan fails CLOSED rather than silently downgrading', async () => {
    await insertUser({ plan: 'pro', planExpiresAt: iso(plus(10 * DAY)), applePurchaseSource: APPLE_PURCHASE_SOURCE });
    await insertSub({ plan: 'mystery_tier' });
    await expect(projectAppleEntitlementForUser(adapter, USER, NOW))
      .rejects.toBeInstanceOf(AppleProjectionDataError);
    // The paying customer keeps access; nothing was normalized to free.
    expect((await user()).plan).toBe('pro');
  });

  // ── planStartedAt ────────────────────────────────────────────────────────

  it('renewal of the SAME tier preserves planStartedAt', async () => {
    const started = iso(plus(-100 * DAY));
    await insertUser({ plan: 'pro', planStartedAt: started, planExpiresAt: iso(plus(DAY)), applePurchaseSource: APPLE_PURCHASE_SOURCE });
    await insertSub({ expiresAt: iso(plus(30 * DAY)) });

    await projectAppleEntitlementForUser(adapter, USER, NOW);
    const u = await user();
    expect(String(u.planStartedAt)).toBe(started);          // preserved
    expect(String(u.planExpiresAt)).toBe(iso(plus(30 * DAY))); // refreshed
  });

  it('an actual tier CHANGE restarts planStartedAt', async () => {
    await insertUser({ plan: 'pro', planStartedAt: iso(plus(-100 * DAY)), applePurchaseSource: APPLE_PURCHASE_SOURCE });
    await insertSub({ plan: 'elite', productId: 'nala_elite_monthly' });
    await projectAppleEntitlementForUser(adapter, USER, NOW);
    const u = await user();
    expect(u.plan).toBe('elite');
    expect(String(u.planStartedAt)).toBe(iso(NOW));
  });

  it('moving from free into Apple entitlement sets planStartedAt to now', async () => {
    await insertUser({ plan: 'free', planStartedAt: iso(plus(-500 * DAY)) });
    await insertSub();
    await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect(String((await user()).planStartedAt)).toBe(iso(NOW));
  });

  it('losing entitlement does NOT erase historical planStartedAt', async () => {
    const started = iso(plus(-100 * DAY));
    await insertUser({ plan: 'pro', planStartedAt: started, planExpiresAt: iso(plus(-DAY)), applePurchaseSource: APPLE_PURCHASE_SOURCE });
    await insertSub({ status: 'expired', expiresAt: iso(plus(-DAY)) });
    await projectAppleEntitlementForUser(adapter, USER, NOW);
    const u = await user();
    expect(u.plan).toBe('free');
    expect(String(u.planStartedAt)).toBe(started);
  });

  it('the Apple ownership marker survives expiry and revocation', async () => {
    await insertUser({ plan: 'pro', planExpiresAt: iso(plus(-DAY)), applePurchaseSource: APPLE_PURCHASE_SOURCE });
    await insertSub({ status: 'revoked' });
    await projectAppleEntitlementForUser(adapter, USER, NOW);
    // Failure mode B: clearing this on EXPIRED/REFUND destroys the ownership fact.
    expect((await user()).applePurchaseSource).toBe(APPLE_PURCHASE_SOURCE);
  });

  // ── revocation ───────────────────────────────────────────────────────────

  it('an unreversed revocation of the CURRENT transaction blocks the grant', async () => {
    await insertSub();                                     // status still says active
    await insertTxn({ revokedAt: iso(plus(-DAY)), revocationType: 'REFUND_FULL' });

    const r = await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect(r.revokedCurrentTransaction).toBe(true);
    expect(r.action).not.toBe('granted');
    expect((await user()).plan).toBe('free');
    // Conservative in both directions: no access, and Stripe stays blocked.
    expect(await userHasBlockingAppleRail(adapter, USER)).toBe(true);
  });

  it('refund TYPE and PERCENTAGE are not entitlement inputs', async () => {
    for (const [type, pct] of [['REFUND_PRORATED', 50], ['FAMILY_REVOKE', null], ['REFUND_FULL', 100]] as const) {
      await db.execute(`DELETE FROM "AppleTransaction"`);
      await db.execute(`DELETE FROM "AppleSubscription"`);
      await insertUser();
      await insertSub();
      await insertTxn({ revokedAt: iso(plus(-DAY)), revocationType: type, revocationPercentage: pct });
      const r = await projectAppleEntitlementForUser(adapter, USER, NOW);
      expect(r.revokedCurrentTransaction, `${type} must block`).toBe(true);
      expect((await user()).plan).toBe('free');
    }
  });

  it('a historical revoked transaction does NOT poison the current one', async () => {
    await insertSub({ currentTransactionId: 'txn-2' });
    await insertTxn({ transactionId: 'txn-1', revokedAt: iso(plus(-10 * DAY)), revocationType: 'REFUND_FULL' });
    await insertTxn({ transactionId: 'txn-2' });           // current, clean

    const r = await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect(r.revokedCurrentTransaction).toBe(false);
    expect(r.action).toBe('granted');
    expect((await user()).plan).toBe('pro');
  });

  it('a REVERSED revocation lifts the guard once state otherwise allows', async () => {
    await insertSub();
    await insertTxn({
      revokedAt: iso(plus(-5 * DAY)), revocationType: 'REFUND_FULL', reversedAt: iso(plus(-DAY)),
    });
    const r = await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect(r.revokedCurrentTransaction).toBe(false);
    expect(r.action).toBe('granted');
  });

  it('a reversal alone does not grant when Apple state says expired', async () => {
    await insertSub({ status: 'expired', expiresAt: iso(plus(-DAY)) });
    await insertTxn({ revokedAt: iso(plus(-5 * DAY)), reversedAt: iso(plus(-DAY)) });
    const r = await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect(r.action).not.toBe('granted');
    expect((await user()).plan).toBe('free');
  });

  // ── ownership and foreign rails ──────────────────────────────────────────

  it('an UNBOUND subscription projects onto nobody', async () => {
    await insertSub({ userId: null });
    expect(await findBlockingAppleRail(adapter, USER)).toBe(null);
    const r = await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect(r.action).toBe('no-op');
    expect((await user()).plan).toBe('free');
  });

  it('Apple expiry must NOT downgrade a plan Apple does not own', async () => {
    // A Stripe-owned plan, and a stale expired Apple row alongside it.
    await insertUser({ plan: 'premium', planExpiresAt: iso(plus(20 * DAY)), applePurchaseSource: null, stripeSubscriptionId: 'sub_live' });
    await insertSub({ status: 'expired', expiresAt: iso(plus(-DAY)) });

    const r = await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect(r.action).toBe('foreign-plan-preserved');
    const u = await user();
    expect(u.plan).toBe('premium');
    expect(String(u.planExpiresAt)).toBe(iso(plus(20 * DAY)));
  });

  it('Apple expiry DOES downgrade a plan Apple owns', async () => {
    await insertUser({ plan: 'premium', planExpiresAt: iso(plus(20 * DAY)), applePurchaseSource: APPLE_PURCHASE_SOURCE });
    await insertSub({ status: 'expired', expiresAt: iso(plus(-DAY)) });
    expect((await projectAppleEntitlementForUser(adapter, USER, NOW)).action).toBe('downgraded');
    expect((await user()).plan).toBe('free');
  });

  // ── Production / Sandbox isolation ───────────────────────────────────────

  it('a Sandbox subscription can never grant, and never blocks Stripe', async () => {
    await insertSub({ environment: 'Sandbox', status: 'active' });
    const r = await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect(r.action).toBe('no-op');
    expect((await user()).plan).toBe('free');
    expect(await userHasBlockingAppleRail(adapter, USER)).toBe(false);
  });

  it('a Production row wins over a Sandbox row for the same user', async () => {
    await insertSub({ environment: 'Sandbox', status: 'active', plan: 'elite' });
    await insertSub({ environment: 'Production', status: 'active', plan: 'pro' });
    await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect((await user()).plan).toBe('pro');
  });

  // ── billing-rail conflict ────────────────────────────────────────────────

  it('a blocking Apple rail + a live Stripe subscription is a CONFLICT, not a silent winner', async () => {
    await insertUser({ plan: 'pro', stripeSubscriptionId: 'sub_live', planExpiresAt: iso(plus(20 * DAY)) });
    await insertSub({ status: 'active' });

    await expect(projectAppleEntitlementForUser(adapter, USER, NOW))
      .rejects.toBeInstanceOf(BillingRailConflictError);

    // Nothing was changed and no Stripe field was cleared.
    const u = await user();
    expect(u.plan).toBe('pro');
    expect(u.stripeSubscriptionId).toBe('sub_live');
  });

  it('billing_retry conflicts too, even though User.plan reads free', async () => {
    await insertUser({ plan: 'free', stripeSubscriptionId: 'sub_live' });
    await insertSub({ status: 'billing_retry', expiresAt: iso(plus(-DAY)) });
    await expect(projectAppleEntitlementForUser(adapter, USER, NOW))
      .rejects.toBeInstanceOf(BillingRailConflictError);
  });

  it('an EXPIRED Apple row alongside Stripe is not a conflict', async () => {
    await insertUser({ plan: 'premium', stripeSubscriptionId: 'sub_live', applePurchaseSource: null });
    await insertSub({ status: 'expired', expiresAt: iso(plus(-DAY)) });
    const r = await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect(r.action).toBe('foreign-plan-preserved');
  });

  // ── cross-rail queries used by Stripe ────────────────────────────────────

  it('blocking statuses block Stripe; terminal statuses do not', async () => {
    for (const [status, blocks] of [
      ['active', true], ['grace', true], ['billing_retry', true],
      ['expired', false], ['revoked', false],
    ] as const) {
      await db.execute(`DELETE FROM "AppleSubscription"`);
      await insertSub({ status, gracePeriodExpiresAt: status === 'grace' ? iso(plus(DAY)) : null });
      expect(await userHasBlockingAppleRail(adapter, USER), `${status}`).toBe(blocks);
    }
  });

  it('a Sandbox row never blocks Stripe for an ordinary user', async () => {
    await insertSub({ environment: 'Sandbox', status: 'active' });
    expect(await userHasBlockingAppleRail(adapter, USER)).toBe(false);
  });

  // ── generation fencing, the adversarial case ─────────────────────────────

  const transportOf = (fn: AppleTransport['getAllSubscriptionStatuses']): AppleTransport =>
    ({ getAllSubscriptionStatuses: fn });

  const statusResponse = (over: { status?: number; productId?: string; expiresDate?: number } = {}): AppleStatusResponse => ({
    environment: 'Production',
    data: [{
      subscriptionGroupIdentifier: 'group-1',
      lastTransactions: [{
        outerOriginalTransactionId: OTI,
        status: over.status ?? Status.ACTIVE,
        transaction: {
          transactionId: 'txn-1', originalTransactionId: OTI,
          productId: over.productId ?? PRODUCT,
          expiresDate: over.expiresDate ?? NOW.getTime() + 30 * DAY,
          signedDate: NOW.getTime(),
        },
        renewal: {
          originalTransactionId: OTI, autoRenewStatus: 1,
          autoRenewProductId: over.productId ?? PRODUCT,
        },
      }],
    }],
  });

  const enqueue = async () => {
    const now = iso(NOW);
    await db.execute({
      sql: __TEST_ONLY_ENQUEUE_SQL,
      args: [crypto.randomUUID(), 'Production', OTI, now, now, now] as never,
    });
  };

  it('STALE GENERATION: G1 returning after G2 committed never writes a plan', async () => {
    /**
     * A BOUND row that is already entitled but has not been projected yet. That
     * matters: if the projection ran outside the CAS it would happily read this
     * persisted row and grant, with no fence at all. Deleting the row first (an
     * earlier version of this test) would have hidden exactly that defect.
     */
    await insertSub({ status: 'active', expiresAt: iso(plus(30 * DAY)) });
    expect((await user()).plan).toBe('free');
    await enqueue();

    // G1 is in flight when G2 arrives and bumps the target generation. The
    // enqueue happens from inside the transport, which is exactly the window a
    // real network call opens.
    const out = await reconcileOnce('w1', {
      client: adapter,
      now: () => NOW,
      transport: transportOf(async () => {
        await enqueue();                       // G2 requested mid-flight
        return statusResponse({ productId: 'nala_elite_monthly' });   // G1's answer: elite
      }),
    });

    expect(out.kind).toBe('stale');

    // G1 wrote NOTHING: not the snapshot, and not the plan.
    const u = await user();
    expect(u.plan).toBe('free');
    expect(u.planExpiresAt).toBe(null);
    expect(u.applePurchaseSource).toBe(null);
    const sub = (await db.execute(`SELECT * FROM "AppleSubscription"`)).rows[0];
    expect(String(sub.plan)).toBe('pro');            // still the pre-G1 row
    expect(Number(sub.appliedGeneration)).toBe(1);   // generation did not advance
  });

  it('the projection commits in the SAME transaction as the snapshot', async () => {
    // Bound, and currently expired: only the reconciliation can grant.
    await insertSub({ status: 'expired', expiresAt: iso(plus(-DAY)) });
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter, now: () => NOW,
      transport: transportOf(async () => statusResponse()),
    });
    expect(out.kind).toBe('committed');

    const u = await user();
    expect(u.plan).toBe('pro');
    expect(u.applePurchaseSource).toBe(APPLE_PURCHASE_SOURCE);
    const sub = (await db.execute(`SELECT * FROM "AppleSubscription"`)).rows[0];
    expect(String(sub.status)).toBe('active');
  });

  it('an UNBOUND row still commits its snapshot, with no user mutation', async () => {
    await db.execute({
      sql: `INSERT INTO "AppleSubscription"
        ("id","environment","originalTransactionId","userId","productId","plan","status",
         "appliedGeneration","createdAt","updatedAt") VALUES (?,?,?,NULL,?,?,?,0,?,?)`,
      args: [crypto.randomUUID(), 'Production', OTI, PRODUCT, 'pro', 'expired', iso(NOW), iso(NOW)] as never,
    });
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter, now: () => NOW,
      transport: transportOf(async () => statusResponse()),
    });
    expect(out.kind).toBe('committed');
    const sub = (await db.execute(`SELECT * FROM "AppleSubscription"`)).rows[0];
    expect(String(sub.status)).toBe('active');   // snapshot committed
    expect((await user()).plan).toBe('free');    // nobody projected onto
  });

  // ── atomicity under a REAL failure ───────────────────────────────────────

  it('ATOMICITY: a failing projection rolls back the snapshot and the queue transition', async () => {
    await insertSub({ status: 'expired', expiresAt: iso(plus(-DAY)) });
    await enqueue();

    // A real database-level failure on the User write, after the snapshot would
    // otherwise have been written.
    await db.executeMultiple(`CREATE TRIGGER block_user_write BEFORE UPDATE ON "User"
      BEGIN SELECT RAISE(ABORT, 'projection write blocked'); END;`);

    const out = await reconcileOnce('w1', {
      client: adapter, now: () => NOW,
      transport: transportOf(async () => statusResponse()),
    });
    expect(out.kind).toBe('persistence-failed');

    // Snapshot generation did NOT advance, plan did NOT change, job is retryable.
    const sub = (await db.execute(`SELECT * FROM "AppleSubscription"`)).rows[0];
    expect(String(sub.status)).toBe('expired');
    expect(Number(sub.appliedGeneration)).toBe(1);
    expect((await user()).plan).toBe('free');
    const job = (await db.execute(`SELECT * FROM "AppleReconciliation"`)).rows[0];
    expect(String(job.reconcileState)).not.toBe('done');
    expect(Number(job.attemptCount)).toBe(1);

    // Recovery: once the fault clears, the job comes back on its OWN backoff —
    // no hand-editing of queue internals, so this exercises the real path.
    await db.executeMultiple(`DROP TRIGGER block_user_write;`);
    const later = new Date(NOW.getTime() + 60_000);   // past BACKOFF_MS[1] = 30s
    const retry = await reconcileOnce('w2', {
      client: adapter, now: () => later,
      transport: transportOf(async () => statusResponse()),
    });
    expect(retry.kind).toBe('committed');
    const u = await user();
    expect(u.plan).toBe('pro');
    expect(String(u.planExpiresAt)).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString());

    // Exactly once: the job is done and there is still a single snapshot row.
    const after = (await db.execute(`SELECT * FROM "AppleReconciliation"`)).rows[0];
    expect(String(after.reconcileState)).toBe('done');
    const count = (await db.execute(`SELECT COUNT(*) n FROM "AppleSubscription"`)).rows[0];
    expect(Number(count.n)).toBe(1);
  });

  it('a RAIL CONFLICT parks permanently instead of hammering the queue', async () => {
    await insertUser({ plan: 'pro', stripeSubscriptionId: 'sub_live' });
    await insertSub({ status: 'expired', expiresAt: iso(plus(-DAY)) });
    await enqueue();

    const out = await reconcileOnce('w1', {
      client: adapter, now: () => NOW,
      transport: transportOf(async () => statusResponse()),
    });
    expect(out.kind).toBe('permanently-invalid');

    const job = (await db.execute(`SELECT * FROM "AppleReconciliation"`)).rows[0];
    // Parked far enough out that it will not be retried on the normal ladder.
    const nextAttempt = new Date(String(job.nextAttemptAt)).getTime();
    expect(nextAttempt - NOW.getTime()).toBeGreaterThan(365 * DAY);
    // And nothing was decided on the user's behalf.
    const u = await user();
    expect(u.plan).toBe('pro');
    expect(u.stripeSubscriptionId).toBe('sub_live');
  });
});

/**
 * The two review blockers, as regressions.
 *
 * Both concern the SECOND rail: what happens to Stripe state while Apple holds
 * the plan. Neither is the deferred simultaneous-purchase reservation problem —
 * these are ordinary ordering defects with concrete money consequences.
 */
describe('cross-rail durability and ordering', () => {
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

  const user = async () => (await db.execute({
    sql: `SELECT * FROM "User" WHERE "id"=?`, args: [USER],
  })).rows[0] as Record<string, unknown>;

  const insertUser = async (over: Record<string, unknown> = {}) => {
    const u = {
      plan: 'free', planExpiresAt: null, planStartedAt: null,
      stripeSubscriptionId: null, applePurchaseSource: null, ...over,
    };
    await db.execute({
      sql: `INSERT OR REPLACE INTO "User"
        ("id","plan","planExpiresAt","planStartedAt","stripeCustomerId","stripeSubscriptionId","applePurchaseSource","appleOriginalTransactionId")
        VALUES (?,?,?,?,NULL,?,?,NULL)`,
      args: [USER, u.plan, u.planExpiresAt, u.planStartedAt, u.stripeSubscriptionId, u.applePurchaseSource] as never,
    });
  };

  const insertSub = async (over: Record<string, unknown> = {}) => {
    const sb = { status: 'active', expiresAt: iso(plus(30 * DAY)), plan: 'pro', ...over };
    await db.execute({
      sql: `INSERT INTO "AppleSubscription"
        ("id","environment","originalTransactionId","userId","productId","plan","status",
         "expiresAt","autoRenewStatus","currentTransactionId","appliedGeneration","createdAt","updatedAt")
        VALUES (?,'Production',?,?,?,?,?,?,1,'txn-1',1,?,?)`,
      args: [crypto.randomUUID(), OTI, USER, PRODUCT, sb.plan, sb.status, sb.expiresAt, iso(NOW), iso(NOW)] as never,
    });
  };

  beforeEach(async () => {
    __resetAppleRateLimitersForTests();
    db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE "User" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "plan" TEXT NOT NULL DEFAULT 'free',
      "planExpiresAt" DATETIME, "planStartedAt" DATETIME,
      "stripeCustomerId" TEXT, "stripeSubscriptionId" TEXT,
      "applePurchaseSource" TEXT, "appleOriginalTransactionId" TEXT, "appleAppAccountToken" TEXT
    )`);
    const sql = fs.readFileSync(MIGRATION, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';')) { const t = stmt.trim(); if (t) await db.execute(t); }
    await db.execute('PRAGMA foreign_keys = ON');
    await insertUser();
  });

  afterEach(() => { db.close(); __resetAppleRateLimitersForTests(); });

  // ── blocker 2: the ownership guard must be decided AT the write ──────────

  it('TOCTOU: Apple claiming the plan mid-flight makes the Stripe downgrade a no-op', async () => {
    // 1. A Stripe downgrade handler begins while the plan is NOT Apple-owned.
    //    This is exactly the value the old code read and then trusted for the
    //    rest of the handler.
    await insertUser({ plan: 'pro', planExpiresAt: iso(plus(5 * DAY)), applePurchaseSource: null });
    expect((await user()).applePurchaseSource).toBe(null);

    // 2. An Apple reconciliation overtakes it: grants, and claims ownership.
    await insertSub();
    await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect((await user()).applePurchaseSource).toBe(APPLE_PURCHASE_SOURCE);

    // 3. Only NOW does the Stripe downgrade reach its write, still carrying the
    //    stale observation from step 1. Because the guard is part of the write,
    //    it matches zero rows instead of erasing a plan Apple just granted.
    const changed = await downgradeIfNotAppleOwned(adapter, USER, 'free', null, null);
    expect(changed).toBe(false);

    const u = await user();
    expect(u.plan).toBe('pro');
    expect(String(u.planExpiresAt)).toBe(iso(plus(30 * DAY)));
    expect(u.applePurchaseSource).toBe(APPLE_PURCHASE_SOURCE);
  });

  it('the guard still lets an ordinary Stripe downgrade through when the marker is NULL', async () => {
    // The SQL NULL trap: `applePurchaseSource <> 'app_store'` is NULL for these
    // rows, so a naive predicate would skip every ordinary Stripe user.
    await insertUser({ plan: 'pro', planExpiresAt: iso(plus(5 * DAY)), applePurchaseSource: null });
    expect(await downgradeIfNotAppleOwned(adapter, USER, 'free', null, null)).toBe(true);
    const u = await user();
    expect(u.plan).toBe('free');
    expect(u.planExpiresAt).toBe(null);
  });

  it('the guard lets a downgrade through for a non-Apple marker', async () => {
    await insertUser({ plan: 'pro', applePurchaseSource: 'some_other_source' });
    expect(await downgradeIfNotAppleOwned(adapter, USER, 'free', null, null)).toBe(true);
    expect((await user()).plan).toBe('free');
  });

  it('a downgrade preserves planStartedAt when the caller supplies none', async () => {
    const started = iso(plus(-200 * DAY));
    await insertUser({ plan: 'pro', planStartedAt: started, applePurchaseSource: null });
    await downgradeIfNotAppleOwned(adapter, USER, 'free', null, null);
    expect(String((await user()).planStartedAt)).toBe(started);
  });

  // ── blocker 1: a refused Stripe grant must leave a DURABLE conflict ──────

  it('CHAIN: a recorded Stripe rail turns a refused grant into a parked conflict', async () => {
    /**
     * Second half of the story that begins in billing.service.test.ts ("a Stripe
     * GRANT is refused while a blocking Apple rail exists"). That handler refuses
     * the plan but RECORDS stripeSubscriptionId, because Stripe may really be
     * charging the customer.
     *
     * Why recording it matters: the projector detects the double rail ONLY
     * through that non-null id. With it, the next reconciliation parks. Without
     * it — the bug this fixes — Apple grants normally and the conflict never
     * surfaces.
     */
    await insertUser({
      plan: 'pro', planExpiresAt: iso(plus(20 * DAY)),
      applePurchaseSource: APPLE_PURCHASE_SOURCE,
      stripeSubscriptionId: 'sub_x',          // recorded by the refused grant
    });
    await insertSub({ status: 'active' });

    await expect(projectAppleEntitlementForUser(adapter, USER, NOW))
      .rejects.toBeInstanceOf(BillingRailConflictError);

    // Nothing decided on the customer's behalf, and no Stripe field cleared.
    const u = await user();
    expect(u.plan).toBe('pro');
    expect(u.stripeSubscriptionId).toBe('sub_x');
  });

  it('CHAIN: without the recorded Stripe id the conflict would be INVISIBLE', async () => {
    // The same state minus the recorded subscription id — i.e. the old buggy
    // behaviour. Apple grants happily and nothing is ever parked. This test
    // makes the consequence of dropping that write explicit.
    await insertUser({ plan: 'free', stripeSubscriptionId: null });
    await insertSub({ status: 'active' });

    const r = await projectAppleEntitlementForUser(adapter, USER, NOW);
    expect(r.action).toBe('granted');     // no conflict raised: nothing to detect
    expect((await user()).plan).toBe('pro');
  });
});
