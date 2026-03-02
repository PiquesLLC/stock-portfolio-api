import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { config } from '../config';
import { saveSubscription, removeSubscription, sendPushToUser, getSubscriptionCount } from '../services/push.service';

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

  // Validate endpoint is a legitimate push service URL (SSRF prevention)
  try {
    const endpointUrl = new URL(subscription.endpoint);
    const PUSH_DOMAINS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'push.services.mozilla.com'];
    if (endpointUrl.protocol !== 'https:' || !PUSH_DOMAINS.some(d => endpointUrl.hostname.endsWith(d))) {
      res.status(400).json({ error: 'Invalid push endpoint domain' });
      return;
    }
  } catch {
    res.status(400).json({ error: 'Invalid push endpoint URL' });
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

/**
 * POST /push/test — Send a test push notification to the authenticated user.
 */
export async function testPushHandler(req: AuthRequest, res: Response): Promise<void> {
  if (!config.pushEnabled) {
    res.status(503).json({ error: 'Push notifications are not enabled' });
    return;
  }

  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const count = await getSubscriptionCount(req.user.userId);
    if (count === 0) {
      res.json({ ok: false, message: 'No push subscriptions found for your account. Enable push notifications in the app first.', subscriptions: 0 });
      return;
    }
    await sendPushToUser(req.user.userId, {
      title: 'Nala Push Test',
      body: 'If you see this on your lock screen, push notifications are working!',
      icon: '/icons/icon-192.webp',
      badge: '/icons/icon-72.webp',
      tag: 'push-test',
      data: { url: '/', type: 'test' },
    });
    res.json({ ok: true, message: `Test push sent to ${count} subscription(s)`, subscriptions: count });
  } catch (err) {
    console.error('[Push] Test push error:', err);
    res.status(500).json({ error: 'Failed to send test push' });
  }
}
