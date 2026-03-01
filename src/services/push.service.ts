import webpush from 'web-push';
import prisma from '../utils/prisma';
import { config } from '../config';

// Configure VAPID keys once at startup (only if push is enabled)
if (config.pushEnabled && config.vapidPublicKey && config.vapidPrivateKey) {
  webpush.setVapidDetails(
    config.vapidSubject,
    config.vapidPublicKey,
    config.vapidPrivateKey,
  );
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: { url?: string; type?: string; eventId?: string };
}

interface SubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/**
 * Save (upsert) a push subscription for a user.
 * If the endpoint already exists for another user (shared device),
 * it rebinds to the current user.
 */
export async function saveSubscription(
  userId: string,
  subscription: SubscriptionInput,
  userAgent?: string,
): Promise<void> {
  await prisma.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    update: {
      userId,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: userAgent ?? null,
    },
    create: {
      userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: userAgent ?? null,
    },
  });
}

/**
 * Remove a push subscription by endpoint for a specific user.
 */
export async function removeSubscription(userId: string, endpoint: string): Promise<boolean> {
  const sub = await prisma.pushSubscription.findFirst({
    where: { endpoint, userId },
  });
  if (!sub) return false;
  await prisma.pushSubscription.delete({ where: { id: sub.id } });
  return true;
}

/**
 * Send a push notification to all subscriptions for a given user.
 * Auto-deletes expired subscriptions (410 Gone / 404).
 * Fire-and-forget — logs errors but never throws.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!config.pushEnabled) return;

  try {
    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId },
    });

    if (subscriptions.length === 0) return;

    const payloadStr = JSON.stringify({
      title: payload.title,
      body: payload.body,
      icon: payload.icon || '/icons/icon-192.webp',
      badge: payload.badge || '/icons/icon-72.webp',
      tag: payload.tag,
      data: payload.data,
    });

    const results = await Promise.allSettled(
      subscriptions.map(sub =>
        webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payloadStr,
        ),
      ),
    );

    // Clean up expired subscriptions
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const err = result.reason as { statusCode?: number };
        if (err.statusCode === 404 || err.statusCode === 410) {
          // Subscription expired — remove from DB
          await prisma.pushSubscription.delete({
            where: { id: subscriptions[i].id },
          }).catch(() => {}); // ignore if already deleted
          console.log(`[Push] Removed expired subscription for user ${userId}`);
        } else {
          console.error(`[Push] Failed to send to user ${userId}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('[Push] Unexpected error in sendPushToUser:', err);
  }
}
