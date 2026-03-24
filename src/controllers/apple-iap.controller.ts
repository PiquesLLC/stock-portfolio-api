import { Request, Response } from 'express';
import { AuthRequest } from '../types/auth';
import { config } from '../config';
import { verifyAndActivatePlan, restorePurchases, handleAppleNotification } from '../services/apple-iap.service';

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
export async function appleWebhookHandler(req: Request, res: Response): Promise<void> {
  try {
    // Apple sends the payload as raw body (express.raw middleware)
    const rawBody = typeof req.body === 'string' ? req.body : req.body.toString('utf-8');
    const parsed = JSON.parse(rawBody);
    const signedPayload = parsed.signedPayload;

    if (!signedPayload) {
      res.status(400).json({ error: 'Missing signedPayload' });
      return;
    }

    await handleAppleNotification(signedPayload);
    res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error('[Apple IAP] Webhook error:', err);

    // Distinguish permanent vs transient failures:
    // - JWS verification failures, missing data = permanent (200 — don't retry)
    // - DB errors, network errors = transient (500 — Apple will retry)
    const message = err?.message || '';
    const isPermanent =
      message.includes('no matching key') ||
      message.includes('mismatch') ||
      message.includes('rejected') ||
      message.includes('Missing') ||
      err?.code === 'P2002'; // duplicate notification (idempotency)

    if (isPermanent) {
      res.status(200).json({ ok: false, error: message });
    } else {
      // Transient failure — return 500 so Apple retries
      res.status(500).json({ ok: false, error: 'Internal processing error' });
    }
  }
}
