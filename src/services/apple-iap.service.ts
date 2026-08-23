import * as jose from 'jose';
import { createHash } from 'crypto';
import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from '@apple/app-store-server-library';
import prisma from '../utils/prisma';
import { config } from '../config';
import { JobExecutionError, runJob } from './job-runner.service';
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
 * Map library exceptions onto the existing error-message contract —
 * classifyAppleNotificationError keys on these phrases to mark failures
 * PERMANENT, and RETRYABLE_VERIFICATION_FAILURE (e.g. an OCSP fetch flake)
 * must NOT match any permanent phrase so the job runner retries it.
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

function decodeNotificationMetadata(signedPayload: string): { notificationUUID?: string; notificationType?: string } {
  try {
    const decoded = jose.decodeJwt(signedPayload) as { notificationUUID?: string; notificationType?: string };
    return {
      notificationUUID: decoded.notificationUUID,
      notificationType: decoded.notificationType,
    };
  } catch {
    return {};
  }
}

function toJobName(notificationId?: string, signedPayload?: string): string {
  if (notificationId) return `apple_iap_webhook_${notificationId}`;
  const payloadHash = createHash('sha256').update(signedPayload || '').digest('hex').slice(0, 16);
  return `apple_iap_webhook_${payloadHash}`;
}

function classifyAppleNotificationError(err: unknown): unknown {
  if (err instanceof JobExecutionError) return err;

  const message = err instanceof Error ? err.message : String(err ?? '');
  const lower = message.toLowerCase();
  const permanentPatterns = [
    'bundle id mismatch',
    'sandbox transaction rejected',
    'failed to verify apple jws transaction',
    'missing signedpayload',
    'missing notificationuuid',
    'missing notificationtype',
  ];

  if (permanentPatterns.some((pattern) => lower.includes(pattern))) {
    return new JobExecutionError(message, 'PERMANENT');
  }

  return err;
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
 * Decode and verify an App Store Server Notification V2 envelope.
 * Notifications carry their app identifiers inside `data`/`summary`, so they
 * need the notification-specific verifier (which, in production, also matches
 * `appAppleId` against config.appleAppAppleId — set APPLE_APP_APPLE_ID).
 */
export async function verifySignedNotification(signedPayload: string): Promise<any> {
  try {
    return await getVerifier().verifyAndDecodeNotification(signedPayload);
  } catch (err) {
    throw mapVerificationError(err);
  }
}

/**
 * H-1 — marker written into the existing `applePurchaseSource` column when Apple
 * tells us a transaction was refunded or revoked.
 *
 * Why a marker rather than clearing the binding: `verifyAndActivatePlan` decides
 * whether a purchase is valid by reading `revocationDate` off the JWS the CLIENT
 * submits. That JWS was signed at purchase time, so it can never contain a
 * refund that happened afterwards. The refund webhook used to null out
 * `appleOriginalTransactionId` — which deleted the only thing standing between a
 * refunded user and a replay of their saved receipt. Keeping the binding and
 * flagging it means the replay is recognised and refused.
 *
 * The flag is cleared ONLY by a subsequent server-to-server notification from
 * Apple (SUBSCRIBED / renewal), never by a client-submitted receipt — so a
 * genuine re-subscription still works (Apple reuses originalTransactionId across
 * resubscribes) while a replayed pre-refund receipt does not.
 */
const APPLE_SOURCE_REVOKED = 'app_store_revoked';

/**
 * The marker also carries WHEN the revocation happened, encoded as
 * `app_store_revoked:<epochMs>` in the existing `applePurchaseSource` column
 * (no schema change).
 *
 * The timestamp is load-bearing. Apple retries an unacknowledged server
 * notification for up to three days, so a SUBSCRIBED or DID_RENEW generated
 * BEFORE a refund can be delivered AFTER we processed the REFUND. Its
 * signedTransactionInfo predates the refund, so it carries no revocationDate
 * and still shows a future expiry — it passes every content check. Only
 * comparing its purchase time against the revocation time can reject it.
 */
function markRevoked(revocationDate?: unknown): string {
  // Prefer APPLE's revocation instant over our processing time. Stamping
  // Date.now() pushes the recorded revocation later by the whole notification
  // delivery delay, and the marker is compared against Apple's purchaseDate —
  // so a delayed REFUND plus a prompt legitimate re-subscription would leave the
  // new purchase looking OLDER than the revocation, refusing a paying customer
  // and never clearing the marker.
  const appleMs = Number(revocationDate);
  const revokedAt = Number.isFinite(appleMs) && appleMs > 0 ? appleMs : Date.now();
  return `${APPLE_SOURCE_REVOKED}:${revokedAt}`;
}

function isRevokedMarker(source: string | null | undefined): boolean {
  return typeof source === 'string' && source.startsWith(APPLE_SOURCE_REVOKED);
}

/** Epoch ms of the revocation, or null when unknown (legacy un-timestamped marker). */
function revokedAtMs(source: string | null | undefined): number | null {
  if (!isRevokedMarker(source)) return null;
  const raw = String(source).slice(APPLE_SOURCE_REVOKED.length + 1);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
      select: { id: true, applePurchaseSource: true },
    });
    if (existingOwner && existingOwner.id !== userId) {
      throw new Error('This Apple subscription is already linked to another account.');
    }

    // H-1: refuse a transaction Apple has already told us was refunded/revoked.
    // The submitted JWS cannot show this — it predates the refund — so the
    // server-side marker is the only signal. Without this check, "buy, refund,
    // replay the saved receipt" restored paid access for the rest of the term.
    if (existingOwner && isRevokedMarker(existingOwner.applePurchaseSource)) {
      throw new Error('This Apple transaction has been refunded or revoked.');
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
 * Handle App Store Server Notification v2.
 * The payload is a signed JWS from Apple containing notification type and transaction info.
 */
export async function handleAppleNotification(signedPayload: string): Promise<void> {
  const decoded = decodeNotificationMetadata(signedPayload);
  const notificationId = decoded.notificationUUID;
  const notificationType = decoded.notificationType;

  await runJob({
    name: toJobName(notificationId, signedPayload),
    maxAttempts: 3,
    baseDelayMs: 3000,
    throwOnFailure: true,
    context: {
      provider: 'apple_iap',
      notificationId: notificationId || null,
      notificationType: notificationType || null,
    },
    fn: async () => {
      try {
        await processAppleNotification(signedPayload);
      } catch (err) {
        throw classifyAppleNotificationError(err);
      }
    },
  });
}

async function processAppleNotification(signedPayload: string): Promise<void> {
  // Decode outer notification JWS (notification-specific verification)
  const notification = await verifySignedNotification(signedPayload);
  const notificationType = notification.notificationType as string;
  const notificationUUID = notification.notificationUUID as string;

  if (!notificationUUID) {
    throw new JobExecutionError('Missing notificationUUID in Apple notification payload', 'PERMANENT');
  }

  if (!notificationType) {
    throw new JobExecutionError('Missing notificationType in Apple notification payload', 'PERMANENT');
  }

  // Idempotency: try to insert first - unique constraint prevents double-processing.
  // This eliminates the TOCTOU race of find-then-create.
  try {
    await prisma.appleIAPWebhookEvent.create({
      data: {
        notificationId: notificationUUID,
        type: notificationType,
      },
    });
  } catch (err: any) {
    // Unique constraint violation = duplicate notification - skip.
    if (err?.code === 'P2002') {
      console.log(`[Apple IAP] Duplicate notification ${notificationUUID}, skipping`);
      return;
    }
    throw err;
  }

  try {
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
        if (plan === 'free') break;

        // Never restore access from a transaction Apple has revoked. The
        // client-facing path (verifyAndActivatePlan) checks this; this one did
        // not, so a revoked transaction arriving on any of these notifications
        // would have re-granted the plan.
        if (txn.revocationDate) {
          console.warn(`[Apple IAP] ignoring ${notificationType} for revoked transaction (user ${user.id})`);
          break;
        }

        // Require a real future expiry. plan.middleware treats
        // `planExpiresAt === null` as NEVER EXPIRING, so writing a null
        // expiresDate straight through here would mint a permanent paid plan
        // from a notification that carried no expiry. verifyAndActivatePlan
        // guards exactly this case; this path was missing it.
        if (!expiresDate || expiresDate.getTime() <= Date.now()) {
          console.warn(`[Apple IAP] ignoring ${notificationType} with missing/past expiry (user ${user.id})`);
          break;
        }

        // H-1: only a genuine purchase or renewal clears the revoked marker,
        // and only when it provably happened AFTER the revocation.
        //
        // DID_CHANGE_RENEWAL_STATUS fires when the user toggles auto-renew in
        // App Store settings — no purchase is involved — so it never clears the
        // marker, though it may still refresh plan/expiry.
        //
        // For DID_RENEW / SUBSCRIBED we compare the transaction's purchase time
        // against the recorded revocation time. Apple retries an unacknowledged
        // notification for up to three days, so a SUBSCRIBED generated before a
        // refund can arrive after it — carrying no revocationDate and a future
        // expiry, i.e. passing every check above. Without this comparison such a
        // straggler would restore the plan AND clear the marker, handing back a
        // refunded subscription and re-opening the client replay.
        const isPurchaseNotification = notificationType === 'DID_RENEW' || notificationType === 'SUBSCRIBED';
        const currentlyRevoked = isRevokedMarker(user.applePurchaseSource);
        const revokedAt = revokedAtMs(user.applePurchaseSource);
        // Apple's JWS timestamps are epoch MILLISECONDS, same as expiresDate above.
        const purchasedAtMs = txn.purchaseDate ? Number(txn.purchaseDate) : null;

        // Fail CLOSED. If the row is marked revoked but we cannot establish
        // WHEN (an un-timestamped marker, or a transaction with no purchaseDate),
        // we cannot prove this notification post-dates the revocation — so we do
        // not act on it. Being unable to restore a plan is recoverable; wrongly
        // restoring a refunded one is not.
        const supersedesRevocation = !currentlyRevoked
          || (revokedAt !== null && purchasedAtMs !== null && purchasedAtMs > revokedAt);

        if (currentlyRevoked && !supersedesRevocation) {
          console.warn(
            `[Apple IAP] ignoring stale ${notificationType} for user ${user.id} — purchase predates the revocation`,
          );
          break;
        }

        // INVARIANT 8 — entitlement must never move BACKWARD.
        //
        // Apple retries an unacknowledged notification for up to three days, so
        // a renewal generated before a later one can be delivered after it.
        // planExpiresAt was written unconditionally, so such a straggler
        // shortened a subscription the user had already paid to extend. Only
        // ever extend.
        const currentExpiryMs = user.planExpiresAt ? new Date(user.planExpiresAt).getTime() : null;
        if (currentExpiryMs !== null && expiresDate.getTime() <= currentExpiryMs) {
          console.warn(
            `[Apple IAP] ignoring stale ${notificationType} for user ${user.id} — its expiry is not later than the current entitlement`,
          );
          break;
        }

        const clearsRevokedMarker = isPurchaseNotification && supersedesRevocation;

        // INVARIANT 7 — predicated write, so a concurrent notification cannot be
        // clobbered. Both `currentlyRevoked` and the expiry comparison above are
        // derived from the row read at the top of this handler; between that read
        // and this write a REFUND for the same user can commit its revoked
        // marker. An unconditional update would silently erase it (a plain lost
        // update — these are two autocommit statements, not a transaction).
        // Scoping the update to the value we branched on makes a stale write a
        // no-op instead. The dedup key is per-notificationUUID and the job
        // runner's in-flight guard keys on job name, so neither serialises two
        // DIFFERENT notifications for one user.
        const renewWrite = await prisma.user.updateMany({
          where: { id: user.id, applePurchaseSource: user.applePurchaseSource ?? null },
          data: {
            plan,
            planExpiresAt: expiresDate,
            ...(clearsRevokedMarker ? { applePurchaseSource: 'app_store' } : {}),
          },
        });
        if (renewWrite.count === 0) {
          console.warn(
            `[Apple IAP] ${notificationType} for user ${user.id} skipped — row changed concurrently since it was read`,
          );
          break;
        }
        console.log(`[Apple IAP] Renewed/updated plan for user ${user.id}: ${plan}`);
        break;
      }

      case 'EXPIRED':
      case 'REVOKE':
      case 'REFUND': {
        const revoked = notificationType === 'REFUND' || notificationType === 'REVOKE';

        // REFUND/REVOKE: KEEP the binding and stamp a revoked marker. The
        // receipt the user still holds looks perfectly valid (signed
        // pre-refund, future expiry, no revocationDate), so only a server-side
        // marker can refuse the replay — and clearing the binding would delete
        // the very row that carries it.
        //
        // EXPIRED: CLEAR the binding, as before. An expired receipt is already
        // refused by verifyAndActivatePlan's own expiry check, so no marker is
        // needed — and retaining the binding actively breaks normal churn.
        // Apple reuses originalTransactionId across resubscribes, so a retained
        // binding means (a) the same Apple ID subscribing on a NEW Nala account
        // is permanently refused with "already linked to another account", and
        // worse (b) the resulting SUBSCRIBED notification resolves the user by
        // that id and hands the plan to the ABANDONED account while the one
        // that actually paid gets nothing.
        // An EXPIRED straggler must NOT wipe an existing revoked marker.
        // Apple retries an unacknowledged notification for up to three days, so
        // the order can be: EXPIRED generated → delivery fails → user
        // re-subscribes (same originalTransactionId) → refund → REFUND lands and
        // stamps the marker → the old EXPIRED finally arrives. Nulling both
        // fields there would delete the marker AND unbind the transaction,
        // after which the saved pre-refund receipt replays cleanly from any
        // account. Revoked rows therefore keep their binding and marker; only
        // the plan is downgraded.
        const alreadyRevoked = isRevokedMarker(user.applePurchaseSource);
        const downgrade = { plan: 'free', planExpiresAt: null };

        // INVARIANT 8 — a terminal notification for a SUPERSEDED term must not
        // tear down a newer entitlement.
        //
        // Sequence: the subscription lapses, EXPIRED is generated, delivery
        // fails, the user re-subscribes (Apple reuses originalTransactionId),
        // and the old EXPIRED finally lands. It downgraded the live paid
        // subscription AND nulled the binding — and because this handler
        // resolves the user BY that binding, no future DID_RENEW could find
        // them again, so it never self-healed.
        //
        // REFUND/REVOKE are exempt: those are authoritative about the
        // transaction regardless of which term they name.
        const incomingExpiryMs = expiresDate ? expiresDate.getTime() : null;
        const heldExpiryMs = user.planExpiresAt ? new Date(user.planExpiresAt).getTime() : null;
        if (!revoked && heldExpiryMs !== null && incomingExpiryMs !== null && heldExpiryMs > incomingExpiryMs) {
          console.warn(
            `[Apple IAP] ignoring stale ${notificationType} for user ${user.id} — it terminates a term older than the current entitlement`,
          );
          break;
        }

        // INVARIANT 7 — predicated write (see the renewal branch above). A
        // concurrent REFUND committing its marker between our read and this
        // write must not be erased by our stale `alreadyRevoked === false`.
        const terminalWrite = await prisma.user.updateMany({
          where: { id: user.id, applePurchaseSource: user.applePurchaseSource ?? null },
          data: revoked
            ? { ...downgrade, applePurchaseSource: markRevoked(txn.revocationDate) }
            : alreadyRevoked
              ? downgrade // keep the binding and the marker
              : { ...downgrade, appleOriginalTransactionId: null, applePurchaseSource: null },
        });
        if (terminalWrite.count === 0) {
          console.warn(
            `[Apple IAP] ${notificationType} for user ${user.id} skipped — row changed concurrently since it was read`,
          );
          break;
        }
        const bindingNote = revoked
          ? ', transaction marked revoked'
          : alreadyRevoked ? ', revoked binding preserved' : ', binding released';
        console.log(`[Apple IAP] Downgraded user ${user.id} to free (${notificationType}${bindingNote})`);
        break;
      }

      case 'DID_CHANGE_RENEWAL_INFO': {
        // User changed their auto-renew preferences - log but no action needed.
        console.log(`[Apple IAP] User ${user.id} changed renewal info`);
        break;
      }

      default:
        console.log(`[Apple IAP] Unhandled notification type: ${notificationType}`);
    }
  } catch (err) {
    // Allow retries by removing idempotency marker when processing fails mid-flight.
    await prisma.appleIAPWebhookEvent.deleteMany({
      where: { notificationId: notificationUUID },
    }).catch(() => {});
    throw err;
  }
}
