import { Request, Response } from 'express';
import { AuthRequest } from '../types/auth';
import { config } from '../config';
import { verifyAndActivatePlan, restorePurchases } from '../services/apple-iap.service';
import { ingestAppleNotification } from '../services/apple-notification-intake.service';
import {
  createAppleVerifier,
  AppleVerificationPermanentError,
  AppleVerificationTransientError,
  type AppleVerifier,
} from '../services/apple-verifier';

/**
 * POST /billing/apple-verify — Verify an Apple IAP transaction and activate the plan.
 */
export async function appleVerifyHandler(req: AuthRequest, res: Response): Promise<void> {
  if (!config.appleIapEnabled) {
    res.status(503).json({ error: 'Apple IAP is not enabled' });
    return;
  }

  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { signedTransaction } = req.body;
  if (!signedTransaction || typeof signedTransaction !== 'string') {
    res.status(400).json({ error: 'Missing signedTransaction' });
    return;
  }

  try {
    const result = await verifyAndActivatePlan(req.user.userId, signedTransaction);
    res.json({ ok: true, plan: result.plan, expiresAt: result.expiresAt });
  } catch (err: any) {
    console.error('[Apple IAP] Verify error:', err);
    if (err.message?.includes('already have an active subscription')) {
      res.status(409).json({ error: err.message });
    } else {
      res.status(400).json({ error: 'Failed to verify transaction' });
    }
  }
}

/**
 * POST /billing/apple-restore — Restore previous Apple purchases.
 */
export async function appleRestoreHandler(req: AuthRequest, res: Response): Promise<void> {
  if (!config.appleIapEnabled) {
    res.status(503).json({ error: 'Apple IAP is not enabled' });
    return;
  }

  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { signedTransactions } = req.body;
  if (!Array.isArray(signedTransactions)) {
    res.status(400).json({ error: 'Missing signedTransactions array' });
    return;
  }

  try {
    const result = await restorePurchases(req.user.userId, signedTransactions);
    if (!result) {
      res.json({ ok: false, message: 'No active subscription found to restore' });
    } else {
      res.json({ ok: true, plan: result.plan, expiresAt: result.expiresAt });
    }
  } catch (err: any) {
    console.error('[Apple IAP] Restore error:', err);
    res.status(400).json({ error: 'Failed to restore purchases' });
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
