import prisma from '../utils/prisma';
import {
  enqueueReconciliation,
  type AppleEnvironment,
  type QueueClient,
} from './apple-reconciliation-queue.service';
import {
  AppleVerificationPermanentError,
  AppleVerificationTransientError,
  type AppleVerifier,
} from './apple-verifier';
import type { DecodedTransaction } from './apple-server-api';
import { planForAppleProduct, UnknownAppleProductError } from './apple-product-plan';
import { resolveTokenOwner } from './apple-ownership.service';

/**
 * Apple purchase activation and restore.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE:
 *
 *   A client JWS establishes WHICH authoritative subscription should be
 *   reconciled. It never establishes what the user is entitled to.
 *
 * The path it replaces did the opposite. /apple-verify read expiresDate and
 * revocationDate straight out of a client-submitted payload and wrote
 * User.plan, planExpiresAt, planStartedAt and applePurchaseSource from them, and
 * /apple-restore picked whichever submitted transaction had the largest expiry.
 * Both trusted a payload the client chose to send, for a decision about money.
 *
 * Nothing here writes entitlement. A request verifies identity, proves the
 * caller owns the purchase, and durably enqueues a reconciliation. The worker
 * fetches Apple's current state and the projector decides access — behind the
 * generation fence, as the only path to User.plan.
 */

/** The caller cannot be given a purchase token because a Stripe rail is live. */
export class AppleStripeRailActiveError extends Error {
  constructor() {
    super('This account has an active Stripe subscription; cancel it before subscribing through the App Store.');
    this.name = 'AppleStripeRailActiveError';
  }
}

/** The purchase is not this caller's to claim. */
export class AppleOwnershipRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`apple purchase ownership rejected: ${reason}`);
    this.name = 'AppleOwnershipRejectedError';
  }
}

/**
 * Apple already charged, and a Stripe rail appeared before activation.
 *
 * Thrown only AFTER the verified purchase has been durably enqueued: Apple has
 * the customer's money, so the fact must survive even though the response is a
 * conflict. Reconciliation then surfaces the double rail and parks it.
 */
export class ApplePostChargeRailConflictError extends Error {
  constructor() {
    super('billing rail conflict: a Stripe subscription exists for this account');
    this.name = 'ApplePostChargeRailConflictError';
  }
}

/** Reconciliation is not running, so a purchase could never be honoured. */
export class AppleWorkerUnavailableError extends Error {
  constructor() {
    super('apple reconciliation is not currently available');
    this.name = 'AppleWorkerUnavailableError';
  }
}

/** Verification could not be completed. Distinct from "the payload is bad". */
export { AppleVerificationTransientError, AppleVerificationPermanentError };

/** Apple's own guidance is to keep restore batches modest; each JWS may cost OCSP work. */
export const MAX_RESTORE_TRANSACTIONS = 50;

const ENVIRONMENTS: readonly AppleEnvironment[] = ['Production', 'Sandbox'];

export interface ActivationDeps {
  verifier: AppleVerifier;
  /** Reports whether reconciliation can actually honour a purchase. */
  workerAvailable: () => boolean;
  client?: QueueClient;
  now?: () => Date;
}

const db = (deps: ActivationDeps): QueueClient =>
  deps.client ?? (prisma as unknown as QueueClient);

/**
 * Verify a client-submitted transaction without trusting it to say where it came
 * from.
 *
 * The environment is established by which verifier instance succeeds, exactly as
 * in notification intake — a request body may not choose it. A transient failure
 * outranks a permanent one: if one environment could not COMPLETE its check
 * while the other cleanly rejected, telling the customer their purchase is
 * invalid because our OCSP path was down would be a lie about their money.
 */
export async function verifyTransactionAnyEnvironment(
  verifier: AppleVerifier,
  signedTransaction: string,
): Promise<{ environment: AppleEnvironment; transaction: DecodedTransaction }> {
  let firstPermanent: unknown;
  let transient: unknown;
  for (const environment of ENVIRONMENTS) {
    try {
      const transaction = await verifier.verifyTransaction(environment, signedTransaction);
      return { environment, transaction };
    } catch (err) {
      if (err instanceof AppleVerificationTransientError) { transient = err; continue; }
      if (firstPermanent === undefined) firstPermanent = err;
    }
  }
  throw transient ?? firstPermanent
    ?? new AppleVerificationPermanentError('transaction could not be verified');
}

/**
 * Issue (or reuse) the caller's stable StoreKit account token.
 *
 * Concurrency-safe by construction: the UPDATE only writes when the column is
 * still NULL, so two simultaneous requests cannot mint two tokens — the loser's
 * write matches zero rows and it reads back the winner's value. A read-then-write
 * would hand two different UUIDs to the same account, and the purchase made with
 * the discarded one would bind to nobody.
 */
export async function issueAppAccountToken(userId: string, deps: ActivationDeps): Promise<string> {
  const client = db(deps);

  const existing = await client.$queryRawUnsafe<{ appleAppAccountToken: unknown }>(
    `SELECT "appleAppAccountToken" FROM "User" WHERE "id" = ?`, userId,
  );
  if (existing.length === 0) throw new AppleOwnershipRejectedError('user not found');
  const current = existing[0].appleAppAccountToken;
  if (typeof current === 'string' && current.length > 0) return current;

  const candidate = globalThis.crypto.randomUUID();
  await client.$executeRawUnsafe(
    `UPDATE "User" SET "appleAppAccountToken" = ? WHERE "id" = ? AND "appleAppAccountToken" IS NULL`,
    candidate, userId,
  );

  // Read back rather than trusting the write: whoever won, this is the value
  // Apple will echo, so it is the value the caller must be given.
  const settled = await client.$queryRawUnsafe<{ appleAppAccountToken: unknown }>(
    `SELECT "appleAppAccountToken" FROM "User" WHERE "id" = ?`, userId,
  );
  const token = settled[0]?.appleAppAccountToken;
  if (typeof token !== 'string' || token.length === 0) {
    throw new AppleOwnershipRejectedError('could not establish an account token');
  }
  return token;
}

export interface PurchaseContext {
  appAccountToken: string;
}

/**
 * Everything the app needs before calling StoreKit.
 *
 * Refuses when reconciliation is unavailable: sending a customer into a purchase
 * the backend cannot honour takes their money and grants nothing. Refuses when a
 * Stripe rail exists, even at plan 'free' — a non-null stripeSubscriptionId
 * means Stripe may still collect through dunning, so admitting a second rail
 * risks double-billing.
 *
 * An existing APPLE rail deliberately does not block: upgrading or downgrading a
 * subscription goes through StoreKit and must remain possible.
 */
export async function createPurchaseContext(
  userId: string,
  deps: ActivationDeps,
): Promise<PurchaseContext> {
  if (!deps.workerAvailable()) throw new AppleWorkerUnavailableError();

  const client = db(deps);
  const rows = await client.$queryRawUnsafe<{ stripeSubscriptionId: unknown }>(
    `SELECT "stripeSubscriptionId" FROM "User" WHERE "id" = ?`, userId,
  );
  if (rows.length === 0) throw new AppleOwnershipRejectedError('user not found');
  if (typeof rows[0].stripeSubscriptionId === 'string' && rows[0].stripeSubscriptionId.length > 0) {
    throw new AppleStripeRailActiveError();
  }

  return { appAccountToken: await issueAppAccountToken(userId, deps) };
}

/**
 * Does this caller own the purchase?
 *
 * A present token decides — including deciding nobody. The legacy fallback is
 * consulted ONLY when Apple returned no token at all, and even then it can only
 * INHERIT ownership that already exists; it can never create it. Otherwise
 * anyone holding a stranger's signed transaction could attach it to their own
 * account, which is precisely what the token was introduced to stop.
 */
async function assertCallerOwns(
  client: QueueClient,
  userId: string,
  environment: AppleEnvironment,
  transaction: DecodedTransaction,
): Promise<void> {
  const token = transaction.appAccountToken;

  if (typeof token === 'string' && token.length > 0) {
    const owner = await resolveTokenOwner(client, token);
    if (!owner) {
      // A UUID we never issued. Not a claim, and not an invitation to register it.
      throw new AppleOwnershipRejectedError('purchase carries an unrecognised account token');
    }
    if (owner !== userId) {
      throw new AppleOwnershipRejectedError('purchase belongs to a different account');
    }
    return;
  }

  const bound = await client.$queryRawUnsafe<{ userId: unknown }>(
    `SELECT "userId" FROM "AppleSubscription" WHERE "environment" = ? AND "originalTransactionId" = ?`,
    environment, transaction.originalTransactionId,
  );
  const boundUserId = bound[0]?.userId;
  if (typeof boundUserId === 'string' && boundUserId.length > 0) {
    if (boundUserId !== userId) {
      throw new AppleOwnershipRejectedError('purchase belongs to a different account');
    }
    return;
  }

  const legacy = await client.$queryRawUnsafe<{ id: unknown }>(
    `SELECT "id" FROM "User" WHERE "appleOriginalTransactionId" = ?`,
    transaction.originalTransactionId,
  );
  const legacyOwner = legacy[0]?.id;
  if (typeof legacyOwner === 'string' && legacyOwner === userId) return;
  if (typeof legacyOwner === 'string') {
    throw new AppleOwnershipRejectedError('purchase belongs to a different account');
  }

  throw new AppleOwnershipRejectedError(
    'purchase carries no account token and no existing ownership for this account',
  );
}

export interface ActivationResult {
  status: 'pending';
  environment: AppleEnvironment;
}

/**
 * Verify a StoreKit purchase and ask for reconciliation.
 *
 * Never grants. The response is 202/pending and entitlement appears only after
 * the worker has fetched Apple's current state and the projector has run.
 */
export async function activatePurchase(
  userId: string,
  signedTransaction: string,
  deps: ActivationDeps,
): Promise<ActivationResult> {
  const client = db(deps);
  const now = (deps.now ?? (() => new Date()))();

  // Cryptography first, outside any write transaction.
  const { environment, transaction } = await verifyTransactionAnyEnvironment(
    deps.verifier, signedTransaction,
  );

  // An unrecognised product must never be normalised into a plan.
  try {
    planForAppleProduct(transaction.productId);
  } catch (err) {
    if (err instanceof UnknownAppleProductError) {
      throw new AppleVerificationPermanentError('purchase is for an unrecognised product');
    }
    throw err;
  }

  await assertCallerOwns(client, userId, environment, transaction);

  /**
   * Enqueue BEFORE the Stripe check, deliberately.
   *
   * Apple has already charged by the time a signed transaction exists. If a
   * Stripe subscription appeared in the meantime, discarding the Apple fact to
   * keep a tidy-looking database would erase a purchase the customer actually
   * made. Record it, then report the conflict — reconciliation surfaces the
   * double rail and parks it for an operator.
   */
  await enqueueReconciliation(
    { environment, originalTransactionId: transaction.originalTransactionId },
    client, now,
  );

  const rail = await client.$queryRawUnsafe<{ stripeSubscriptionId: unknown }>(
    `SELECT "stripeSubscriptionId" FROM "User" WHERE "id" = ?`, userId,
  );
  const stripeId = rail[0]?.stripeSubscriptionId;
  if (typeof stripeId === 'string' && stripeId.length > 0) {
    throw new ApplePostChargeRailConflictError();
  }

  return { status: 'pending', environment };
}

export interface RestoreResult {
  status: 'pending' | 'no-restorable-purchases';
  /** Distinct subscriptions queued for reconciliation. */
  queued: number;
}

/**
 * Restore previously purchased subscriptions.
 *
 * Chooses nothing. The old implementation picked the submitted transaction with
 * the largest expiresDate and granted from it — client array order and a
 * client-supplied expiry deciding what a customer had paid for. Here every
 * ownership-qualified subscription is queued and Apple's current state decides
 * which, if any, is active.
 */
export async function restoreAppleSubscriptions(
  userId: string,
  signedTransactions: string[],
  deps: ActivationDeps,
): Promise<RestoreResult> {
  if (signedTransactions.length > MAX_RESTORE_TRANSACTIONS) {
    throw new AppleVerificationPermanentError(
      `too many transactions (max ${MAX_RESTORE_TRANSACTIONS})`,
    );
  }

  const client = db(deps);
  const now = (deps.now ?? (() => new Date()))();

  /**
   * Verify everything first, outside any write transaction — certificate and
   * OCSP work must never hold the SQLite write lock.
   *
   * A permanent failure on one entry only drops that entry: a restore batch is
   * whatever the device happened to have, and one unparseable item must not
   * deny a customer their other purchases. A TRANSIENT failure is different and
   * aborts the whole call, because "we could not check" must never be reported
   * as "you own nothing".
   */
  const candidates = new Map<string, { environment: AppleEnvironment; transaction: DecodedTransaction }>();
  for (const signed of signedTransactions) {
    let verified;
    try {
      verified = await verifyTransactionAnyEnvironment(deps.verifier, signed);
    } catch (err) {
      if (err instanceof AppleVerificationTransientError) throw err;
      continue;
    }
    try {
      planForAppleProduct(verified.transaction.productId);
    } catch {
      continue;   // not one of ours
    }
    // Deduplicated by subscription identity, so multiple JWS values for the
    // same subscription produce ONE reconciliation request.
    const key = `${verified.environment}::${verified.transaction.originalTransactionId}`;
    if (!candidates.has(key)) candidates.set(key, verified);
  }

  let queued = 0;
  for (const { environment, transaction } of candidates.values()) {
    try {
      await assertCallerOwns(client, userId, environment, transaction);
    } catch (err) {
      if (err instanceof AppleOwnershipRejectedError) continue;   // not this account's
      throw err;
    }
    await enqueueReconciliation(
      { environment, originalTransactionId: transaction.originalTransactionId },
      client, now,
    );
    queued += 1;
  }

  // Deliberately not "plan: free": absence of a restorable purchase is not an
  // authoritative statement about entitlement.
  return queued === 0
    ? { status: 'no-restorable-purchases', queued: 0 }
    : { status: 'pending', queued };
}
