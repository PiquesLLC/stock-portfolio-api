import * as jose from 'jose';
import prisma from '../utils/prisma';
import { config } from '../config';

// Apple's public keys for JWS verification (cached)
let applePublicKeys: jose.JWK[] | null = null;
let appleKeysExpiry = 0;

async function getApplePublicKeys(): Promise<jose.JWK[]> {
  if (applePublicKeys && Date.now() < appleKeysExpiry) {
    return applePublicKeys;
  }

  const res = await fetch('https://appleid.apple.com/auth/keys');
  if (!res.ok) throw new Error(`Failed to fetch Apple public keys: ${res.status}`);
  const data = await res.json() as { keys: jose.JWK[] };
  applePublicKeys = data.keys;
  appleKeysExpiry = Date.now() + 24 * 60 * 60 * 1000; // cache 24h
  return applePublicKeys;
}

/**
 * Map Apple product IDs to Nala plan tiers.
 */
function mapAppleProductToPlan(productId: string): string {
  const map: Record<string, string> = {
    'nala_pro_monthly': 'pro',
    'nala_pro_yearly': 'pro',
    'nala_premium_monthly': 'premium',
    'nala_premium_yearly': 'premium',
    'nala_elite_monthly': 'elite',
    'nala_elite_yearly': 'elite',
  };
  return map[productId] || 'free';
}

/**
 * Decode and verify a StoreKit 2 JWS signed transaction.
 * Validates signature, bundleId, and environment claims.
 * Returns the decoded transaction payload.
 */
export async function verifySignedTransaction(signedTransaction: string): Promise<any> {
  const keys = await getApplePublicKeys();

  // Try each key until one verifies
  for (const key of keys) {
    try {
      const publicKey = await jose.importJWK(key, 'ES256');
      const { payload } = await jose.jwtVerify(signedTransaction, publicKey, {
        algorithms: ['ES256'],
      });

      // Validate app-scoped claims to prevent cross-app transaction injection
      if (payload.bundleId && payload.bundleId !== config.appleBundleId) {
        throw new Error(`Bundle ID mismatch: expected ${config.appleBundleId}, got ${payload.bundleId}`);
      }

      // Validate environment: reject sandbox transactions in production
      if (config.nodeEnv === 'production' && payload.environment === 'Sandbox') {
        throw new Error('Sandbox transaction rejected in production environment');
      }

      return payload;
    } catch (err: any) {
      // If this was a claim validation failure (not a key mismatch), re-throw immediately
      if (err?.message?.includes('mismatch') || err?.message?.includes('rejected')) {
        throw err;
      }
      continue;
    }
  }
  throw new Error('Failed to verify Apple JWS transaction — no matching key');
}

/**
 * Verify a transaction and activate the corresponding plan for a user.
 */
export async function verifyAndActivatePlan(
  userId: string,
  signedTransaction: string,
): Promise<{ plan: string; expiresAt: Date | null }> {
  const txn = await verifySignedTransaction(signedTransaction);

  const productId = txn.productId as string;
  const originalTransactionId = txn.originalTransactionId as string;
  const expiresDate = txn.expiresDate ? new Date(txn.expiresDate as number) : null;

  const plan = mapAppleProductToPlan(productId);
  if (plan === 'free') {
    throw new Error(`Unknown Apple product ID: ${productId}`);
  }

  // Atomic: check for conflicting subscriptions + activate plan in one transaction
  // Prevents races on both Stripe conflict and Apple transaction replay
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { stripeSubscriptionId: true, plan: true },
    });

    if (user?.stripeSubscriptionId && user.plan !== 'free') {
      throw new Error('You already have an active subscription managed through the web. Please cancel it first before subscribing via the App Store.');
    }

    // Prevent transaction replay / account sharing:
    // If this originalTransactionId is already bound to a different user, reject.
    const existingOwner = await tx.user.findUnique({
      where: { appleOriginalTransactionId: originalTransactionId },
      select: { id: true },
    });
    if (existingOwner && existingOwner.id !== userId) {
      throw new Error('This Apple subscription is already linked to another account.');
    }

    await tx.user.update({
      where: { id: userId },
      data: {
        plan,
        planExpiresAt: expiresDate,
        planStartedAt: new Date(),
        appleOriginalTransactionId: originalTransactionId,
        applePurchaseSource: 'app_store',
      },
    });

    return { plan, expiresAt: expiresDate };
  });

  return result;
}

/**
 * Restore purchases — look up existing Apple subscription and reactivate.
 */
export async function restorePurchases(
  userId: string,
  signedTransactions: string[],
): Promise<{ plan: string; expiresAt: Date | null } | null> {
  if (signedTransactions.length === 0) return null;

  // Find the latest valid subscription
  let latestTxn: any = null;
  let latestExpiry = 0;
  let latestSigned = '';

  for (const signed of signedTransactions) {
    try {
      const txn = await verifySignedTransaction(signed);
      const expiry = txn.expiresDate ? (txn.expiresDate as number) : 0;
      if (expiry > latestExpiry) {
        latestTxn = txn;
        latestExpiry = expiry;
        latestSigned = signed;
      }
    } catch {
      continue; // Skip invalid transactions
    }
  }

  if (!latestTxn || latestExpiry < Date.now()) {
    return null; // No active subscription to restore
  }

  return verifyAndActivatePlan(userId, latestSigned);
}

/**
 * Handle App Store Server Notification v2.
 * The payload is a signed JWS from Apple containing notification type and transaction info.
 */
export async function handleAppleNotification(signedPayload: string): Promise<void> {
  // Decode outer notification JWS
  const notification = await verifySignedTransaction(signedPayload);
  const notificationType = notification.notificationType as string;
  const notificationUUID = notification.notificationUUID as string;

  // Idempotency: try to insert first — unique constraint prevents double-processing
  // This eliminates the TOCTOU race of find-then-create
  try {
    await prisma.appleIAPWebhookEvent.create({
      data: {
        notificationId: notificationUUID,
        type: notificationType,
      },
    });
  } catch (err: any) {
    // Unique constraint violation = duplicate notification — skip
    if (err?.code === 'P2002') {
      console.log(`[Apple IAP] Duplicate notification ${notificationUUID}, skipping`);
      return;
    }
    throw err; // Re-throw unexpected errors
  }

  // Extract the signed transaction from the notification data
  const data = notification.data as any;
  if (!data?.signedTransactionInfo) {
    console.log(`[Apple IAP] No transaction info in ${notificationType} notification`);
    return;
  }

  const txn = await verifySignedTransaction(data.signedTransactionInfo);
  const originalTransactionId = txn.originalTransactionId as string;
  const productId = txn.productId as string;
  const expiresDate = txn.expiresDate ? new Date(txn.expiresDate as number) : null;

  // Find the user by their Apple transaction ID
  const user = await prisma.user.findFirst({
    where: { appleOriginalTransactionId: originalTransactionId },
  });

  if (!user) {
    console.warn(`[Apple IAP] No user found for originalTransactionId ${originalTransactionId}`);
    return;
  }

  switch (notificationType) {
    case 'DID_RENEW':
    case 'SUBSCRIBED':
    case 'DID_CHANGE_RENEWAL_STATUS': {
      const plan = mapAppleProductToPlan(productId);
      if (plan !== 'free') {
        await prisma.user.update({
          where: { id: user.id },
          data: { plan, planExpiresAt: expiresDate },
        });
        console.log(`[Apple IAP] Renewed/updated plan for user ${user.id}: ${plan}`);
      }
      break;
    }

    case 'EXPIRED':
    case 'REVOKE':
    case 'REFUND': {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          plan: 'free',
          planExpiresAt: null,
          appleOriginalTransactionId: null,
          applePurchaseSource: null,
        },
      });
      console.log(`[Apple IAP] Downgraded user ${user.id} to free (${notificationType})`);
      break;
    }

    case 'DID_CHANGE_RENEWAL_INFO': {
      // User changed their auto-renew preferences — log but no action needed
      console.log(`[Apple IAP] User ${user.id} changed renewal info`);
      break;
    }

    default:
      console.log(`[Apple IAP] Unhandled notification type: ${notificationType}`);
  }
}
