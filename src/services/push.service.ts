import webpush from 'web-push';
import * as jose from 'jose';
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
const MAX_SUBSCRIPTIONS_PER_USER = 10;

export async function saveSubscription(
  userId: string,
  subscription: SubscriptionInput,
  userAgent?: string,
): Promise<void> {
  // Check per-user cap (only for new endpoints, not upserts)
  const existing = await prisma.pushSubscription.findUnique({ where: { endpoint: subscription.endpoint } });
  if (!existing) {
    const count = await prisma.pushSubscription.count({ where: { userId } });
    if (count >= MAX_SUBSCRIPTIONS_PER_USER) {
      throw new Error('Maximum push subscriptions reached');
    }
  }

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
 * Get the number of push subscriptions for a user (debug helper).
 */
export async function getSubscriptionCount(userId: string): Promise<number> {
  const subs = await prisma.pushSubscription.findMany({ where: { userId }, select: { id: true } });
  return subs.length;
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

// ─── Native Device Push Tokens (APNs) ────────────────────────────────

const MAX_DEVICE_TOKENS_PER_USER = 10;

/**
 * Save (upsert) a native device push token for a user.
 */
export async function saveDeviceToken(
  userId: string,
  token: string,
  platform: string,
): Promise<void> {
  const existing = await prisma.devicePushToken.findUnique({ where: { token } });
  if (!existing) {
    const count = await prisma.devicePushToken.count({ where: { userId } });
    if (count >= MAX_DEVICE_TOKENS_PER_USER) {
      throw new Error('Maximum device tokens reached');
    }
  }
  await prisma.devicePushToken.upsert({
    where: { token },
    update: { userId, platform },
    create: { userId, token, platform },
  });
}

/**
 * Remove a native device push token.
 */
export async function removeDeviceToken(userId: string, token: string): Promise<boolean> {
  const dt = await prisma.devicePushToken.findFirst({ where: { token, userId } });
  if (!dt) return false;
  await prisma.devicePushToken.delete({ where: { id: dt.id } });
  return true;
}

/**
 * Generate a short-lived APNs JWT for HTTP/2 API authentication.
 */
let apnsJwtCache: { token: string; expiresAt: number } | null = null;

async function getApnsJwt(): Promise<string> {
  if (apnsJwtCache && Date.now() < apnsJwtCache.expiresAt) {
    return apnsJwtCache.token;
  }

  const privateKey = await jose.importPKCS8(config.apnsPrivateKey, 'ES256');
  const jwt = await new jose.SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: config.apnsKeyId })
    .setIssuer(config.apnsTeamId)
    .setIssuedAt()
    .sign(privateKey);

  // Cache for 50 minutes (Apple tokens valid for 60 min)
  apnsJwtCache = { token: jwt, expiresAt: Date.now() + 50 * 60 * 1000 };
  return jwt;
}

/**
 * Send a native push notification to all device tokens for a given user.
 * Uses APNs HTTP/2 API. Fire-and-forget — logs errors but never throws.
 */
export async function sendNativePushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!config.apnsPrivateKey || !config.apnsKeyId) return;

  try {
    const tokens = await prisma.devicePushToken.findMany({ where: { userId } });
    if (tokens.length === 0) return;

    const jwt = await getApnsJwt();
    const apnsHost = config.nodeEnv === 'production'
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';

    const apnsPayload = JSON.stringify({
      aps: {
        alert: { title: payload.title, body: payload.body },
        badge: 1,
        sound: 'default',
        'thread-id': payload.tag || 'nala',
      },
      data: payload.data,
    });

    await Promise.allSettled(
      tokens.filter(t => t.platform === 'ios').map(async (t) => {
        const res = await fetch(`${apnsHost}/3/device/${t.token}`, {
          method: 'POST',
          headers: {
            'authorization': `bearer ${jwt}`,
            'apns-topic': config.apnsBundleId,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'content-type': 'application/json',
          },
          body: apnsPayload,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (res.status === 410 || (body as any).reason === 'Unregistered') {
            // Token is invalid — remove
            await prisma.devicePushToken.delete({ where: { id: t.id } }).catch(() => {});
            console.log(`[Push] Removed expired device token for user ${userId}`);
          } else {
            console.error(`[Push] APNs error for user ${userId}:`, res.status, body);
          }
        }
      }),
    );
  } catch (err) {
    console.error('[Push] Unexpected error in sendNativePushToUser:', err);
  }
}
