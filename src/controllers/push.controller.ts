import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { config } from '../config';
import { saveSubscription, removeSubscription } from '../services/push.service';

const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 512;

/**
 * POST /push/subscribe — Save a push subscription for the authenticated user.
 */
export async function subscribeHandler(req: AuthRequest, res: Response): Promise<void> {
  if (!config.pushEnabled) {
    res.status(503).json({ error: 'Push notifications are not enabled' });
    return;
  }

  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { subscription } = req.body;

  // Input validation
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    res.status(400).json({ error: 'Missing subscription fields: endpoint, keys.p256dh, keys.auth' });
    return;
  }

  if (typeof subscription.endpoint !== 'string' || subscription.endpoint.length > MAX_ENDPOINT_LENGTH) {
    res.status(400).json({ error: `endpoint must be a string under ${MAX_ENDPOINT_LENGTH} chars` });
    return;
  }

  if (typeof subscription.keys.p256dh !== 'string' || subscription.keys.p256dh.length > MAX_KEY_LENGTH) {
    res.status(400).json({ error: `p256dh key must be a string under ${MAX_KEY_LENGTH} chars` });
    return;
  }

  if (typeof subscription.keys.auth !== 'string' || subscription.keys.auth.length > MAX_KEY_LENGTH) {
    res.status(400).json({ error: `auth key must be a string under ${MAX_KEY_LENGTH} chars` });
    return;
  }

  try {
    await saveSubscription(req.user.userId, subscription, req.headers['user-agent']);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Push] Subscribe error:', err);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
}

/**
 * DELETE /push/subscribe — Remove a push subscription for the authenticated user.
 */
export async function unsubscribeHandler(req: AuthRequest, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { endpoint } = req.body;

  if (!endpoint || typeof endpoint !== 'string') {
    res.status(400).json({ error: 'Missing endpoint string' });
    return;
  }

  try {
    const removed = await removeSubscription(req.user.userId, endpoint);
    if (!removed) {
      res.status(404).json({ error: 'Subscription not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Push] Unsubscribe error:', err);
    res.status(500).json({ error: 'Failed to remove subscription' });
  }
}

/**
 * GET /push/vapid-key — Return the public VAPID key (no auth required).
 */
export async function getVapidKeyHandler(_req: AuthRequest, res: Response): Promise<void> {
  if (!config.pushEnabled) {
    res.status(503).json({ error: 'Push notifications are not enabled' });
    return;
  }

  res.json({ vapidPublicKey: config.vapidPublicKey });
}
