import { describe, it, expect, beforeEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import type { QueueClient } from '../services/apple-reconciliation-queue.service';
import {
  projectAppleEntitlementForUser,
  userHasProductionAppleSubscription,
  resolveProjectionEnvironment,
  parseSandboxProjectionPolicy,
  SANDBOX_PROJECTION_DISABLED,
  PRODUCTION_ENVIRONMENT,
  SANDBOX_ENVIRONMENT,
  APPLE_PURCHASE_SOURCE,
  BillingRailConflictError,
  type SandboxProjectionPolicy,
} from '../services/apple-entitlement-projection.service';
import { bindSubscriptionOwner } from '../services/apple-ownership.service';

/**
 * Controlled Sandbox entitlement projection.
 *
 * WHY THIS EXISTS: without it, Production would be the first environment where
 * the complete purchase -> backend authority -> plan -> unlock path ever runs.
 * The escape hatch is deliberately the narrowest possible: a server-side flag
 * AND a server-side allowlist of exact User ids. Nothing a client sends — a
 * header, a body field, an email, an appAccountToken, a JWS claim — can reach
 * the decision, and there is no NODE_ENV shortcut (TestFlight talks to the real
 * production backend, so NODE_ENV would be both wrong and useless).
 *
 * THE SHAPE OF THE GATE, and why it is gated where it is:
 *
 *   resolveProjectionEnvironment(snapshotEnv, boundUserId, policy)
 *     -> 'Production' | 'Sandbox' | null
 *   null  => the reconciler performs NO projection at all
 *   value => projectAppleEntitlementForUser READS ONLY that environment's rows
 *
 * Gating the whole projection rather than gating "may grant" keeps grant and
 * downgrade symmetric: an unallowlisted Sandbox reconciliation can neither hand
 * out a plan nor take one away. There is no half-gated path.
 *
 * Reading only the resolved environment's rows is what keeps the two
 * environments isolated for a QA account that holds both.
 */

const MIGRATION = path.join(
  __dirname, '..', '..', 'prisma', 'migrations',
  '20260824000000_apple_authoritative_state', 'migration.sql',
);

const OTI = '2000000123456789';
const PRODUCT = 'nala_pro_monthly';
const QA_USER = 'qa-user-0000-0000-0000-000000000001';
const OTHER_USER = 'other-user-0000-0000-0000-00000000002';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const iso = (d: Date) => d.toISOString();
const plus = (ms: number) => new Date(NOW.getTime() + ms);
const DAY = 86_400_000;

const allow = (...ids: string[]): SandboxProjectionPolicy =>
  ({ enabled: true, userIds: new Set(ids) });

// ── A. FLAG SAFETY — pure, no engine ─────────────────────────────────────────

describe('A. sandbox projection policy parsing (fails closed)', () => {
  const parse = (enabled?: string, ids?: string) =>
    parseSandboxProjectionPolicy({
      APPLE_SANDBOX_PROJECTION_ENABLED: enabled,
      APPLE_SANDBOX_PROJECTION_USER_IDS: ids,
    });

  it('flag unset / empty / malformed is FALSE — never silently enabled', () => {
    for (const v of [undefined, '', ' ', 'false', 'FALSE', 'TRUE', 'True', '1', 'yes', 'on', 'true ', ' true']) {
      expect(parse(v).enabled).toBe(false);
    }
    // Exactly one spelling turns it on.
    expect(parse('true').enabled).toBe(true);
  });

  it('allowlist unset / empty / whitespace / commas-only all mean NOBODY', () => {
    for (const v of [undefined, '', '   ', ',', ',,,', ' , , ', '\t', '\n']) {
      expect(parse('true', v).userIds.size).toBe(0);
    }
  });

  it('trims entries and deduplicates', () => {
    const p = parse('true', `  ${QA_USER} , ${QA_USER},${OTHER_USER}  ,`);
    expect(p.userIds.size).toBe(2);
    expect(p.userIds.has(QA_USER)).toBe(true);
    expect(p.userIds.has(OTHER_USER)).toBe(true);
  });

  it('does not normalise identities — a near-miss is not a match', () => {
    // No lowercasing, no trimming inside the value, no substring matching.
    const p = parse('true', QA_USER.toUpperCase());
    expect(p.userIds.has(QA_USER)).toBe(false);
    expect(parse('true', QA_USER.slice(0, -1)).userIds.has(QA_USER)).toBe(false);
    expect(parse('true', `${QA_USER}x`).userIds.has(QA_USER)).toBe(false);
  });

  it('malformed entries authorise nobody real', () => {
    const p = parse('true', 'not-a-uuid, qa@example.com, someusername, 2000000123456789');
    expect(p.userIds.has(QA_USER)).toBe(false);
    // They are retained verbatim rather than coerced — they simply never match.
    expect(p.userIds.has('qa@example.com')).toBe(true);
  });
});

describe('A/B. resolveProjectionEnvironment', () => {
  it('Production always projects, regardless of flag or allowlist', () => {
    for (const policy of [SANDBOX_PROJECTION_DISABLED, allow(), allow(QA_USER)]) {
      expect(resolveProjectionEnvironment(PRODUCTION_ENVIRONMENT, QA_USER, policy))
        .toBe(PRODUCTION_ENVIRONMENT);
      expect(resolveProjectionEnvironment(PRODUCTION_ENVIRONMENT, OTHER_USER, policy))
        .toBe(PRODUCTION_ENVIRONMENT);
    }
  });

  it('Sandbox does NOT project with the flag off, even for an allowlisted user', () => {
    expect(resolveProjectionEnvironment(SANDBOX_ENVIRONMENT, QA_USER, SANDBOX_PROJECTION_DISABLED))
      .toBeNull();
    expect(resolveProjectionEnvironment(SANDBOX_ENVIRONMENT, QA_USER,
      { enabled: false, userIds: new Set([QA_USER]) })).toBeNull();
  });

  it('Sandbox does NOT project with an empty allowlist — empty never means everyone', () => {
    expect(resolveProjectionEnvironment(SANDBOX_ENVIRONMENT, QA_USER, allow())).toBeNull();
  });

  it('Sandbox does NOT project for an unlisted user', () => {
    expect(resolveProjectionEnvironment(SANDBOX_ENVIRONMENT, OTHER_USER, allow(QA_USER))).toBeNull();
  });

  it('Sandbox projects ONLY for the exact allowlisted user', () => {
    expect(resolveProjectionEnvironment(SANDBOX_ENVIRONMENT, QA_USER, allow(QA_USER)))
      .toBe(SANDBOX_ENVIRONMENT);
  });

  it('multiple allowlisted ids work independently', () => {
    const p = allow(QA_USER, OTHER_USER);
    expect(resolveProjectionEnvironment(SANDBOX_ENVIRONMENT, QA_USER, p)).toBe(SANDBOX_ENVIRONMENT);
    expect(resolveProjectionEnvironment(SANDBOX_ENVIRONMENT, OTHER_USER, p)).toBe(SANDBOX_ENVIRONMENT);
    expect(resolveProjectionEnvironment(SANDBOX_ENVIRONMENT, 'third-user', p)).toBeNull();
  });

  it('an unbound subscription never projects, allowlisted or not', () => {
    expect(resolveProjectionEnvironment(SANDBOX_ENVIRONMENT, null, allow(QA_USER))).toBeNull();
  });

  it('an unrecognised environment fails closed', () => {
    for (const env of ['', 'sandbox', 'SANDBOX', 'production', 'Xcode', 'LocalTesting']) {
      expect(resolveProjectionEnvironment(env, QA_USER, allow(QA_USER))).toBeNull();
    }
  });

  it('nothing client-supplied can opt in — the policy is the ONLY input', () => {
    // The signature admits exactly three arguments: the AUTHORITATIVE snapshot
    // environment, the already-bound user id, and server config. There is no
    // parameter a request could influence. This test documents that by
    // construction; if someone adds a fourth, request-shaped argument they must
    // change this line.
    expect(resolveProjectionEnvironment.length).toBe(3);
  });
});

describe('A. the reconciler is actually wired to the gate', () => {
  // The engine tests below compose resolveProjectionEnvironment with
  // projectAppleEntitlementForUser exactly as the reconciler does. That would
  // still pass if the reconciler stopped using the gate, so pin the wiring at
  // the source. Cheaper and more honest than mocking the whole Apple transport.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'apple-reconciler.service.ts'), 'utf8',
  );

  it('resolves the projection environment and passes it to the projection', () => {
    expect(src).toMatch(/resolveProjectionEnvironment\(\s*[\r\n]?\s*snapshot\.environment, binding\.userId, sandboxPolicy,/);
    expect(src).toMatch(/projectAppleEntitlementForUser\(tx, binding\.userId, commitNow, projectionEnvironment\)/);
    expect(src).toMatch(/if \(!projectionEnvironment \|\| !binding\.userId\) return;/);
  });

  it('no longer carries a bare Production-only early return', () => {
    expect(src).not.toMatch(/snapshot\.environment !== PRODUCTION_ENVIRONMENT/);
  });

  it('defaults to the process environment, so production is closed by default', () => {
    expect(src).toMatch(/deps\.sandboxProjection \?\? parseSandboxProjectionPolicy\(process\.env\)/);
  });
});

// ── engine-backed behaviour ──────────────────────────────────────────────────

describe('sandbox projection against a real engine', () => {
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

  /** Exactly the composition the reconciler performs. */
  const project = async (environment: string, userId: string, policy: SandboxProjectionPolicy) => {
    const resolved = resolveProjectionEnvironment(environment, userId, policy);
    if (!resolved) return null;
    return projectAppleEntitlementForUser(adapter, userId, NOW, resolved);
  };

  const user = async (id: string) => (await db.execute({
    sql: `SELECT * FROM "User" WHERE "id"=?`, args: [id],
  })).rows[0] as Record<string, unknown> | undefined;

  const insertUser = async (over: Record<string, unknown> = {}) => {
    const u = {
      id: QA_USER, plan: 'free', planExpiresAt: null, planStartedAt: null,
      stripeCustomerId: null, stripeSubscriptionId: null,
      applePurchaseSource: null, appleOriginalTransactionId: null,
      appleAppAccountToken: null, ...over,
    };
    await db.execute({
      sql: `INSERT OR REPLACE INTO "User"
        ("id","plan","planExpiresAt","planStartedAt","stripeCustomerId","stripeSubscriptionId",
         "applePurchaseSource","appleOriginalTransactionId","appleAppAccountToken")
        VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [u.id, u.plan, u.planExpiresAt, u.planStartedAt, u.stripeCustomerId,
             u.stripeSubscriptionId, u.applePurchaseSource, u.appleOriginalTransactionId,
             u.appleAppAccountToken] as never,
    });
  };

  const insertSub = async (over: Record<string, unknown> = {}) => {
    const s = {
      environment: SANDBOX_ENVIRONMENT, originalTransactionId: OTI, userId: QA_USER,
      productId: PRODUCT, plan: 'pro', status: 'active',
      expiresAt: iso(plus(30 * DAY)), gracePeriodExpiresAt: null,
      autoRenewStatus: 1, currentTransactionId: 'txn-1', appAccountToken: null, ...over,
    };
    await db.execute({
      sql: `INSERT INTO "AppleSubscription"
        ("id","environment","originalTransactionId","userId","productId","plan","status",
         "expiresAt","gracePeriodExpiresAt","autoRenewStatus","currentTransactionId",
         "appAccountToken","appliedGeneration","createdAt","updatedAt")
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      args: [crypto.randomUUID(), s.environment, s.originalTransactionId, s.userId, s.productId,
             s.plan, s.status, s.expiresAt, s.gracePeriodExpiresAt, s.autoRenewStatus,
             s.currentTransactionId, s.appAccountToken, iso(NOW), iso(NOW)] as never,
    });
  };

  const insertTxn = async (over: Record<string, unknown> = {}) => {
    const t = {
      environment: SANDBOX_ENVIRONMENT, transactionId: 'txn-1', originalTransactionId: OTI,
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

  const countRows = async (table: string) =>
    Number((await db.execute(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0].n);

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE "User" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "plan" TEXT NOT NULL DEFAULT 'free',
      "planExpiresAt" DATETIME,
      "planStartedAt" DATETIME,
      "stripeCustomerId" TEXT,
      "stripeSubscriptionId" TEXT,
      "applePurchaseSource" TEXT,
      "appleOriginalTransactionId" TEXT,
      "appleAppAccountToken" TEXT
    )`);
    const sql = fs.readFileSync(MIGRATION, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';')) { const s = stmt.trim(); if (s) await db.execute(s); }
    await db.execute('PRAGMA foreign_keys = ON');
    await insertUser();
  });

  // ── B. ENVIRONMENT ISOLATION ───────────────────────────────────────────────

  describe('B. environment isolation', () => {
    it('Production projection still works exactly as before', async () => {
      await insertSub({ environment: PRODUCTION_ENVIRONMENT });
      await insertTxn({ environment: PRODUCTION_ENVIRONMENT });

      const r = await project(PRODUCTION_ENVIRONMENT, QA_USER, SANDBOX_PROJECTION_DISABLED);

      expect(r?.action).toBe('granted');
      expect((await user(QA_USER))?.plan).toBe('pro');
      expect((await user(QA_USER))?.applePurchaseSource).toBe(APPLE_PURCHASE_SOURCE);
    });

    it('Sandbox with the flag off does not touch User.plan', async () => {
      await insertSub();
      await insertTxn();

      expect(await project(SANDBOX_ENVIRONMENT, QA_USER, SANDBOX_PROJECTION_DISABLED)).toBeNull();
      expect((await user(QA_USER))?.plan).toBe('free');
      expect((await user(QA_USER))?.applePurchaseSource).toBeNull();
    });

    it('Sandbox for an unallowlisted user does not touch User.plan', async () => {
      await insertSub();
      await insertTxn();

      expect(await project(SANDBOX_ENVIRONMENT, QA_USER, allow(OTHER_USER))).toBeNull();
      expect((await user(QA_USER))?.plan).toBe('free');
    });

    it('Sandbox for the exact allowlisted user projects', async () => {
      await insertSub();
      await insertTxn();

      const r = await project(SANDBOX_ENVIRONMENT, QA_USER, allow(QA_USER));

      expect(r?.action).toBe('granted');
      expect((await user(QA_USER))?.plan).toBe('pro');
    });

    it('a Sandbox row NEVER participates in a Production projection', async () => {
      // Only Sandbox facts exist. A Production pass must find nothing, even for
      // an allowlisted user with the flag on.
      await insertSub({ status: 'active', expiresAt: iso(plus(30 * DAY)) });
      await insertTxn();

      const r = await project(PRODUCTION_ENVIRONMENT, QA_USER, allow(QA_USER));

      expect(r?.action).toBe('no-op');
      expect((await user(QA_USER))?.plan).toBe('free');
    });

    it('a Production row NEVER participates in a Sandbox QA projection', async () => {
      // Only Production facts exist, and they are entitled. A Sandbox pass for
      // the allowlisted user must not borrow them.
      await insertSub({ environment: PRODUCTION_ENVIRONMENT });
      await insertTxn({ environment: PRODUCTION_ENVIRONMENT });

      const r = await project(SANDBOX_ENVIRONMENT, QA_USER, allow(QA_USER));

      expect(r?.action).toBe('no-op');
      expect((await user(QA_USER))?.plan).toBe('free');
    });

    it('mixed Production + Sandbox rows for one user stay isolated', async () => {
      // Production: entitled elite. Sandbox: expired pro.
      await insertSub({
        environment: PRODUCTION_ENVIRONMENT, originalTransactionId: 'P-1',
        plan: 'elite', status: 'active', expiresAt: iso(plus(30 * DAY)),
        currentTransactionId: 'p-txn',
      });
      await insertTxn({ environment: PRODUCTION_ENVIRONMENT, transactionId: 'p-txn', originalTransactionId: 'P-1' });
      await insertSub({
        environment: SANDBOX_ENVIRONMENT, originalTransactionId: 'S-1',
        plan: 'pro', status: 'expired', expiresAt: iso(plus(-DAY)),
        autoRenewStatus: 0, currentTransactionId: 's-txn',
      });
      await insertTxn({ environment: SANDBOX_ENVIRONMENT, transactionId: 's-txn', originalTransactionId: 'S-1' });

      // Production pass sees elite, not the expired Sandbox row.
      const prod = await project(PRODUCTION_ENVIRONMENT, QA_USER, allow(QA_USER));
      expect(prod?.action).toBe('granted');
      expect(prod?.plan).toBe('elite');
      expect((await user(QA_USER))?.plan).toBe('elite');

      /**
       * The Sandbox pass must now do NOTHING.
       *
       * Reading only Sandbox rows is not sufficient isolation on its own:
       * User.plan and applePurchaseSource are global, and applePurchaseSource
       * says only 'app_store' — it carries no environment provenance. Without
       * the Production-presence veto the Sandbox pass would see an expired
       * Sandbox row plus an Apple-owned plan and downgrade an entitlement
       * PRODUCTION granted. That is a Sandbox test destroying real access.
       */
      const sandbox = await project(SANDBOX_ENVIRONMENT, QA_USER, allow(QA_USER));
      expect(sandbox?.action).toBe('no-op');
      expect(sandbox?.plan).toBeNull();
      // The Production row vetoed Sandbox; it was never used to compute a plan.
      expect(sandbox?.predicates).toBeNull();

      const after = await user(QA_USER);
      expect(after?.plan).toBe('elite');
      expect(after?.planExpiresAt).toBe(iso(plus(30 * DAY)));
    });
  });

  // ── B2. PRODUCTION-PRESENCE VETO ───────────────────────────────────────────

  describe('B2. a Production subscription vetoes Sandbox projection entirely', () => {
    const prodSub = (over: Record<string, unknown> = {}) => insertSub({
      environment: PRODUCTION_ENVIRONMENT, originalTransactionId: 'P-1',
      currentTransactionId: 'p-txn', ...over,
    });
    const prodTxn = () => insertTxn({
      environment: PRODUCTION_ENVIRONMENT, transactionId: 'p-txn', originalTransactionId: 'P-1',
    });
    const sandboxSub = (over: Record<string, unknown> = {}) => insertSub({
      environment: SANDBOX_ENVIRONMENT, originalTransactionId: 'S-1',
      currentTransactionId: 's-txn', ...over,
    });
    const sandboxTxn = () => insertTxn({
      environment: SANDBOX_ENVIRONMENT, transactionId: 's-txn', originalTransactionId: 'S-1',
    });

    it('the existence helper answers only yes/no', async () => {
      expect(await userHasProductionAppleSubscription(adapter, QA_USER)).toBe(false);
      await sandboxSub();
      expect(await userHasProductionAppleSubscription(adapter, QA_USER)).toBe(false);
      await prodSub({ status: 'expired', expiresAt: iso(plus(-DAY)) });
      expect(await userHasProductionAppleSubscription(adapter, QA_USER)).toBe(true);
    });

    it('1. Production active + Sandbox active => Sandbox cannot replace the Production plan', async () => {
      await prodSub({ plan: 'elite' });
      await prodTxn();
      await project(PRODUCTION_ENVIRONMENT, QA_USER, allow(QA_USER));
      expect((await user(QA_USER))?.plan).toBe('elite');

      await sandboxSub({ plan: 'pro', status: 'active' });
      await sandboxTxn();

      const r = await project(SANDBOX_ENVIRONMENT, QA_USER, allow(QA_USER));
      expect(r?.action).toBe('no-op');
      expect((await user(QA_USER))?.plan).toBe('elite');
    });

    it('2. Production active + Sandbox expired => Sandbox cannot downgrade', async () => {
      await prodSub({ plan: 'elite' });
      await prodTxn();
      await project(PRODUCTION_ENVIRONMENT, QA_USER, allow(QA_USER));

      await sandboxSub({ plan: 'pro', status: 'expired', expiresAt: iso(plus(-DAY)), autoRenewStatus: 0 });
      await sandboxTxn();

      const r = await project(SANDBOX_ENVIRONMENT, QA_USER, allow(QA_USER));
      expect(r?.action).toBe('no-op');
      expect((await user(QA_USER))?.plan).toBe('elite');
    });

    it('3. Production EXPIRED + Sandbox active => still no Sandbox projection', async () => {
      // Deliberately conservative: the veto is presence, not entitlement. Once
      // an account has any Production Apple history it is not a disposable QA
      // account, so the hatch stays shut.
      await prodSub({ status: 'expired', expiresAt: iso(plus(-DAY)), autoRenewStatus: 0 });
      await sandboxSub({ plan: 'pro', status: 'active' });
      await sandboxTxn();

      const r = await project(SANDBOX_ENVIRONMENT, QA_USER, allow(QA_USER));
      expect(r?.action).toBe('no-op');
      const u = await user(QA_USER);
      expect(u?.plan).toBe('free');
      expect(u?.applePurchaseSource).toBeNull();
    });

    it('4. a Sandbox-only account keeps the full lifecycle', async () => {
      await sandboxSub({ plan: 'pro', status: 'active' });
      await sandboxTxn();
      expect((await project(SANDBOX_ENVIRONMENT, QA_USER, allow(QA_USER)))?.action).toBe('granted');
      expect((await user(QA_USER))?.plan).toBe('pro');

      await db.execute({
        sql: `UPDATE "AppleSubscription" SET "status"='expired', "expiresAt"=? WHERE "environment"=?`,
        args: [iso(plus(-DAY)), SANDBOX_ENVIRONMENT] as never,
      });
      expect((await project(SANDBOX_ENVIRONMENT, QA_USER, allow(QA_USER)))?.action).toBe('downgraded');
      expect((await user(QA_USER))?.plan).toBe('free');
    });

    it('5. Sandbox grants first, then Production appears => Production wins and Sandbox is frozen out', async () => {
      // Clean QA account: Sandbox grants pro.
      await sandboxSub({ plan: 'pro', status: 'active' });
      await sandboxTxn();
      expect((await project(SANDBOX_ENVIRONMENT, QA_USER, allow(QA_USER)))?.action).toBe('granted');
      expect((await user(QA_USER))?.plan).toBe('pro');

      // A real Production subscription is later reconciled for the same user.
      await prodSub({ plan: 'elite', status: 'active' });
      await prodTxn();
      expect((await project(PRODUCTION_ENVIRONMENT, QA_USER, allow(QA_USER)))?.action).toBe('granted');
      expect((await user(QA_USER))?.plan).toBe('elite');

      // Every later Sandbox reconciliation is now inert, in both directions.
      await db.execute({
        sql: `UPDATE "AppleSubscription" SET "status"='expired', "expiresAt"=?
              WHERE "environment"=? AND "originalTransactionId"='S-1'`,
        args: [iso(plus(-DAY)), SANDBOX_ENVIRONMENT] as never,
      });
      expect((await project(SANDBOX_ENVIRONMENT, QA_USER, allow(QA_USER)))?.action).toBe('no-op');
      expect((await user(QA_USER))?.plan).toBe('elite');
    });

    it('6. a Production row on user A does not block Sandbox for allowlisted user B', async () => {
      await insertUser({ id: OTHER_USER });
      // User A holds Production Apple state.
      await insertSub({
        environment: PRODUCTION_ENVIRONMENT, originalTransactionId: 'P-A',
        userId: QA_USER, currentTransactionId: 'pa-txn',
      });
      // User B is a clean QA account with only Sandbox state.
      await insertSub({
        environment: SANDBOX_ENVIRONMENT, originalTransactionId: 'S-B',
        userId: OTHER_USER, plan: 'pro', status: 'active', currentTransactionId: 'sb-txn',
      });
      await insertTxn({ environment: SANDBOX_ENVIRONMENT, transactionId: 'sb-txn', originalTransactionId: 'S-B' });

      expect(await userHasProductionAppleSubscription(adapter, OTHER_USER)).toBe(false);

      const r = await project(SANDBOX_ENVIRONMENT, OTHER_USER, allow(OTHER_USER));
      expect(r?.action).toBe('granted');
      expect((await user(OTHER_USER))?.plan).toBe('pro');
      // User A untouched.
      expect((await user(QA_USER))?.plan).toBe('free');
    });

    it('7. flag-off / unallowlisted behaviour is unchanged by the veto', async () => {
      await sandboxSub({ plan: 'pro', status: 'active' });
      await sandboxTxn();

      expect(await project(SANDBOX_ENVIRONMENT, QA_USER, SANDBOX_PROJECTION_DISABLED)).toBeNull();
      expect(await project(SANDBOX_ENVIRONMENT, QA_USER, allow(OTHER_USER))).toBeNull();
      expect((await user(QA_USER))?.plan).toBe('free');
    });

    it('Production projection itself is completely unaffected by the veto', async () => {
      // The veto is scoped to non-Production environments. A user with both
      // kinds of row still gets a normal Production projection, including a
      // normal Production downgrade.
      await prodSub({ plan: 'elite' });
      await prodTxn();
      await sandboxSub({ plan: 'pro', status: 'active' });
      await project(PRODUCTION_ENVIRONMENT, QA_USER, allow(QA_USER));
      expect((await user(QA_USER))?.plan).toBe('elite');

      await db.execute({
        sql: `UPDATE "AppleSubscription" SET "status"='expired', "expiresAt"=?
              WHERE "environment"=? AND "originalTransactionId"='P-1'`,
        args: [iso(plus(-DAY)), PRODUCTION_ENVIRONMENT] as never,
      });
      expect((await project(PRODUCTION_ENVIRONMENT, QA_USER, allow(QA_USER)))?.action).toBe('downgraded');
      expect((await user(QA_USER))?.plan).toBe('free');
    });
  });

  // ── C. FULL PLAN LIFECYCLE for the allowlisted Sandbox user ────────────────

  describe('C. full lifecycle for an allowlisted Sandbox user', () => {
    const policy = () => allow(QA_USER);

    it('active => paid plan with the subscription expiry', async () => {
      await insertSub();
      await insertTxn();
      const r = await project(SANDBOX_ENVIRONMENT, QA_USER, policy());
      expect(r?.action).toBe('granted');
      expect(r?.plan).toBe('pro');
      expect((await user(QA_USER))?.planExpiresAt).toBe(iso(plus(30 * DAY)));
    });

    it('grace => still entitled, expiry tracks the grace window', async () => {
      await insertSub({
        status: 'grace', expiresAt: iso(plus(-DAY)),
        gracePeriodExpiresAt: iso(plus(5 * DAY)),
      });
      await insertTxn();
      const r = await project(SANDBOX_ENVIRONMENT, QA_USER, policy());
      expect(r?.action).toBe('granted');
      expect(r?.planExpiresAt?.toISOString()).toBe(iso(plus(5 * DAY)));
    });

    it('billing_retry => NOT entitled (frozen predicate unchanged in Sandbox)', async () => {
      await insertSub({ status: 'billing_retry', expiresAt: iso(plus(-DAY)) });
      await insertTxn();
      const r = await project(SANDBOX_ENVIRONMENT, QA_USER, policy());
      expect(r?.predicates?.isEntitled).toBe(false);
      expect(r?.predicates?.mayAppleCollect).toBe(true);
      expect(r?.action).toBe('no-op'); // nothing Apple owns yet
    });

    it('cancellation (auto-renew off) stays entitled through expiry', async () => {
      await insertSub({ autoRenewStatus: 0 });
      await insertTxn();
      const r = await project(SANDBOX_ENVIRONMENT, QA_USER, policy());
      expect(r?.action).toBe('granted');
      expect(r?.predicates?.isEntitled).toBe(true);
      expect(r?.predicates?.mayAppleCollect).toBe(false);
    });

    it('expiry after a grant DOWNGRADES the allowlisted Sandbox user', async () => {
      await insertSub();
      await insertTxn();
      await project(SANDBOX_ENVIRONMENT, QA_USER, policy());
      expect((await user(QA_USER))?.plan).toBe('pro');

      await db.execute({
        sql: `UPDATE "AppleSubscription" SET "status"='expired', "expiresAt"=?, "autoRenewStatus"=0
              WHERE "environment"=?`,
        args: [iso(plus(-DAY)), SANDBOX_ENVIRONMENT] as never,
      });

      const r = await project(SANDBOX_ENVIRONMENT, QA_USER, policy());
      expect(r?.action).toBe('downgraded');
      const u = await user(QA_USER);
      expect(u?.plan).toBe('free');
      // Both durable markers survive the downgrade, exactly as in Production.
      expect(u?.applePurchaseSource).toBe(APPLE_PURCHASE_SOURCE);
      expect(u?.planStartedAt).not.toBeNull();
    });

    it('refund (revoked transaction) removes the grant', async () => {
      await insertSub();
      await insertTxn({ revokedAt: iso(plus(-1)), revocationType: 'REFUND_FULL' });
      const r = await project(SANDBOX_ENVIRONMENT, QA_USER, policy());
      expect(r?.revokedCurrentTransaction).toBe(true);
      expect(r?.action).toBe('no-op'); // entitled facts, but revoked => no grant
      expect((await user(QA_USER))?.plan).toBe('free');
    });

    it('the allowlist gates DOWNGRADE as well as GRANT — no half-gated path', async () => {
      // Grant while allowlisted.
      await insertSub();
      await insertTxn();
      await project(SANDBOX_ENVIRONMENT, QA_USER, policy());
      expect((await user(QA_USER))?.plan).toBe('pro');

      // The subscription expires...
      await db.execute({
        sql: `UPDATE "AppleSubscription" SET "status"='expired', "expiresAt"=? WHERE "environment"=?`,
        args: [iso(plus(-DAY)), SANDBOX_ENVIRONMENT] as never,
      });

      // ...but the user is no longer allowlisted. Sandbox must not downgrade
      // either. Refusing the whole projection is what makes this symmetric.
      expect(await project(SANDBOX_ENVIRONMENT, QA_USER, allow(OTHER_USER))).toBeNull();
      expect((await user(QA_USER))?.plan).toBe('pro');
    });
  });

  // ── D. BILLING-RAIL SAFETY ─────────────────────────────────────────────────

  describe('D. Stripe rail protection is unchanged in Sandbox', () => {
    it('Sandbox cannot overwrite a plan Stripe owns', async () => {
      await insertUser({ plan: 'premium', applePurchaseSource: null, planExpiresAt: iso(plus(10 * DAY)) });
      await insertSub({ status: 'expired', expiresAt: iso(plus(-DAY)) });
      await insertTxn();

      const r = await project(SANDBOX_ENVIRONMENT, QA_USER, allow(QA_USER));

      // Apple does not own this plan, so it is preserved, not downgraded.
      expect(r?.action).toBe('foreign-plan-preserved');
      expect((await user(QA_USER))?.plan).toBe('premium');
    });

    it('a blocking Sandbox rail + live Stripe subscription still raises the conflict', async () => {
      await insertUser({ stripeSubscriptionId: 'sub_live_123' });
      await insertSub(); // active => rail-blocking
      await insertTxn();

      await expect(project(SANDBOX_ENVIRONMENT, QA_USER, allow(QA_USER)))
        .rejects.toBeInstanceOf(BillingRailConflictError);
      // Conservative: the job parks, and nothing was written.
      expect((await user(QA_USER))?.plan).toBe('free');
    });
  });

  // ── E. OWNERSHIP is unchanged — the allowlist never CLAIMS a subscription ──

  describe('E. ownership rules are untouched', () => {
    it('the allowlist does not bind an unbound subscription', async () => {
      // Unbound Sandbox row, no token, no legacy owner.
      await insertSub({ userId: null });

      const binding = await bindSubscriptionOwner(
        adapter, { environment: SANDBOX_ENVIRONMENT, originalTransactionId: OTI }, NOW,
      );

      expect(binding.outcome).toBe('unbound');
      expect(binding.userId).toBeNull();
      // And with no bound user, the gate refuses regardless of the allowlist.
      expect(resolveProjectionEnvironment(SANDBOX_ENVIRONMENT, binding.userId, allow(QA_USER)))
        .toBeNull();
    });

    it('an unknown present appAccountToken binds nobody and does not fall back to OTI', async () => {
      // A surviving user carries the legacy OTI, which WOULD bind if the token
      // were absent. The present-but-unknown token must block that fallback.
      await insertUser({ id: OTHER_USER, appleOriginalTransactionId: OTI });
      await insertSub({ userId: null, appAccountToken: 'token-nobody-owns' });

      const binding = await bindSubscriptionOwner(
        adapter, { environment: SANDBOX_ENVIRONMENT, originalTransactionId: OTI }, NOW,
      );

      expect(binding.outcome).toBe('unbound');
      expect(binding.userId).toBeNull();
    });
  });

  // ── F. FLAG-OFF BEHAVIOUR ──────────────────────────────────────────────────

  describe('F. turning the flag off', () => {
    it('stops future Sandbox projection but does NOT revert an existing plan', async () => {
      await insertSub();
      await insertTxn();
      await project(SANDBOX_ENVIRONMENT, QA_USER, allow(QA_USER));
      const granted = await user(QA_USER);
      expect(granted?.plan).toBe('pro');

      // Flag off. Future Sandbox passes do nothing at all...
      expect(await project(SANDBOX_ENVIRONMENT, QA_USER, SANDBOX_PROJECTION_DISABLED)).toBeNull();

      // ...and the previously granted plan is deliberately left alone. There is
      // no automatic entitlement rollback on flag-off: cleaning up disposable QA
      // accounts is an explicit later operation, not a side effect of config.
      const after = await user(QA_USER);
      expect(after?.plan).toBe('pro');
      expect(after?.planExpiresAt).toBe(granted?.planExpiresAt);
      expect(after?.applePurchaseSource).toBe(APPLE_PURCHASE_SOURCE);
    });
  });

  // ── G. ACCOUNT DELETION / APPLE RETENTION ──────────────────────────────────

  describe('G. account deletion vs retained Apple facts', () => {
    it('deleting the User leaves the subscription with userId NULL', async () => {
      await insertSub({ appAccountToken: 'tok-qa' });
      await db.execute({ sql: `DELETE FROM "User" WHERE "id"=?`, args: [QA_USER] as never });

      const rows = (await db.execute(`SELECT "userId" FROM "AppleSubscription"`)).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBeNull();
    });

    it('transaction / notification / reconciliation facts survive deletion', async () => {
      await insertSub();
      await insertTxn();
      await db.execute({
        sql: `INSERT INTO "AppleNotification"
          ("id","environment","notificationUUID","notificationType","signedDate",
           "originalTransactionId","outcome","receivedAt")
          VALUES (?,?,?,?,?,?,?,?)`,
        args: [crypto.randomUUID(), SANDBOX_ENVIRONMENT, crypto.randomUUID(),
               'DID_RENEW', iso(NOW), OTI, 'applied', iso(NOW)] as never,
      });
      await db.execute({
        sql: `INSERT INTO "AppleReconciliation"
          ("id","environment","originalTransactionId","targetGeneration","reconcileState",
           "attemptCount","nextAttemptAt","createdAt","updatedAt")
          VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [crypto.randomUUID(), SANDBOX_ENVIRONMENT, OTI, 1, 'done', 0,
               iso(NOW), iso(NOW), iso(NOW)] as never,
      });

      await db.execute({ sql: `DELETE FROM "User" WHERE "id"=?`, args: [QA_USER] as never });

      expect(await countRows('AppleSubscription')).toBe(1);
      expect(await countRows('AppleTransaction')).toBe(1);
      expect(await countRows('AppleNotification')).toBe(1);
      expect(await countRows('AppleReconciliation')).toBe(1);
    });

    it('a tokenized survivor stays unbound — a present token blocks legacy fallback', async () => {
      // A DIFFERENT surviving user carries the same legacy OTI. The deleted
      // user's token is still on the row and now resolves to nobody, and #42
      // says a present token decides, including when it decides nobody.
      await insertUser({ id: OTHER_USER, appleOriginalTransactionId: OTI });
      await insertSub({ appAccountToken: 'tok-deleted-user' });
      await db.execute({ sql: `DELETE FROM "User" WHERE "id"=?`, args: [QA_USER] as never });

      const binding = await bindSubscriptionOwner(
        adapter, { environment: SANDBOX_ENVIRONMENT, originalTransactionId: OTI }, NOW,
      );

      expect(binding.outcome).toBe('unbound');
      expect(binding.userId).toBeNull();
    });

    it('a tokenless survivor with NO legacy owner stays unbound', async () => {
      await insertSub({ appAccountToken: null });
      await db.execute({ sql: `DELETE FROM "User" WHERE "id"=?`, args: [QA_USER] as never });

      const binding = await bindSubscriptionOwner(
        adapter, { environment: SANDBOX_ENVIRONMENT, originalTransactionId: OTI }, NOW,
      );

      expect(binding.outcome).toBe('unbound');
      expect(binding.userId).toBeNull();
    });

    it('a tokenless survivor with EXACTLY ONE legacy OTI owner rebinds (documented existing behaviour)', async () => {
      // NOT a bug and NOT introduced here: under the frozen #42 compatibility
      // rules a tokenless subscription may still legitimately rebind to a
      // surviving user carrying the same transitional appleOriginalTransactionId.
      // Making deletion permanently extinguish legacy reclaimability would be a
      // SEPARATE policy change and must never be smuggled in here.
      await insertUser({ id: OTHER_USER, appleOriginalTransactionId: OTI });
      await insertSub({ appAccountToken: null });
      await db.execute({ sql: `DELETE FROM "User" WHERE "id"=?`, args: [QA_USER] as never });

      const binding = await bindSubscriptionOwner(
        adapter, { environment: SANDBOX_ENVIRONMENT, originalTransactionId: OTI }, NOW,
      );

      expect(binding.outcome).toBe('bound-by-legacy-oti');
      expect(binding.userId).toBe(OTHER_USER);
    });

    it('MULTIPLE legacy candidate owners => unbound (defense in depth)', async () => {
      // User.appleOriginalTransactionId is @unique, so a real engine cannot
      // produce two rows. Dropping the index to manufacture it would test an
      // invalid schema state, so the query is stubbed instead — this guards
      // against corrupted data, not a normal state.
      await insertSub({ userId: null, appAccountToken: null });

      const twoOwners: QueueClient = {
        ...adapter,
        $queryRawUnsafe: async <T,>(sql: string, ...args: unknown[]) => {
          if (sql.includes('"appleOriginalTransactionId" = ?')) {
            return [{ id: QA_USER }, { id: OTHER_USER }] as T[];
          }
          return adapter.$queryRawUnsafe<T>(sql, ...args);
        },
      };

      const binding = await bindSubscriptionOwner(
        twoOwners, { environment: SANDBOX_ENVIRONMENT, originalTransactionId: OTI }, NOW,
      );

      expect(binding.outcome).toBe('unbound');
      expect(binding.userId).toBeNull();
    });
  });
});
