import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  __TEST_ONLY_ENQUEUE_SQL,
  type QueueClient,
  type AppleEnvironment,
} from '../services/apple-reconciliation-queue.service';
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
      "appleOriginalTransactionId" TEXT, "appleAppAccountToken" TEXT
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

  it('two distinct notifications for the same subscription advance the generation twice', async () => {
    // Sequential form. The genuinely concurrent version, on two connections to
    // one database file, is in the suite at the end of this file.
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

  it('an equal signedDate does not reapply the fact, but STILL requests reconciliation', async () => {
    /**
     * Two separate questions. Whether this JWS is newer decides whether the
     * stored fact changes; whether the notification is reconcile-worthy decides
     * whether we go and ask Apple. A distinct DID_RENEW is a reason to fetch
     * current state even if its transaction copy is one we have already seen.
     */
    await ingest({ notificationUUID: 'ntf-a', notificationType: 'DID_RENEW' }, undefined, 'a');
    const r = await ingest({
      notificationUUID: 'ntf-b', notificationType: 'DID_RENEW',
      transaction: { signedDate: at(0), productId: PRODUCT },
    }, undefined, 'b');

    expect(r.outcome).toBe('superseded');   // the FACT was not reapplied
    expect(r.enqueued).toBe(true);          // but the pass was still requested
    expect(Number((await rows('AppleReconciliation'))[0].targetGeneration)).toBe(2);
    expect(String((await rows('AppleNotification')).find((n) => n.notificationUUID === 'ntf-b')!.outcome))
      .toBe('superseded');
  });

  it('a stale REFUND after a reversal changes no fact but still asks Apple', async () => {
    await ingest({
      notificationUUID: 'n-refund', notificationType: 'REFUND',
      transaction: { signedDate: 200, revocationDate: 150, revocationType: 'REFUND_FULL' },
    }, undefined, 'r1');
    await ingest({
      notificationUUID: 'n-reversed', notificationType: 'REFUND_REVERSED',
      transaction: { signedDate: 300 },
    }, undefined, 'r2');

    const stale = await ingest({
      notificationUUID: 'n-stale', notificationType: 'REFUND',
      transaction: { signedDate: 250, revocationDate: 240, revocationType: 'FAMILY_REVOKE' },
    }, undefined, 'r3');

    expect(stale.outcome).toBe('superseded');
    expect(stale.enqueued).toBe(true);   // cheap insurance; the API is authoritative
    expect(Number((await rows('AppleReconciliation'))[0].targetGeneration)).toBe(3);
  });

  it('a reconcile-worthy event with only renewal identity still queues work', async () => {
    // Previously downgraded to "ignored" for want of a queue identity.
    const r = await ingestAppleNotification(payload('Production'), {
      verifier: {
        async verifyNotification() {
          return {
            notificationUUID: 'n-renewal-only', notificationType: 'DID_CHANGE_RENEWAL_STATUS',
            signedDate: at(0), environment: 'Production', signedRenewalInfo: 'renew.jws',
          };
        },
        async verifyTransaction() { throw new Error('no transaction on this notification'); },
        async verifyRenewal() { return { originalTransactionId: OTI, environment: 'Production' } as DecodedRenewal; },
      },
      client: adapter, now: () => NOW,
    });

    expect(r.outcome).toBe('accepted');
    expect(r.enqueued).toBe(true);
    const job = (await rows('AppleReconciliation'))[0];
    expect(String(job.originalTransactionId)).toBe(OTI);
    expect(await count('AppleTransaction')).toBe(0);   // no transaction to record
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

  it('a NEWER refund after a reversal reactivates the revocation', async () => {
    /**
     * The projector reads an active revocation as `revokedAt !== null &&
     * reversedAt === null`. If a newer refund left the old reversal marker in
     * place, this sequence would read as "already reversed" and the customer
     * would keep paid access through a live refund.
     */
    await ingest({
      notificationUUID: 'n-1', notificationType: 'REFUND',
      transaction: { signedDate: 200, revocationDate: 150, revocationType: 'REFUND_FULL' },
    }, undefined, 'a');
    await ingest({
      notificationUUID: 'n-2', notificationType: 'REFUND_REVERSED',
      transaction: { signedDate: 300 },
    }, undefined, 'b');
    expect((await rows('AppleTransaction'))[0].reversedAt).not.toBe(null);

    await ingest({
      notificationUUID: 'n-3', notificationType: 'REFUND',
      transaction: { signedDate: 400, revocationDate: 380, revocationType: 'REFUND_FULL' },
    }, undefined, 'c');

    const t = (await rows('AppleTransaction'))[0];
    expect(t.revokedAt).not.toBe(null);
    expect(t.reversedAt).toBe(null);        // reactivated, not left reversed
    expect(t.reversedByUUID).toBe(null);
    // The earlier reversal still exists where history belongs.
    expect((await rows('AppleNotification')).some((n) => n.notificationUUID === 'n-2')).toBe(true);
  });

  it('a REVOKE after a reversal also reactivates the revocation', async () => {
    await ingest({
      notificationUUID: 'n-1', notificationType: 'REFUND',
      transaction: { signedDate: 200, revocationDate: 150, revocationType: 'REFUND_FULL' },
    }, undefined, 'a');
    await ingest({
      notificationUUID: 'n-2', notificationType: 'REFUND_REVERSED', transaction: { signedDate: 300 },
    }, undefined, 'b');
    await ingest({
      notificationUUID: 'n-3', notificationType: 'REVOKE',
      transaction: { signedDate: 400, revocationDate: 390, revocationType: 'FAMILY_REVOKE' },
    }, undefined, 'c');

    const t = (await rows('AppleTransaction'))[0];
    expect(t.reversedAt).toBe(null);
    expect(String(t.revocationType)).toBe('FAMILY_REVOKE');
  });

  it('a REFUND_REVERSED seen FIRST is recorded as a reversal, not a clean transaction', async () => {
    // We never saw the refund it reverses, so revokedAt stays null — which is
    // exactly what we know, and reads correctly as "no active revocation".
    const r = await ingest({
      notificationUUID: 'n-rev-first', notificationType: 'REFUND_REVERSED',
      transaction: { signedDate: 300 },
    });
    expect(r.outcome).toBe('accepted');

    const t = (await rows('AppleTransaction'))[0];
    expect(t.revokedAt).toBe(null);
    expect(t.reversedAt).not.toBe(null);
    expect(String(t.reversedByUUID)).toBe('n-rev-first');
  });

  it('a revocation timestamp is NEVER fabricated from our own clock', async () => {
    // Apple’s revocationDate is when the App Store refunded. Inventing it would
    // manufacture a money fact the projector treats as a real revocation.
    const r = await ingest({
      notificationUUID: 'n-no-date', notificationType: 'REFUND',
      transaction: { signedDate: 200, revocationDate: undefined, revocationType: 'REFUND_FULL' },
    });
    expect(r.outcome).toBe('failed');
    expect(String(r.reason)).toContain('revocationDate');
    expect(await count('AppleTransaction')).toBe(0);
  });

  it('the reversal timestamp is the reversal’s signing date, not the refund date', async () => {
    await ingest({
      notificationUUID: 'n-1', notificationType: 'REFUND',
      transaction: { signedDate: 200, revocationDate: 150, revocationType: 'REFUND_FULL' },
    }, undefined, 'a');
    await ingest({
      notificationUUID: 'n-2', notificationType: 'REFUND_REVERSED',
      transaction: { signedDate: 300, revocationDate: 150 },
    }, undefined, 'b');

    const t = (await rows('AppleTransaction'))[0];
    // NOT 150: that is when the refund happened, not when it was reversed.
    expect(new Date(String(t.reversedAt)).getTime()).not.toBe(150);
    expect(new Date(String(t.revokedAt)).getTime()).toBe(150);
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

  it('a changed purchaseDate under the same transactionId is refused', async () => {
    // Purchase identity is part of transaction identity; a later JWS must not
    // silently rewrite when a historical transaction was bought.
    await ingest({ notificationUUID: 'n-a', notificationType: 'DID_RENEW' }, undefined, 'a');

    const r = await ingest({
      notificationUUID: 'n-b', notificationType: 'DID_RENEW',
      transaction: { signedDate: at(1000), purchaseDate: at(-999 * DAY) },
    }, undefined, 'b');

    expect(r.outcome).toBe('failed');
    expect(String(r.reason)).toContain('purchaseDate');
    expect(new Date(String((await rows('AppleTransaction'))[0].purchaseDate)).getTime())
      .toBe(at(-30 * DAY));
  });

  it('an ordinary update never rewrites purchaseDate', async () => {
    await ingest({ notificationUUID: 'n-a', notificationType: 'SUBSCRIBED' }, undefined, 'a');
    const before = String((await rows('AppleTransaction'))[0].purchaseDate);

    await ingest({
      notificationUUID: 'n-b', notificationType: 'DID_RENEW',
      transaction: { signedDate: at(5000), expiresDate: at(90 * DAY) },
    }, undefined, 'b');

    const t = (await rows('AppleTransaction'))[0];
    expect(String(t.purchaseDate)).toBe(before);
    expect(new Date(String(t.expiresDate)).getTime()).toBe(at(90 * DAY));   // this DID update
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

  it('a valid EXTERNAL PURCHASE notification is audited and ignored, not rejected', async () => {
    /**
     * The end-to-end shape of the regression: Apple signs an envelope we do not
     * support, it verifies cleanly, and it must be recorded and dropped — not
     * 400’d at the trust boundary, and not guessed into subscription handling.
     */
    const r = await ingestAppleNotification(payload('Production'), {
      verifier: {
        async verifyNotification() {
          return {
            notificationUUID: 'n-ext', notificationType: 'EXTERNAL_PURCHASE_TOKEN',
            signedDate: at(0), environment: 'Production',
          };
        },
        async verifyTransaction() { throw new Error('no nested transaction'); },
        async verifyRenewal() { throw new Error('no nested renewal'); },
      },
      client: adapter, now: () => NOW,
    });

    expect(r.outcome).toBe('ignored');
    expect(r.enqueued).toBe(false);
    expect(String(r.reason)).toContain('unsupported');

    const n = (await rows('AppleNotification'))[0];
    expect(String(n.notificationType)).toBe('EXTERNAL_PURCHASE_TOKEN');
    expect(String(n.environment)).toBe('Production');
    expect(await count('AppleTransaction')).toBe(0);      // stays out of the machinery
    expect(await count('AppleReconciliation')).toBe(0);   // and asks for no work
  });

  it('a valid appData notification is audited and ignored, not rejected', async () => {
    const r = await ingestAppleNotification(payload('Production'), {
      verifier: {
        async verifyNotification() {
          return {
            notificationUUID: 'n-appdata', notificationType: 'METADATA_UPDATE',
            signedDate: at(0), environment: 'Production',
          };
        },
        async verifyTransaction() { throw new Error('no nested transaction'); },
        async verifyRenewal() { throw new Error('no nested renewal'); },
      },
      client: adapter, now: () => NOW,
    });

    expect(r.outcome).toBe('ignored');
    expect(r.enqueued).toBe(false);
    expect(await count('AppleNotification')).toBe(1);
    expect(await count('AppleTransaction')).toBe(0);
    expect(await count('AppleReconciliation')).toBe(0);
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

  it('the legacy apple-iap service is gone entirely', () => {
    /**
     * It carried a SignedDataVerifier whose environment came from NODE_ENV, a
     * private duplicate of the product->plan map, and activation/restore code
     * that wrote User.plan straight from a client-submitted JWS. All of it was
     * replaced: notification intake in the previous stage, activation and
     * restore in this one. Deleting the file is the strongest available proof
     * that none of it can be reached.
     */
    expect(fs.existsSync(path.join(__dirname, '..', 'services/apple-iap.service.ts'))).toBe(false);

    // And nothing imports it any more.
    const dir = path.join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'generated') walk(p); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (/from '[^']*apple-iap\.service'/.test(src)) offenders.push(p);
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);  });

  it('no dedupe marker is ever deleted', () => {
    const src = read('services/apple-notification-intake.service.ts');
    expect(/DELETE\s+FROM/i.test(src)).toBe(false);
    expect(src).not.toContain('deleteMany');
  });
});


/**
 * Two independent connections to ONE database file.
 *
 * Two `:memory:` clients would be two separate databases, and two transactions
 * on a single connection cannot overlap at all. A file-backed database with two
 * connections is the smallest setup where the engine actually has to serialise
 * competing writers.
 *
 * HONEST LIMIT OF THIS SUITE. libsql’s node driver is synchronous, so two write
 * transactions cannot genuinely overlap inside one process: a second BEGIN
 * IMMEDIATE blocks the whole thread, so the connection holding the lock cannot
 * reach its COMMIT. Concurrent *delivery* is real here — the async verification
 * phases interleave and both writers contend for the same file — but the commits
 * are serialised by the engine, as they are in production.
 *
 * What that leaves proven: exactly-once application under concurrent delivery of
 * one notification (below), and that two deliveries across two connections each
 * advance the generation. What it cannot prove by construction is a lost
 * read-modify-write increment — which is why the increment is a single atomic SQL
 * statement rather than application-level arithmetic, asserted directly.
 */
describe('notification intake under real concurrency', () => {
  let dir: string;
  let a: Client;
  let b: Client;

  const clientFor = (db: Client): QueueClient => {
    const c: QueueClient = {
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) =>
        Number((await db.execute({ sql, args: args as never })).rowsAffected),
      $queryRawUnsafe: async <T,>(sql: string, ...args: unknown[]) =>
        (await db.execute({ sql, args: args as never })).rows as T[],
      $transaction: async <T,>(fn: (tx: QueueClient) => Promise<T>): Promise<T> => {
        await db.execute('BEGIN IMMEDIATE');
        try {
          const out = await fn(c);
          await db.execute('COMMIT');
          return out;
        } catch (err) {
          // A rollback that itself fails must not mask the real error, and must
          // not leave the connection believing it is still in a transaction.
          try { await db.execute('ROLLBACK'); } catch { /* already unwound */ }
          throw err;
        }
      },
    };
    return c;
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-intake-'));
    const url = 'file:' + path.join(dir, 'test.db').split(path.sep).join('/');
    a = createClient({ url });
    b = createClient({ url });
    for (const c of [a, b]) {
      await c.execute('PRAGMA journal_mode = WAL');
      /**
       * Deliberately SHORT, with a retry in `run` below.
       *
       * libsql’s driver is synchronous, so a blocked BEGIN IMMEDIATE stalls the
       * whole Node thread — a long busy_timeout means the connection holding the
       * lock cannot reach its COMMIT, and the two deadlock until the waiter
       * times out. Failing fast and retrying is both what unblocks this and what
       * production actually does under contention.
       */
      await c.execute('PRAGMA busy_timeout = 25');
    }
    const sql = fs.readFileSync(MIGRATION, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    await a.execute(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "plan" TEXT NOT NULL DEFAULT 'free', "appleAppAccountToken" TEXT, "appleOriginalTransactionId" TEXT)`);
    for (const stmt of sql.split(';')) { const t = stmt.trim(); if (t) await a.execute(t); }
  });

  afterEach(() => {
    a.close(); b.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
  });

  /** Retries only SQLITE_BUSY, exactly as a contended writer must. */
  const run = async (client: QueueClient, spec: StubSpec, salt: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await ingestAppleNotification(payload('Production', salt), {
          verifier: stubVerifier(spec), client, now: () => NOW,
        });
      } catch (err) {
        const busy = String((err as { code?: string })?.code ?? err) .includes('SQLITE_BUSY')
          || String((err as Error)?.message ?? '').includes('database is locked');
        if (!busy || attempt >= 50) throw err;
        await new Promise((r) => setTimeout(r, 5));
      }
    }
  };

  it('the generation increment is atomic SQL, not application arithmetic', async () => {
    /**
     * The property the driver cannot let us race for. A lost update needs a
     * read-modify-write in application space; the queue primitive increments
     * inside a single UPSERT, so two committed enqueues can only ever produce
     * two increments no matter how they interleave.
     */
    expect(__TEST_ONLY_ENQUEUE_SQL).toMatch(/targetGeneration"?\s*\+\s*1/);
    // ...and intake never computes a generation itself.
    const src = fs.readFileSync(path.join(__dirname, '..', 'services/apple-notification-intake.service.ts'), 'utf8');
    expect(src).not.toMatch(/targetGeneration/);
  });

  it('the SAME notification delivered twice at once applies exactly once', async () => {
    const results = await Promise.allSettled([
      run(clientFor(a), { notificationUUID: 'dup-1', notificationType: 'DID_RENEW' }, 'a'),
      run(clientFor(b), { notificationUUID: 'dup-1', notificationType: 'DID_RENEW' }, 'b'),
    ]);
    const done = results.filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<{ outcome: string }>).value.outcome);

    // Whoever lost the race must have seen the unique index, not a second apply.
    expect(done.filter((o) => o === 'accepted').length).toBeLessThanOrEqual(1);
    const notifications = (await a.execute('SELECT * FROM "AppleNotification"')).rows;
    expect(notifications).toHaveLength(1);
    const jobs = (await a.execute('SELECT * FROM "AppleReconciliation"')).rows;
    expect(jobs).toHaveLength(1);
    expect(Number(jobs[0].targetGeneration)).toBe(1);   // exactly one bump
  });

  it('two DISTINCT notifications on two connections each advance the generation', async () => {
    // Awaited rather than raced, for the driver reason in the suite comment.
    // Two separate connections still means neither can see the other’s
    // uncommitted state, which is the part that matters for the increment.
    await run(clientFor(a), { notificationUUID: 'race-a', notificationType: 'DID_RENEW' }, 'a');
    await run(clientFor(b), { notificationUUID: 'race-b', notificationType: 'DID_RENEW', transaction: { signedDate: at(1000) } }, 'b');

    expect((await a.execute('SELECT * FROM "AppleNotification"')).rows).toHaveLength(2);
    const jobs = (await a.execute('SELECT * FROM "AppleReconciliation"')).rows;
    expect(jobs).toHaveLength(1);
    // The read-modify-write this guards against would leave 1.
    expect(Number(jobs[0].targetGeneration)).toBe(2);
  });

  it('notifications on both connections advance a RUNNING job without disturbing it', async () => {
    await run(clientFor(a), { notificationUUID: 'first', notificationType: 'DID_RENEW' }, 'a');
    await a.execute(`UPDATE "AppleReconciliation" SET "reconcileState"='running', "leaseOwner"='w1'`);

    await run(clientFor(a), { notificationUUID: 'race-1', notificationType: 'EXPIRED', transaction: { signedDate: at(1000) } }, 'x');
    await run(clientFor(b), { notificationUUID: 'race-2', notificationType: 'DID_RENEW', transaction: { signedDate: at(2000) } }, 'y');

    const job = (await a.execute('SELECT * FROM "AppleReconciliation"')).rows[0];
    expect(Number(job.targetGeneration)).toBe(3);
    expect(String(job.reconcileState)).toBe('running');   // in-flight work untouched
    expect(String(job.leaseOwner)).toBe('w1');
  });
});
