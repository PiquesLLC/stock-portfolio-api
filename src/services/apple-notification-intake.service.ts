import {
  enqueueReconciliation,
  type AppleEnvironment,
  type QueueClient,
} from './apple-reconciliation-queue.service';
import {
  AppleVerificationPermanentError,
  AppleVerificationTransientError,
  type AppleVerifier,
  type DecodedNotification,
} from './apple-verifier';
import type { DecodedTransaction, DecodedRenewal } from './apple-server-api';

/**
 * Authoritative App Store Server Notification V2 intake.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE:
 *
 *   A webhook may establish verified Apple facts and request reconciliation.
 *   It may not establish entitlement.
 *
 * The path it replaces did the opposite: it decoded a notification, looked a user
 * up by a transitional id, and wrote User.plan straight from the notification
 * type — so whichever message arrived last decided what a customer had paid for.
 * Nothing here touches User at all. Reconciled current state, projected inside
 * the reconciler's generation fence, is the only thing that grants access.
 *
 * ── WHAT "VERIFIED" MEANS HERE ────────────────────────────────────────────
 *
 * Exactly one use of unverified data is permitted: choosing which
 * environment-specific verifier gets to attempt the outer JWS. That is a routing
 * hint and nothing more — it never reaches persistence or a decision, and if it
 * is wrong the verification simply fails and the other environment is tried.
 *
 * Verifying the envelope says nothing about what is nested inside it, so
 * signedTransactionInfo and signedRenewalInfo are each put through their own
 * verification under the environment the OUTER payload proved.
 *
 * ── DURABILITY ────────────────────────────────────────────────────────────
 *
 * Cryptographic work (certificate chains, OCSP) happens BEFORE the write
 * transaction opens, so PKI latency never holds the SQLite write lock. Once the
 * facts are verified, the notification row, the transaction fact and the
 * generation bump commit as ONE transaction — there is never a committed
 * notification marker without the generation bump it implied, or the reverse.
 */

/** A verified payload that cannot be applied without contradicting stored facts. */
export class AppleIntakeSemanticError extends Error {
  constructor(readonly reason: string) {
    super(`apple notification semantically inconsistent: ${reason}`);
    this.name = 'AppleIntakeSemanticError';
  }
}

/**
 * Notification types that change subscription state and therefore need a
 * reconciliation pass. Frozen deliberately: an unknown type is ignored, never
 * guessed into the auto-renewable machinery.
 */
export const RECONCILE_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'SUBSCRIBED', 'DID_RENEW', 'DID_CHANGE_RENEWAL_PREF', 'DID_CHANGE_RENEWAL_STATUS',
  'DID_FAIL_TO_RENEW', 'GRACE_PERIOD_EXPIRED', 'EXPIRED', 'REFUND', 'REVOKE',
  'REFUND_REVERSED', 'PRICE_INCREASE', 'OFFER_REDEEMED', 'RENEWAL_EXTENDED',
]);

/**
 * Verified and audited, but they do not move subscription state:
 *   REFUND_DECLINED      a refund request Apple turned down — nothing changed
 *   CONSUMPTION_REQUEST  Apple asking US for information
 *   TEST                 a delivery check
 */
export const NO_RECONCILE_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'REFUND_DECLINED', 'CONSUMPTION_REQUEST', 'TEST',
]);

/** Types that carry a revocation fact on the transaction payload. */
const REVOCATION_TYPES: ReadonlySet<string> = new Set(['REFUND', 'REVOKE']);
const REVERSAL_TYPE = 'REFUND_REVERSED';

export type IntakeOutcome =
  /** Verified; the fact and/or the generation bump committed. */
  | 'accepted'
  /** This notificationUUID was already processed durably. Nothing repeated. */
  | 'duplicate'
  /** Verified, but the transaction JWS is not newer than what is stored. */
  | 'superseded'
  /** Verified and audited, but there is deliberately nothing to apply. */
  | 'ignored'
  /** Verified but contradicts stored facts. Audited; nothing applied. */
  | 'failed';

export interface IntakeResult {
  outcome: IntakeOutcome;
  notificationUUID: string;
  environment: AppleEnvironment;
  notificationType: string;
  reason?: string;
  /** True when this delivery bumped a reconciliation generation. */
  enqueued: boolean;
}

const ENVIRONMENTS: readonly AppleEnvironment[] = ['Production', 'Sandbox'];

/**
 * UNVERIFIED decode of the JWS body, used ONLY to order the verifier attempts.
 *
 * Nothing from here is persisted, compared, or acted on. A hostile payload can
 * at most make us try the environments in the less convenient order, and both
 * attempts still have to pass real signature verification.
 */
export function decodeEnvironmentHint(signedPayload: string): AppleEnvironment | null {
  try {
    const body = signedPayload.split('.')[1];
    if (!body) return null;
    const json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    const data = json.data as Record<string, unknown> | undefined;
    const summary = json.summary as Record<string, unknown> | undefined;
    const hint = data?.environment ?? summary?.environment;
    return hint === 'Production' || hint === 'Sandbox' ? hint : null;
  } catch {
    return null;
  }
}

/**
 * Verify the outer notification, trying the hinted environment first.
 *
 * A transient failure anywhere wins over a permanent one: if we could not
 * COMPLETE a check, we must not tell Apple the payload was bad.
 */
async function verifyOuter(
  verifier: AppleVerifier,
  signedPayload: string,
): Promise<DecodedNotification> {
  const hint = decodeEnvironmentHint(signedPayload);
  const order = hint ? [hint, ...ENVIRONMENTS.filter((e) => e !== hint)] : [...ENVIRONMENTS];

  let firstPermanent: unknown;
  let transient: unknown;
  for (const env of order) {
    try {
      return await verifier.verifyNotification(env, signedPayload);
    } catch (err) {
      if (err instanceof AppleVerificationTransientError) { transient = err; continue; }
      if (firstPermanent === undefined) firstPermanent = err;
    }
  }
  throw transient ?? firstPermanent ?? new AppleVerificationPermanentError('notification could not be verified');
}

const asIso = (ms: number | undefined): string | null =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

interface VerifiedFacts {
  notification: DecodedNotification;
  transaction: DecodedTransaction | null;
  renewal: DecodedRenewal | null;
}

/**
 * Verify every nested JWS under the environment the outer payload PROVED, then
 * cross-check the identities they claim.
 *
 * A verified outer envelope does not authenticate its contents, and two verified
 * payloads that disagree about who they describe are not a thing to reconcile by
 * preferring one — they fail closed.
 */
async function verifyNested(
  verifier: AppleVerifier,
  notification: DecodedNotification,
): Promise<VerifiedFacts> {
  const env = notification.environment;

  const transaction = notification.signedTransactionInfo
    ? await verifier.verifyTransaction(env, notification.signedTransactionInfo)
    : null;
  const renewal = notification.signedRenewalInfo
    ? await verifier.verifyRenewal(env, notification.signedRenewalInfo)
    : null;

  if (transaction?.environment !== undefined && transaction.environment !== env) {
    throw new AppleVerificationPermanentError('nested transaction environment mismatch');
  }
  if (renewal?.environment !== undefined && renewal.environment !== env) {
    throw new AppleVerificationPermanentError('nested renewal environment mismatch');
  }
  const renewalOti = (renewal as { originalTransactionId?: string } | null)?.originalTransactionId;
  if (transaction && renewalOti !== undefined && renewalOti !== transaction.originalTransactionId) {
    throw new AppleVerificationPermanentError('verified payloads disagree on originalTransactionId');
  }

  return { notification, transaction, renewal };
}

const INSERT_NOTIFICATION_SQL = `
INSERT INTO "AppleNotification" (
  "id", "environment", "notificationUUID", "notificationType", "subtype",
  "signedDate", "originalTransactionId", "transactionId", "outcome", "reason",
  "receivedAt", "appliedAt"
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
ON CONFLICT("notificationUUID") DO NOTHING
`.trim();

const FINALISE_NOTIFICATION_SQL = `
UPDATE "AppleNotification" SET "outcome" = ?, "reason" = ?, "appliedAt" = ?
WHERE "notificationUUID" = ?
`.trim();

const SELECT_TRANSACTION_SQL = `
SELECT "originalTransactionId", "productId", "lastAppliedSignedDate"
FROM "AppleTransaction" WHERE "environment" = ? AND "transactionId" = ?
`.trim();

const INSERT_TRANSACTION_SQL = `
INSERT INTO "AppleTransaction" (
  "id", "environment", "transactionId", "originalTransactionId", "productId",
  "purchaseDate", "expiresDate", "type", "appAccountToken", "lastAppliedSignedDate",
  "revokedAt", "revocationReason", "revocationType", "revocationPercentage",
  "revokedSource", "reversedAt", "reversedByUUID", "createdAt", "updatedAt"
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`.trim();

/**
 * Ordinary fact update.
 *
 * The absence of the revocation columns from this SET list is the point: a
 * renewal, a resubscribe or any other positive event must never wipe a refund.
 * Only the explicit revocation and reversal paths below touch that state.
 */
const UPDATE_TRANSACTION_FACT_SQL = `
UPDATE "AppleTransaction" SET
  "expiresDate" = ?, "type" = ?, "appAccountToken" = COALESCE(?, "appAccountToken"),
  "purchaseDate" = ?, "lastAppliedSignedDate" = ?, "updatedAt" = ?
WHERE "environment" = ? AND "transactionId" = ?
`.trim();

const UPDATE_TRANSACTION_REVOCATION_SQL = `
UPDATE "AppleTransaction" SET
  "expiresDate" = ?, "type" = ?, "appAccountToken" = COALESCE(?, "appAccountToken"),
  "purchaseDate" = ?, "lastAppliedSignedDate" = ?, "updatedAt" = ?,
  "revokedAt" = ?, "revocationReason" = ?, "revocationType" = ?,
  "revocationPercentage" = ?, "revokedSource" = 'notification'
WHERE "environment" = ? AND "transactionId" = ?
`.trim();

/**
 * Reversal keeps the historical revocation fact. Apple says a reversed refund
 * may warrant reinstating service — but reinstatement is reconciliation's
 * decision, made from current state, not this row's.
 */
const UPDATE_TRANSACTION_REVERSAL_SQL = `
UPDATE "AppleTransaction" SET
  "lastAppliedSignedDate" = ?, "updatedAt" = ?, "reversedAt" = ?, "reversedByUUID" = ?
WHERE "environment" = ? AND "transactionId" = ?
`.trim();

type FactResult = 'applied' | 'superseded';

/**
 * Apply one verified transaction JWS as a durable fact.
 *
 * Ordering is scoped to a single (environment, transactionId) — Apple's own
 * signedDate comparison is per transaction, and comparing across transactions
 * would let one subscription's history reorder another's. Strictly newer wins;
 * an equal signedDate is a repeat, not an update.
 */
async function applyTransactionFact(
  tx: QueueClient,
  facts: VerifiedFacts,
  now: Date,
): Promise<FactResult> {
  const t = facts.transaction!;
  const env = facts.notification.environment;
  const type = facts.notification.notificationType;

  const signedDate = asIso(t.signedDate);
  if (!signedDate) throw new AppleIntakeSemanticError('verified transaction has no signedDate to order by');
  const purchaseDate = asIso(t.purchaseDate);
  if (!purchaseDate) throw new AppleIntakeSemanticError('verified transaction has no purchaseDate');

  const existing = (await tx.$queryRawUnsafe<Record<string, unknown>>(
    SELECT_TRANSACTION_SQL, env, t.transactionId,
  ))[0];

  const iso = now.toISOString();
  const expiresDate = asIso(t.expiresDate);
  const appAccountToken = t.appAccountToken ?? null;

  if (!existing) {
    const revoking = REVOCATION_TYPES.has(type);
    await tx.$executeRawUnsafe(
      INSERT_TRANSACTION_SQL,
      globalThis.crypto.randomUUID(), env, t.transactionId, t.originalTransactionId,
      t.productId, purchaseDate, expiresDate, t.type ?? null, appAccountToken, signedDate,
      revoking ? asIso(t.revocationDate) ?? iso : null,
      revoking ? t.revocationReason ?? null : null,
      revoking ? t.revocationType ?? null : null,
      revoking ? t.revocationPercentage ?? null : null,
      revoking ? 'notification' : null,
      null, null, iso, iso,
    );
    return 'applied';
  }

  /**
   * Transaction identity is immutable. A later JWS claiming the same
   * transactionId belongs to a different subscription or product is not an
   * update to apply — it is a contradiction, and guessing which copy is right
   * is exactly how a customer ends up on someone else's plan.
   */
  if (existing.originalTransactionId !== t.originalTransactionId) {
    throw new AppleIntakeSemanticError('transaction originalTransactionId changed');
  }
  if (existing.productId !== t.productId) {
    throw new AppleIntakeSemanticError('transaction productId changed');
  }

  const storedSignedDate = String(existing.lastAppliedSignedDate ?? '');
  if (!(signedDate > storedSignedDate)) return 'superseded';

  if (type === REVERSAL_TYPE) {
    await tx.$executeRawUnsafe(
      UPDATE_TRANSACTION_REVERSAL_SQL,
      signedDate, iso, asIso(t.revocationDate) ?? iso,
      facts.notification.notificationUUID, env, t.transactionId,
    );
    return 'applied';
  }

  if (REVOCATION_TYPES.has(type)) {
    await tx.$executeRawUnsafe(
      UPDATE_TRANSACTION_REVOCATION_SQL,
      expiresDate, t.type ?? null, appAccountToken, purchaseDate, signedDate, iso,
      asIso(t.revocationDate) ?? iso,
      t.revocationReason ?? null,
      t.revocationType ?? null,
      // Milliunits, 0-100000, stored exactly as Apple sent it. Accounting and
      // audit metadata only — a 50%-refunded subscription is still refunded.
      t.revocationPercentage ?? null,
      env, t.transactionId,
    );
    return 'applied';
  }

  await tx.$executeRawUnsafe(
    UPDATE_TRANSACTION_FACT_SQL,
    expiresDate, t.type ?? null, appAccountToken, purchaseDate, signedDate, iso,
    env, t.transactionId,
  );
  return 'applied';
}

export interface IntakeDeps {
  verifier: AppleVerifier;
  client?: QueueClient;
  now?: () => Date;
}

/**
 * Verify a notification and durably record what Apple said.
 *
 * Never touches User, plan, entitlement, or Stripe. The strongest thing it can
 * do is ask for a reconciliation pass.
 */
export async function ingestAppleNotification(
  signedPayload: string,
  deps: IntakeDeps,
): Promise<IntakeResult> {
  const nowFn = deps.now ?? (() => new Date());

  // Cryptography first, and OUTSIDE any transaction: certificate and OCSP work
  // must never hold the SQLite write lock.
  const notification = await verifyOuter(deps.verifier, signedPayload);
  const facts = await verifyNested(deps.verifier, notification);

  const { environment, notificationUUID, notificationType } = notification;
  const db = deps.client ?? (await import('../utils/prisma')).default as unknown as QueueClient;
  const now = nowFn();

  const reconcileWorthy = RECONCILE_NOTIFICATION_TYPES.has(notificationType);
  const knownNoReconcile = NO_RECONCILE_NOTIFICATION_TYPES.has(notificationType);

  let outcome: IntakeOutcome = 'accepted';
  let reason: string | null = null;
  let enqueued = false;

  if (!reconcileWorthy && !knownNoReconcile) {
    // Unknown, and deliberately not guessed. Newer external-purchase and
    // one-time-charge notification types must not fall into auto-renewable
    // subscription handling just because they arrived.
    outcome = 'ignored';
    reason = 'unsupported notification type';
  } else if (knownNoReconcile) {
    outcome = 'ignored';
    reason = 'notification type does not affect subscription state';
  }

  await db.$transaction(async (tx) => {
    /**
     * Dedupe is the DB's job, decided by the unique index and nothing else.
     * find-then-insert would let two concurrent deliveries of the same UUID both
     * observe "not present" and both apply the fact and bump the generation.
     * The conflict target is notificationUUID specifically, so any OTHER
     * constraint failure still raises instead of masquerading as a duplicate.
     */
    const inserted = await tx.$executeRawUnsafe(
      INSERT_NOTIFICATION_SQL,
      globalThis.crypto.randomUUID(), environment, notificationUUID, notificationType,
      notification.subtype ?? null,
      asIso(notification.signedDate) ?? now.toISOString(),
      facts.transaction?.originalTransactionId ?? null,
      facts.transaction?.transactionId ?? null,
      outcome, reason, now.toISOString(),
    );
    if (inserted === 0) { outcome = 'duplicate'; return; }

    /**
     * Only a reconcile-worthy type writes a transaction fact.
     *
     * An ignored type is audited and nothing more. That is what keeps a newer
     * external-purchase or one-time-charge notification out of the
     * auto-renewable subscription tables entirely — persisting its transaction
     * into AppleTransaction would be letting it into exactly the machinery it
     * must not enter, and no consumer would ever read it, because no
     * reconciliation was requested.
     *
     * It also keeps the audit vocabulary honest: an ignored notification stays
     * "ignored" rather than being relabelled by an ordering result that has no
     * bearing on why it was skipped.
     */
    if (reconcileWorthy && facts.transaction) {
      try {
        const applied = await applyTransactionFact(tx, facts, now);
        if (applied === 'superseded') {
          outcome = 'superseded';
          reason = 'a newer JWS for this transaction was already applied';
        }
      } catch (err) {
        if (!(err instanceof AppleIntakeSemanticError)) throw err;
        // Verified, but it contradicts what is stored. Audit it and apply
        // nothing — including no generation bump, because asking the reconciler
        // to act on a contradiction just moves the problem.
        outcome = 'failed';
        reason = err.reason;
      }
    }

    if (reconcileWorthy && outcome === 'accepted') {
      const oti = facts.transaction?.originalTransactionId;
      if (oti) {
        // The queue primitive owns the generation increment, and deliberately
        // leaves an already-running job running while advancing its target.
        await enqueueReconciliation({ environment, originalTransactionId: oti }, tx, now);
        enqueued = true;
      } else {
        outcome = 'ignored';
        reason = 'no verified transaction identity to reconcile';
      }
    }

    await tx.$executeRawUnsafe(
      FINALISE_NOTIFICATION_SQL, outcome, reason, now.toISOString(), notificationUUID,
    );
  });

  return { outcome, notificationUUID, environment, notificationType, reason: reason ?? undefined, enqueued };
}
