import { Request, Response } from 'express';
import { AuthRequest } from '../types/auth';
import { config } from '../config';
import {
  createPurchaseContext,
  activatePurchase,
  restoreAppleSubscriptions,
  AppleStripeRailActiveError,
  AppleOwnershipRejectedError,
  ApplePostChargeRailConflictError,
  AppleWorkerUnavailableError,
  MAX_RESTORE_TRANSACTIONS,
} from '../services/apple-activation.service';
import { getAppleWorkerStatus } from '../services/apple-reconciliation-worker';
import { ingestAppleNotification } from '../services/apple-notification-intake.service';
import {
  createAppleVerifier,
  AppleVerificationPermanentError,
  AppleVerificationTransientError,
  type AppleVerifier,
} from '../services/apple-verifier';

/**
 * Shared activation dependencies.
 *
 * The verifier is built lazily and cached, so a disabled deployment never
 * constructs one or reads an Apple credential. Worker availability is a
 * function rather than a snapshot because purchase-context must reflect the
 * state at the moment of the request.
 */
function activationDeps() {
  return {
    verifier: getWebhookVerifier(),
    workerAvailable: () => {
      const w = getAppleWorkerStatus();
      return w.enabled && w.running;
    },
  };
}

/**
 * Map activation failures to status codes by TYPE.
 *
 * The path this replaces searched error text for "already have an active
 * subscription" to decide between 409 and 400, so rewording a message silently
 * changed the contract. Returns true when it handled the error.
 */
function sendActivationError(err: unknown, res: Response, context: string): boolean {
  if (err instanceof AppleWorkerUnavailableError) {
    res.status(503).json({ error: 'Apple purchases are temporarily unavailable', code: 'apple_worker_unavailable' });
    return true;
  }
  if (err instanceof AppleStripeRailActiveError) {
    res.status(409).json({
      error: 'This account has an active subscription managed on the web. Cancel it before subscribing through the App Store.',
      code: 'billing_rail_conflict',
    });
    return true;
  }
  if (err instanceof ApplePostChargeRailConflictError) {
    /**
     * Apple already charged and the purchase HAS been durably recorded — the
     * 409 reports the double rail, it does not discard the purchase.
     */
    res.status(409).json({
      error: 'A subscription already exists for this account on another billing rail. Support can resolve this.',
      code: 'billing_rail_conflict',
    });
    return true;
  }
  if (err instanceof AppleOwnershipRejectedError) {
    res.status(409).json({
      error: 'This purchase is not associated with your account.',
      code: 'apple_ownership_conflict',
    });
    return true;
  }
  if (err instanceof AppleVerificationPermanentError) {
    res.status(400).json({ error: 'Purchase could not be verified' });
    return true;
  }
  if (err instanceof AppleVerificationTransientError) {
    // We could not COMPLETE the check. Telling a paying customer their
    // purchase is invalid because our OCSP path is down would be a lie.
    res.status(503).json({ error: 'Verification temporarily unavailable' });
    return true;
  }
  console.error(`[Apple IAP] ${context} failed:`, err instanceof Error ? err.name : 'unknown');
  return false;
}

/**
 * POST /billing/apple-purchase-context
 *
 * Asks the server whether StoreKit may be started, and returns the opaque
 * server-issued UUID the app must pass as .appAccountToken(...). That token is
 * what later proves the purchase belongs to this account.
 */
export async function applePurchaseContextHandler(req: AuthRequest, res: Response): Promise<void> {
  // Rollout gate first: no token minted, no verifier built, no Apple table read.
  if (!config.appleIapEnabled) {
    res.status(503).json({ error: 'Apple IAP is not enabled', code: 'apple_iap_disabled' });
    return;
  }
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const context = await createPurchaseContext(req.user.userId, activationDeps());
    res.status(200).json({ ok: true, appAccountToken: context.appAccountToken });
  } catch (err) {
    if (sendActivationError(err, res, 'purchase-context')) return;
    res.status(500).json({ error: 'Could not start a purchase' });
  }
}

/**
 * POST /billing/apple-verify
 *
 * Verifies a StoreKit purchase, proves the caller owns it, and durably queues
 * reconciliation. Answers 202 pending: entitlement appears only once the worker
 * has fetched Apple’s current state and the projector has run.
 */
export async function appleVerifyHandler(req: AuthRequest, res: Response): Promise<void> {
  if (!config.appleIapEnabled) {
    res.status(503).json({ error: 'Apple IAP is not enabled', code: 'apple_iap_disabled' });
    return;
  }
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { signedTransaction } = req.body as { signedTransaction?: unknown };
  if (typeof signedTransaction !== 'string' || signedTransaction.length === 0) {
    res.status(400).json({ error: 'Missing signedTransaction' });
    return;
  }

  try {
    await activatePurchase(req.user.userId, signedTransaction, activationDeps());
    // NOT the plan or expiry from the submitted JWS: returning those would
    // recreate client-side authority through the response body even though the
    // database write is gone.
    res.status(202).json({ ok: true, status: 'pending' });
  } catch (err) {
    if (sendActivationError(err, res, 'verify')) return;
    res.status(500).json({ error: 'Could not record the purchase' });
  }
}

/**
 * POST /billing/apple-restore
 *
 * Queues every ownership-qualified subscription. Chooses none of them — Apple’s
 * current state decides which is active.
 */
export async function appleRestoreHandler(req: AuthRequest, res: Response): Promise<void> {
  if (!config.appleIapEnabled) {
    res.status(503).json({ error: 'Apple IAP is not enabled', code: 'apple_iap_disabled' });
    return;
  }
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { signedTransactions } = req.body as { signedTransactions?: unknown };
  if (!Array.isArray(signedTransactions)
      || signedTransactions.some((t) => typeof t !== 'string')) {
    res.status(400).json({ error: 'Missing signedTransactions array' });
    return;
  }
  if (signedTransactions.length > MAX_RESTORE_TRANSACTIONS) {
    res.status(400).json({
      error: `Too many transactions (max ${MAX_RESTORE_TRANSACTIONS})`,
    });
    return;
  }

  try {
    const result = await restoreAppleSubscriptions(
      req.user.userId, signedTransactions as string[], activationDeps(),
    );
    if (result.status === 'no-restorable-purchases') {
      // Deliberately not plan: free — absence of a restorable purchase is not
      // an authoritative statement about entitlement.
      res.status(200).json({ ok: true, status: 'no-restorable-purchases' });
      return;
    }
    res.status(202).json({ ok: true, status: 'pending', queued: result.queued });
  } catch (err) {
    if (sendActivationError(err, res, 'restore')) return;
    res.status(500).json({ error: 'Could not restore purchases' });
  }
}
/**
 * POST /billing/apple-webhook — Handle App Store Server Notifications v2.
 * No auth required — Apple signs the payload with JWS.
 */
/**
 * Built lazily so that a disabled deployment never constructs a verifier or
 * reads Apple credentials. Cached because SignedDataVerifier parses the pinned
 * root certificates on construction.
 */
let webhookVerifier: AppleVerifier | undefined;
function getWebhookVerifier(): AppleVerifier {
  if (!webhookVerifier) {
    webhookVerifier = createAppleVerifier({
      bundleId: config.appleBundleId,
      appAppleId: config.appleAppAppleId,
      enableOnlineChecks: true,
    });
  }
  return webhookVerifier;
}

/** Test seam. Never reachable in production: the flag gate runs first. */
export function __TEST_ONLY_setWebhookVerifier(v: AppleVerifier | undefined): void {
  if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
    throw new Error('__TEST_ONLY_setWebhookVerifier is not available outside tests');
  }
  webhookVerifier = v;
}

export async function appleWebhookHandler(req: Request, res: Response): Promise<void> {
  /**
   * Rollout gate, FIRST — before a verifier exists, before any credential is
   * read, before anything touches an Apple table. The legacy handler had no
   * gate at all, which is why this is the one thing that must happen before
   * everything else rather than somewhere inside the flow.
   */
  if (!config.appleIapEnabled) {
    res.status(503).json({ error: 'Apple notifications are not enabled', code: 'apple_iap_disabled' });
    return;
  }

  let signedPayload: unknown;
  try {
    const rawBody = typeof req.body === 'string' ? req.body : (req.body as Buffer).toString('utf-8');
    signedPayload = (JSON.parse(rawBody) as { signedPayload?: unknown }).signedPayload;
  } catch {
    res.status(400).json({ error: 'Malformed request body' });
    return;
  }
  if (typeof signedPayload !== 'string' || signedPayload.length === 0) {
    res.status(400).json({ error: 'Missing signedPayload' });
    return;
  }

  try {
    const result = await ingestAppleNotification(signedPayload, { verifier: getWebhookVerifier() });

    /**
     * 200 means DURABLE, not "entitlement is now correct".
     *
     * Every outcome reaching here committed: the notification was audited, and
     * any fact or generation bump it implied committed with it. Whether the
     * reconciler or Apple’s Server API is available right now is irrelevant —
     * the durable queue is the work queue, so Apple must not be asked to redeliver
     * an event we have safely stored.
     *
     * Identifiers stay out of the response body; the audit row has them.
     */
    console.log(`[Apple IAP] notification ${result.notificationUUID} (${result.notificationType}, ${result.environment}) -> ${result.outcome}${result.enqueued ? ' +reconcile' : ''}`);
    res.status(200).json({ ok: true, outcome: result.outcome });
  } catch (err) {
    /**
     * Typed, never message-sniffed. The path this replaces decided retry policy
     * by searching error strings for English words like "mismatch" and "Missing",
     * so a reworded library message silently flipped a security decision.
     */
    if (err instanceof AppleVerificationPermanentError) {
      console.warn('[Apple IAP] notification rejected: permanent verification failure');
      res.status(400).json({ error: 'Notification failed verification' });
      return;
    }
    if (err instanceof AppleVerificationTransientError) {
      // We could not COMPLETE the check. Saying 400 would tell Apple the payload
      // was bad when our own OCSP path was the problem.
      console.error('[Apple IAP] notification deferred: verification could not complete');
      res.status(503).json({ error: 'Verification temporarily unavailable' });
      return;
    }
    // Durability failure: nothing committed, so this must NOT be acknowledged.
    console.error('[Apple IAP] notification intake failed:', err instanceof Error ? err.name : 'unknown');
    res.status(503).json({ error: 'Notification could not be stored' });
  }
}
