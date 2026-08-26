import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from '@apple/app-store-server-library';
import prisma from '../utils/prisma';
import { config } from '../config';
import { APPLE_ROOT_CERTS } from '../certs/apple-root-certs';

// App Store JWS verifier — validates each signed payload's x5c certificate
// chain up to Apple's pinned root CAs, plus bundleId/environment claims.
// (StoreKit payloads are signed by the App Store PKI; the Sign in with Apple
// JWKS this service previously used signs ID tokens and can never match them.)
let signedDataVerifier: SignedDataVerifier | null = null;

function getVerifier(): SignedDataVerifier {
  if (!signedDataVerifier) {
    const environment = config.nodeEnv === 'production' ? Environment.PRODUCTION : Environment.SANDBOX;
    signedDataVerifier = new SignedDataVerifier(
      APPLE_ROOT_CERTS,
      true, // online OCSP revocation checks
      environment,
      config.appleBundleId,
      config.appleAppAppleId,
    );
  }
  return signedDataVerifier;
}

/**
 * Map library exceptions onto error messages for the LEGACY activation path.
 *
 * The authoritative notification path does not come through here: it uses
 * apple-verifier.ts, whose typed permanent/transient taxonomy replaced the
 * message-matching this used to feed. Activation/restore still use it, and are
 * rewritten in the next stage.
 */
function mapVerificationError(err: unknown): Error {
  if (err instanceof VerificationException) {
    switch (err.status) {
      case VerificationStatus.INVALID_APP_IDENTIFIER:
        return new Error(`Bundle ID mismatch: expected ${config.appleBundleId}`);
      case VerificationStatus.INVALID_ENVIRONMENT:
        return new Error('Sandbox transaction rejected in production environment');
      case VerificationStatus.RETRYABLE_VERIFICATION_FAILURE:
        return new Error('Apple JWS verification temporarily unavailable (retryable)');
      default:
        return new Error(`Failed to verify Apple JWS transaction - ${VerificationStatus[err.status]}`);
    }
  }
  return err instanceof Error ? err : new Error(String(err));
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
 * Decode and verify a StoreKit 2 JWS signed transaction via the x5c chain.
 * The library validates signature, certificate chain to Apple's roots,
 * bundleId, and environment. Returns the decoded transaction payload.
 */
export async function verifySignedTransaction(signedTransaction: string): Promise<any> {
  try {
    return await getVerifier().verifyAndDecodeTransaction(signedTransaction);
  } catch (err) {
    throw mapVerificationError(err);
  }
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

  // Reject revoked (refunded) transactions and require a future expiry:
  // plan.middleware treats planExpiresAt === null as never-expiring, so an
  // undated or stale transaction must not mint a permanent/zombie paid plan.
  if (txn.revocationDate) {
    throw new Error('This Apple transaction has been revoked.');
  }
  if (!expiresDate || expiresDate.getTime() <= Date.now()) {
    throw new Error('This Apple subscription is expired.');
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
 * Restore purchases - look up existing Apple subscription and reactivate.
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
      // Skip revoked (refunded) and already-expired transactions during
      // selection — a revoked txn with the latest expiry would otherwise make
      // verifyAndActivatePlan throw AND mask a valid earlier subscription.
      if (txn.revocationDate) continue;
      const expiry = txn.expiresDate ? (txn.expiresDate as number) : 0;
      if (expiry <= Date.now()) continue;
      if (expiry > latestExpiry) {
        latestTxn = txn;
        latestExpiry = expiry;
        latestSigned = signed;
      }
    } catch {
      continue; // Skip invalid transactions
    }
  }

  if (!latestTxn) {
    return null; // No active subscription to restore
  }

  return verifyAndActivatePlan(userId, latestSigned);
}

/**
 * REMOVED: handleAppleNotification / processAppleNotification.
 *
 * The App Store Server Notification path is now
 * apple-notification-intake.service.ts. What used to live here decided a
 * customer’s plan from the notification itself: it resolved a user through the
 * transitional appleOriginalTransactionId column, wrote User.plan straight from
 * the notification type, cleared the Apple identity on EXPIRED/REFUND, wrapped
 * the whole thing in runJob so a webhook retried work before responding, and
 * DELETED its own dedupe marker on failure so a replay could apply twice.
 *
 * The replacement may establish verified Apple facts and request reconciliation.
 * It may not establish entitlement. Nothing notification-shaped belongs in this
 * file again.
 */
