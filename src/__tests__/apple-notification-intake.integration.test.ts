import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import type { QueueClient, AppleEnvironment } from '../services/apple-reconciliation-queue.service';
import {
  ingestAppleNotification,
  decodeEnvironmentHint,
  RECONCILE_NOTIFICATION_TYPES,
  NO_RECONCILE_NOTIFICATION_TYPES,
} from '../services/apple-notification-intake.service';
import {
  AppleVerificationPermanentError,
  AppleVerificationTransientError,
  type AppleVerifier,
  type DecodedNotification,
} from '../services/apple-verifier';
import type { DecodedTransaction, DecodedRenewal } from '../services/apple-server-api';

/**
 * Authoritative notification intake against a real libsql engine.
 *
 * The verifier is stubbed on purpose. Its cryptography is covered by
 * apple-trust-boundary.integration.test.ts; what matters HERE is what intake
 * does with a verification result — which facts it persists, which it refuses,
 * and above all that a webhook can never establish entitlement.
 *
 * The stub mimics the real verifier's most important property: it is
 * per-environment, so a payload only verifies under the environment it actually
 * belongs to. Intake cannot be handed a "correct" environment by a caller.
 */

const MIGRATION = path.join(
  __dirname, '..', '..', 'prisma', 'migrations',
  '20260824000000_apple_authoritative_state', 'migration.sql',
);

const OTI = '2000000123456789';
const TXN = 'txn-1';
const PRODUCT = 'nala_pro_monthly';
const UUID = 'ntf-0001';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const DAY = 86_400_000;
const at = (ms: number) => NOW.getTime() + ms;

/** A JWS-shaped string carrying an UNVERIFIED environment hint. */
function payload(hint?: string, salt = 'x'): string {
  const body = Buffer.from(JSON.stringify({ data: hint ? { environment: hint } : {}, salt }))
    .toString('base64url');
  return `hdr.${body}.sig`;
}

interface StubSpec {
  environment?: AppleEnvironment;
  notificationType?: string;
  notificationUUID?: string;
  subtype?: string;
  transaction?: Partial<DecodedTransaction> | null;
  renewal?: Partial<DecodedRenewal> | null;
  /** Force outcomes at each verification step. */
  outerError?: () => Error;
  transactionError?: () => Error;
  /** Environment the NESTED payloads claim, when it must disagree with the outer. */
  nestedEnvironment?: string;
}

function stubVerifier(spec: StubSpec): AppleVerifier {
  const env: AppleEnvironment = spec.environment ?? 'Production';
  const txn = spec.transaction === null ? null : {
    transactionId: TXN,
    originalTransactionId: OTI,
    productId: PRODUCT,
    purchaseDate: at(-30 * DAY),
    expiresDate: at(30 * DAY),
    signedDate: at(0),
    environment: spec.nestedEnvironment ?? env,
    ...(spec.transaction ?? {}),
  } as DecodedTransaction;

  return {
    async verifyNotification(requested, signedPayload): Promise<DecodedNotification> {
      if (spec.outerError) throw spec.outerError();
      // Per-environment, exactly like the real verifier: the wrong instance fails.
      if (requested !== env) throw new AppleVerificationPermanentError('environment mismatch');
      return {
        notificationUUID: spec.notificationUUID ?? UUID,
        notificationType: spec.notificationType ?? 'DID_RENEW',
        subtype: spec.subtype,
        signedDate: at(0),
        environment: env,
        signedTransactionInfo: txn ? `${signedPayload}#txn` : undefined,
        signedRenewalInfo: spec.renewal ? `${signedPayload}#renew` : undefined,
      };
    },
    async verifyTransaction(requested, _jws): Promise<DecodedTransaction> {
      if (spec.transactionError) throw spec.transactionError();
      if (requested !== env) throw new AppleVerificationPermanentError('environment mismatch');
      return txn!;
    },
    async verifyRenewal(requested, _jws): Promise<DecodedRenewal> {
      if (requested !== env) throw new AppleVerificationPermanentError('environment mismatch');
      return { originalTransactionId: OTI, environment: spec.nestedEnvironment ?? env, ...(spec.renewal ?? {}) } as DecodedRenewal;
    },
  };
}

describe('apple notification intake (real engine, stubbed verifier)', () => {
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

  const rows = async (table: string) =>
    (await db.execute(`SELECT * FROM "${table}"`)).rows as Record<string, unknown>[];
  const count = async (table: string) =>
    Number((await db.execute(`SELECT COUNT(*) n FROM "${table}"`)).rows[0].n);
  const ingest = (spec: StubSpec, hint?: string, salt?: string) =>
    ingestAppleNotification(payload(hint ?? spec.environment ?? 'Production', salt), {
      verifier: stubVerifier(spec), client: adapter, now: () => NOW,
    });

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE "User" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "plan" TEXT NOT NULL DEFAULT 'free',
      "planExpiresAt" DATETIME, "planStartedAt" DATETIME,
      "stripeSubscriptionId" TEXT, "applePurchaseSource" TEXT,
      "appleOriginalTransactionId" TEXT
    )`);
    await db.execute(`INSERT INTO "User" ("id","plan") VALUES ('user_1','free')`);
    const sql = fs.readFileSync(MIGRATION, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';')) { const t = stmt.trim(); if (t) await db.execute(t); }
    await db.execute('PRAGMA foreign_keys = ON');
  });

  afterEach(() => { db.close(); });

  // ── the boundary that defines this stage ────────────────────────────────

  it('a webhook establishes FACTS and requests reconciliation — never entitlement', async () => {
    await db.execute(`UPDATE "User" SET "plan"='free', "appleOriginalTransactionId"='${OTI}'`);

    const r = await ingest({ notificationType: 'SUBSCRIBED' });
    expect(r.outcome).toBe('accepted');
    expect(r.enqueued).toBe(true);

    // Facts recorded...
    expect(await count('AppleNotification')).toBe(1);
    expect(await count('AppleTransaction')).toBe(1);
    expect(Number((await rows('AppleReconciliation'))[0].targetGeneration)).toBe(1);

    // ...and the user is untouched, even though the legacy path would have found
    // them by exactly this column and granted a plan.
    const u = (await rows('User'))[0];
    expect(u.plan).toBe('free');
    expect(u.planExpiresAt).toBe(null);
    expect(u.planStartedAt).toBe(null);
    expect(u.applePurchaseSource).toBe(null);
  });

  it('no notification type writes User state, for any type in the reconcile set', async () => {
    let salt = 0;
    for (const type of RECONCILE_NOTIFICATION_TYPES) {
      await ingest({ notificationType: type, notificationUUID: `ntf-${type}` }, undefined, `s${salt++}`);
    }
    const u = (await rows('User'))[0];
    expect({ plan: u.plan, exp: u.planExpiresAt, started: u.planStartedAt, src: u.applePurchaseSource })
      .toEqual({ plan: 'free', exp: null, started: null, src: null });
  });

  it('DID_CHANGE_RENEWAL_STATUS queues reconciliation but never writes a plan', async () => {
    const r = await ingest({ notificationType: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_DISABLED' });
    expect(r.outcome).toBe('accepted');
    expect(r.enqueued).toBe(true);
    expect((await rows('User'))[0].plan).toBe('free');
  });

  // ── dedupe ──────────────────────────────────────────────────────────────

  it('a duplicate notification is successful and does nothing twice', async () => {
    const first = await ingest({ notificationType: 'DID_RENEW' });
    expect(first.outcome).toBe('accepted');

    const second = await ingest({ notificationType: 'DID_RENEW' });
    expect(second.outcome).toBe('duplicate');
    expect(second.enqueued).toBe(false);

    expect(await count('AppleNotification')).toBe(1);
    expect(Number((await rows('AppleReconciliation'))[0].targetGeneration)).toBe(1);
  });

  it('CONCURRENCY: the same UUID twice at once yields one row and one bump', async () => {
    // Serialised by the engine, but both callers believe they are first — which
    // is precisely what find-then-insert gets wrong.
    await Promise.all([
      ingest({ notificationType: 'DID_RENEW' }),
      ingest({ notificationType: 'DID_RENEW' }).catch(() => undefined),
    ]);
    expect(await count('AppleNotification')).toBe(1);
    expect(Number((await rows('AppleReconciliation'))[0].targetGeneration)).toBe(1);
  });

  it('two distinct notifications for the same subscription advance the generation twice', async () => {
    await ingest({ notificationUUID: 'ntf-a', notificationType: 'DID_RENEW' }, undefined, 'a');
    await ingest({
      notificationUUID: 'ntf-b', notificationType: 'DID_RENEW',
      transaction: { signedDate: at(1000) },
    }, undefined, 'b');

    expect(await count('AppleNotification')).toBe(2);
    const job = (await rows('AppleReconciliation'))[0];
    expect(Number(job.targetGeneration)).toBe(2);   // no lost increment
    expect(await count('AppleReconciliation')).toBe(1);
  });

  it('a notification arriving while a job is RUNNING advances the target, not the state', async () => {
    await ingest({ notificationUUID: 'ntf-a', notificationType: 'DID_RENEW' }, undefined, 'a');
    await db.execute(`UPDATE "AppleReconciliation" SET "reconcileState"='running', "leaseOwner"='w1'`);

    await ingest({
      notificationUUID: 'ntf-b', notificationType: 'DID_RENEW',
      transaction: { signedDate: at(1000) },
    }, undefined, 'b');

    const job = (await rows('AppleReconciliation'))[0];
    expect(Number(job.targetGeneration)).toBe(2);
    expect(String(job.reconcileState)).toBe('running');   // in-flight work is not disturbed
    expect(String(job.leaseOwner)).toBe('w1');
  });

  // ── transaction ordering ────────────────────────────────────────────────

  it('an equal signedDate is superseded, not applied a second time', async () => {
    await ingest({ notificationUUID: 'ntf-a', notificationType: 'DID_RENEW' }, undefined, 'a');
    const r = await ingest({
      notificationUUID: 'ntf-b', notificationType: 'DID_RENEW',
      transaction: { signedDate: at(0), productId: PRODUCT },
    }, undefined, 'b');

    expect(r.outcome).toBe('superseded');
    expect(r.enqueued).toBe(false);
    expect(String((await rows('AppleNotification')).find((n) => n.notificationUUID === 'ntf-b')!.outcome))
      .toBe('superseded');
  });

  it('a stale REFUND cannot re-revoke after a newer REFUND_REVERSED', async () => {
    // REFUND at 200
    await ingest({
      notificationUUID: 'n-refund', notificationType: 'REFUND',
      transaction: { signedDate: 200, revocationDate: 150, revocationType: 'REFUND_FULL', revocationReason: 1 },
    }, undefined, 'r1');
    expect(String((await rows('AppleTransaction'))[0].revocationType)).toBe('REFUND_FULL');

    // REFUND_REVERSED at 300
    await ingest({
      notificationUUID: 'n-reversed', notificationType: 'REFUND_REVERSED',
      transaction: { signedDate: 300, revocationDate: 250 },
    }, undefined, 'r2');
    const reversed = (await rows('AppleTransaction'))[0];
    expect(reversed.reversedAt).not.toBe(null);
    expect(String(reversed.reversedByUUID)).toBe('n-reversed');
    expect(reversed.revokedAt).not.toBe(null);      // history kept, not erased

    // Stale REFUND at 250 arrives late.
    const stale = await ingest({
      notificationUUID: 'n-stale', notificationType: 'REFUND',
      transaction: { signedDate: 250, revocationDate: 240, revocationType: 'FAMILY_REVOKE' },
    }, undefined, 'r3');

    expect(stale.outcome).toBe('superseded');
    const after = (await rows('AppleTransaction'))[0];
    expect(after.reversedAt).not.toBe(null);                        // still reversed
    expect(String(after.revocationType)).toBe('REFUND_FULL');       // untouched by the stale event
    // The stale delivery is still audited.
    expect((await rows('AppleNotification')).some((n) => n.notificationUUID === 'n-stale')).toBe(true);
  });

  it('an ordinary renewal cannot clear a revocation', async () => {
    await ingest({
      notificationUUID: 'n-refund', notificationType: 'REFUND',
      transaction: { signedDate: 200, revocationDate: 150, revocationType: 'REFUND_FULL' },
    }, undefined, 'r1');

    await ingest({
      notificationUUID: 'n-renew', notificationType: 'DID_RENEW',
      transaction: { signedDate: 400, expiresDate: at(60 * DAY) },
    }, undefined, 'r2');

    const t = (await rows('AppleTransaction'))[0];
    expect(t.revokedAt).not.toBe(null);
    expect(String(t.revocationType)).toBe('REFUND_FULL');
    expect(t.reversedAt).toBe(null);
  });

  it('REFUND_PRORATED stores Apple’s raw type and percentage', async () => {
    await ingest({
      notificationUUID: 'n-prorated', notificationType: 'REFUND',
      transaction: {
        signedDate: 200, revocationDate: 150,
        revocationType: 'REFUND_PRORATED', revocationPercentage: 50000, revocationReason: 0,
      },
    });
    const t = (await rows('AppleTransaction'))[0];
    expect(String(t.revocationType)).toBe('REFUND_PRORATED');
    // Milliunits, exactly as Apple sent them. Never normalised to 0-100.
    expect(Number(t.revocationPercentage)).toBe(50000);
    expect(String(t.revokedSource)).toBe('notification');
  });

  it('a later signedDate for transaction X never orders transaction Y', async () => {
    await ingest({
      notificationUUID: 'n-x', notificationType: 'DID_RENEW',
      transaction: { transactionId: 'txn-X', signedDate: 900 },
    }, undefined, 'x');
    const r = await ingest({
      notificationUUID: 'n-y', notificationType: 'DID_RENEW',
      transaction: { transactionId: 'txn-Y', signedDate: 100 },
    }, undefined, 'y');

    // Y is a different transaction: X's newer cursor says nothing about it.
    expect(r.outcome).toBe('accepted');
    expect(await count('AppleTransaction')).toBe(2);
  });

  it('a revoked historical transaction does not poison a newer one', async () => {
    await ingest({
      notificationUUID: 'n-x', notificationType: 'REFUND',
      transaction: { transactionId: 'txn-X', signedDate: 200, revocationDate: 150, revocationType: 'REFUND_FULL' },
    }, undefined, 'x');
    await ingest({
      notificationUUID: 'n-y', notificationType: 'DID_RENEW',
      transaction: { transactionId: 'txn-Y', signedDate: 300 },
    }, undefined, 'y');

    const all = await rows('AppleTransaction');
    const x = all.find((t) => t.transactionId === 'txn-X')!;
    const y = all.find((t) => t.transactionId === 'txn-Y')!;
    expect(x.revokedAt).not.toBe(null);
    expect(y.revokedAt).toBe(null);
  });

  it('a changed originalTransactionId under the same transactionId is refused', async () => {
    // The other half of immutability: same transaction id, different parent
    // subscription. Applying it would move a transaction between subscriptions.
    await ingest({ notificationUUID: 'n-a', notificationType: 'DID_RENEW' }, undefined, 'a');

    const r = await ingest({
      notificationUUID: 'n-b', notificationType: 'DID_RENEW',
      transaction: { signedDate: at(1000), originalTransactionId: '9999999999' },
    }, undefined, 'b');

    expect(r.outcome).toBe('failed');
    expect(r.enqueued).toBe(false);
    expect(String((await rows('AppleTransaction'))[0].originalTransactionId)).toBe(OTI);
  });

  it('a refund UPDATING an existing transaction keeps the raw milliunit percentage', async () => {
    // The earlier percentage test creates a fresh row (the INSERT path). This
    // one refunds a transaction that already exists, which is the UPDATE path.
    await ingest({ notificationUUID: 'n-sub', notificationType: 'SUBSCRIBED' }, undefined, 'a');
    expect((await rows('AppleTransaction'))[0].revocationPercentage).toBe(null);

    await ingest({
      notificationUUID: 'n-refund', notificationType: 'REFUND',
      transaction: {
        signedDate: at(5000), revocationDate: at(4000),
        revocationType: 'REFUND_PRORATED', revocationPercentage: 33333,
      },
    }, undefined, 'b');

    const t = (await rows('AppleTransaction'))[0];
    expect(Number(t.revocationPercentage)).toBe(33333);   // never rescaled to 0-100
    expect(String(t.revocationType)).toBe('REFUND_PRORATED');
    expect(String(t.revokedSource)).toBe('notification');
  });

  it('a TRANSIENT failure in one environment beats a PERMANENT one in the other', async () => {
    /**
     * The precedence rule only becomes visible when the two attempts disagree.
     * If the Production verifier could not COMPLETE its check while Sandbox
     * cleanly rejected, answering "permanently invalid" would tell Apple a
     * good payload was forged because OUR OCSP path was down.
     */
    const mixed = (transientEnv: AppleEnvironment): AppleVerifier => ({
      async verifyNotification(requested) {
        if (requested === transientEnv) throw new AppleVerificationTransientError('ocsp unreachable');
        throw new AppleVerificationPermanentError('environment mismatch');
      },
      async verifyTransaction() { throw new Error('unreachable'); },
      async verifyRenewal() { throw new Error('unreachable'); },
    });

    /**
     * BOTH orders matter. When the transient is raised by the first environment
     * tried it would survive a broken implementation by accident, because it is
     * also the first error recorded. The rule is only truly exercised when the
     * permanent failure is seen FIRST and the transient arrives afterwards.
     */
    for (const [hint, transientEnv] of [['Production', 'Production'], ['Sandbox', 'Production'], ['Production', 'Sandbox']] as const) {
      await expect(
        ingestAppleNotification(payload(hint), {
          verifier: mixed(transientEnv), client: adapter, now: () => NOW,
        }),
        `hint=${hint} transient=${transientEnv}`,
      ).rejects.toBeInstanceOf(AppleVerificationTransientError);
    }

    expect(await count('AppleNotification')).toBe(0);
  });

  it('the audit reason distinguishes a KNOWN no-reconcile type from an unknown one', async () => {
    // Both are ignored, but an operator needs to tell "Apple told us nothing
    // changed" from "we do not understand this event yet".
    await ingest({ notificationType: 'REFUND_DECLINED', notificationUUID: 'n-known' }, undefined, 'a');
    await ingest({ notificationType: 'ONE_TIME_CHARGE', notificationUUID: 'n-unknown' }, undefined, 'b');

    const all = await rows('AppleNotification');
    const known = all.find((n) => n.notificationUUID === 'n-known')!;
    const unknown = all.find((n) => n.notificationUUID === 'n-unknown')!;
    expect(String(known.reason)).toContain('does not affect subscription state');
    expect(String(unknown.reason)).toContain('unsupported');
    expect(String(known.reason)).not.toBe(String(unknown.reason));
  });

  it('transaction identity is immutable: a contradiction is audited, never applied', async () => {
    await ingest({ notificationUUID: 'n-a', notificationType: 'DID_RENEW' }, undefined, 'a');

    const r = await ingest({
      notificationUUID: 'n-b', notificationType: 'DID_RENEW',
      transaction: { signedDate: at(1000), productId: 'nala_elite_yearly' },
    }, undefined, 'b');

    expect(r.outcome).toBe('failed');
    expect(r.enqueued).toBe(false);
    // The stored fact is unchanged...
    expect(String((await rows('AppleTransaction'))[0].productId)).toBe(PRODUCT);
    // ...the anomaly is durably audited...
    const audited = (await rows('AppleNotification')).find((n) => n.notificationUUID === 'n-b')!;
    expect(String(audited.outcome)).toBe('failed');
    // ...and no reconciliation was requested for a contradiction.
    expect(Number((await rows('AppleReconciliation'))[0].targetGeneration)).toBe(1);
  });

  // ── type classification ─────────────────────────────────────────────────

  it('no-reconcile types are audited but never queue work', async () => {
    let salt = 0;
    for (const type of NO_RECONCILE_NOTIFICATION_TYPES) {
      const r = await ingest({ notificationType: type, notificationUUID: `ntf-${type}` }, undefined, `s${salt++}`);
      expect(r.outcome, type).toBe('ignored');
      expect(r.enqueued, type).toBe(false);
    }
    expect(await count('AppleNotification')).toBe(NO_RECONCILE_NOTIFICATION_TYPES.size);
    expect(await count('AppleReconciliation')).toBe(0);
    // ...and they stay out of the auto-renewable tables entirely.
    expect(await count('AppleTransaction')).toBe(0);
  });

  it('an unknown notification type is ignored with a reason, never guessed', async () => {
    const r = await ingest({ notificationType: 'ONE_TIME_CHARGE', notificationUUID: 'n-new' });
    expect(r.outcome).toBe('ignored');
    expect(r.enqueued).toBe(false);
    expect(await count('AppleReconciliation')).toBe(0);
    const n = (await rows('AppleNotification'))[0];
    expect(String(n.reason)).toContain('unsupported');
    expect(String(n.notificationType)).toBe('ONE_TIME_CHARGE');   // audited as sent
  });

  // ── environment isolation ───────────────────────────────────────────────

  it('a Sandbox notification creates only Sandbox rows', async () => {
    const r = await ingest({ environment: 'Sandbox', notificationType: 'DID_RENEW' });
    expect(r.outcome).toBe('accepted');
    expect(String((await rows('AppleNotification'))[0].environment)).toBe('Sandbox');
    expect(String((await rows('AppleTransaction'))[0].environment)).toBe('Sandbox');
    expect(String((await rows('AppleReconciliation'))[0].environment)).toBe('Sandbox');
  });

  it('Production and Sandbox keep separate queue identities for the same OTI', async () => {
    await ingest({ environment: 'Production', notificationUUID: 'n-p', notificationType: 'DID_RENEW' }, undefined, 'p');
    await ingest({ environment: 'Sandbox', notificationUUID: 'n-s', notificationType: 'DID_RENEW' }, undefined, 's');

    const jobs = await rows('AppleReconciliation');
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => String(j.environment)).sort()).toEqual(['Production', 'Sandbox']);
    for (const j of jobs) expect(Number(j.targetGeneration)).toBe(1);
  });

  it('a wrong environment hint cannot change what is persisted', async () => {
    // The hint says Sandbox; only the Production verifier will actually verify.
    const r = await ingestAppleNotification(payload('Sandbox'), {
      verifier: stubVerifier({ environment: 'Production', notificationType: 'DID_RENEW' }),
      client: adapter, now: () => NOW,
    });
    expect(r.environment).toBe('Production');
    expect(String((await rows('AppleNotification'))[0].environment)).toBe('Production');
  });

  it('the environment hint is a routing hint only', () => {
    expect(decodeEnvironmentHint(payload('Sandbox'))).toBe('Sandbox');
    expect(decodeEnvironmentHint(payload('Production'))).toBe('Production');
    expect(decodeEnvironmentHint(payload('Neither'))).toBe(null);
    expect(decodeEnvironmentHint('not-a-jws')).toBe(null);
    expect(decodeEnvironmentHint('')).toBe(null);
  });

  // ── trust boundary ──────────────────────────────────────────────────────

  it('a bad outer signature writes NOTHING', async () => {
    await expect(ingest({
      outerError: () => new AppleVerificationPermanentError('bad signature'),
    })).rejects.toBeInstanceOf(AppleVerificationPermanentError);

    expect(await count('AppleNotification')).toBe(0);
    expect(await count('AppleTransaction')).toBe(0);
    expect(await count('AppleReconciliation')).toBe(0);
  });

  it('a wrong app identifier writes NOTHING', async () => {
    await expect(ingest({
      outerError: () => new AppleVerificationPermanentError('app identifier mismatch'),
    })).rejects.toBeInstanceOf(AppleVerificationPermanentError);
    expect(await count('AppleNotification')).toBe(0);
  });

  it('a transient verification failure writes NOTHING and stays transient', async () => {
    await expect(ingest({
      outerError: () => new AppleVerificationTransientError('ocsp unreachable'),
    })).rejects.toBeInstanceOf(AppleVerificationTransientError);
    expect(await count('AppleNotification')).toBe(0);
  });

  it('a verified outer envelope does not authenticate a nested transaction', async () => {
    await expect(ingest({
      transactionError: () => new AppleVerificationPermanentError('nested signature invalid'),
    })).rejects.toBeInstanceOf(AppleVerificationPermanentError);

    // No audit row either: the envelope alone proves nothing worth recording.
    expect(await count('AppleNotification')).toBe(0);
    expect(await count('AppleTransaction')).toBe(0);
    expect(await count('AppleReconciliation')).toBe(0);
  });

  it('outer Production with a nested Sandbox payload is refused', async () => {
    await expect(ingest({
      environment: 'Production', nestedEnvironment: 'Sandbox',
    })).rejects.toBeInstanceOf(AppleVerificationPermanentError);
    expect(await count('AppleTransaction')).toBe(0);
  });

  it('verified payloads that disagree on originalTransactionId are refused', async () => {
    await expect(ingest({
      renewal: { originalTransactionId: 'a-different-oti' } as Partial<DecodedRenewal>,
    })).rejects.toBeInstanceOf(AppleVerificationPermanentError);
    expect(await count('AppleTransaction')).toBe(0);
  });

  it('persisted identity comes from the VERIFIED payload, not the envelope hint', async () => {
    await ingestAppleNotification(payload('Production'), {
      verifier: stubVerifier({ notificationUUID: 'verified-uuid', notificationType: 'EXPIRED' }),
      client: adapter, now: () => NOW,
    });
    const n = (await rows('AppleNotification'))[0];
    expect(String(n.notificationUUID)).toBe('verified-uuid');
    expect(String(n.notificationType)).toBe('EXPIRED');
  });

  // ── atomicity ───────────────────────────────────────────────────────────

  it('ATOMICITY: a failing generation bump rolls back the notification and the fact', async () => {
    await db.executeMultiple(`CREATE TRIGGER block_queue BEFORE INSERT ON "AppleReconciliation"
      BEGIN SELECT RAISE(ABORT, 'queue write blocked'); END;`);

    await expect(ingest({ notificationType: 'DID_RENEW' })).rejects.toThrow();

    expect(await count('AppleNotification')).toBe(0);
    expect(await count('AppleTransaction')).toBe(0);
    expect(await count('AppleReconciliation')).toBe(0);

    // Recovery: once the fault clears, the retry applies exactly once.
    await db.executeMultiple(`DROP TRIGGER block_queue;`);
    const r = await ingest({ notificationType: 'DID_RENEW' });
    expect(r.outcome).toBe('accepted');
    expect(await count('AppleNotification')).toBe(1);
    expect(await count('AppleTransaction')).toBe(1);
    expect(Number((await rows('AppleReconciliation'))[0].targetGeneration)).toBe(1);
  });

  it('ATOMICITY: a failing transaction-fact write rolls back the notification insert', async () => {
    await db.executeMultiple(`CREATE TRIGGER block_txn BEFORE INSERT ON "AppleTransaction"
      BEGIN SELECT RAISE(ABORT, 'fact write blocked'); END;`);

    await expect(ingest({ notificationType: 'DID_RENEW' })).rejects.toThrow();
    expect(await count('AppleNotification')).toBe(0);
    expect(await count('AppleReconciliation')).toBe(0);

    await db.executeMultiple(`DROP TRIGGER block_txn;`);
    expect((await ingest({ notificationType: 'DID_RENEW' })).outcome).toBe('accepted');
    expect(await count('AppleNotification')).toBe(1);
  });

  it('ATOMICITY: a failing final audit write rolls back everything', async () => {
    await db.executeMultiple(`CREATE TRIGGER block_final BEFORE UPDATE ON "AppleNotification"
      BEGIN SELECT RAISE(ABORT, 'audit finalise blocked'); END;`);

    await expect(ingest({ notificationType: 'DID_RENEW' })).rejects.toThrow();
    expect(await count('AppleNotification')).toBe(0);
    expect(await count('AppleTransaction')).toBe(0);
    expect(await count('AppleReconciliation')).toBe(0);

    await db.executeMultiple(`DROP TRIGGER block_final;`);
    expect((await ingest({ notificationType: 'DID_RENEW' })).outcome).toBe('accepted');
    expect(await count('AppleNotification')).toBe(1);
  });

  it('there is never an audited notification without the bump it implied', async () => {
    await ingest({ notificationType: 'SUBSCRIBED' });
    const notifications = await rows('AppleNotification');
    const accepted = notifications.filter((n) => String(n.outcome) === 'accepted');
    expect(accepted).toHaveLength(1);
    expect(await count('AppleReconciliation')).toBe(1);
    expect(accepted[0].appliedAt).not.toBe(null);
  });
});

/**
 * The legacy entitlement mutator is GONE, not merely unreachable.
 *
 * The behavioural tests above prove no User row changes. These prove the code
 * that used to change it no longer exists on this path, so it cannot be
 * reintroduced by a well-meaning edit without failing here.
 */
describe('the notification path cannot touch entitlement', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  it('the intake service contains no entitlement or Stripe write', () => {
    const src = read('services/apple-notification-intake.service.ts');
    // Table and column names that would mean entitlement is being decided here.
    for (const forbidden of ['"User"', 'planExpiresAt', 'planStartedAt', 'applePurchaseSource', 'stripeSubscriptionId']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    // No UPDATE/INSERT against User in any form.
    expect(/UPDATE\s+"?User"?/i.test(src)).toBe(false);
    expect(/INSERT\s+INTO\s+"?User"?/i.test(src)).toBe(false);
  });

  it('the intake service writes only the three Apple tables', () => {
    const src = read('services/apple-notification-intake.service.ts');
    const written = [...src.matchAll(/(?:INSERT\s+INTO|UPDATE)\s+"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect([...new Set(written)].sort()).toEqual(['AppleNotification', 'AppleTransaction']);
    // AppleReconciliation is bumped through the queue primitive, never open-coded.
    expect(src).toContain('enqueueReconciliation');
  });

  it('the legacy notification mutator is unreachable from the route', () => {
    const controller = read('controllers/apple-iap.controller.ts');
    expect(controller).not.toContain('handleAppleNotification');
    expect(controller).toContain('ingestAppleNotification');
    // The rollout gate precedes every other statement in the handler.
    const handler = controller.indexOf('export async function appleWebhookHandler');
    const gate = controller.indexOf('config.appleIapEnabled', handler);
    const intake = controller.indexOf('ingestAppleNotification(', handler);
    expect(gate).toBeGreaterThan(-1);
    expect(intake).toBeGreaterThan(gate);
  });

  it('the legacy service no longer carries the notification machinery', () => {
    const legacy = read('services/apple-iap.service.ts');
    for (const gone of ['handleAppleNotification', 'processAppleNotification', 'verifySignedNotification', 'appleIAPWebhookEvent', 'runJob']) {
      // Prose in the tombstone comment is fine; a call or definition is not.
      const codeUses = legacy
        .split(eolOf(legacy))
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
        .filter((l) => l.includes(gone));
      expect(codeUses, gone).toEqual([]);
    }
    // Activation/restore are deliberately untouched by this stage.
    expect(legacy).toContain('export async function verifyAndActivatePlan');
    expect(legacy).toContain('export async function restorePurchases');
  });

  it('no dedupe marker is ever deleted', () => {
    const src = read('services/apple-notification-intake.service.ts');
    expect(/DELETE\s+FROM/i.test(src)).toBe(false);
    expect(src).not.toContain('deleteMany');
  });
});

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
