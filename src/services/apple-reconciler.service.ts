import {
  claimReconciliationJob,
  completeReconciliation,
  failReconciliation,
  releaseReconciliation,
  type AppleEnvironment,
  type ClaimedJob,
  type QueueClient,
} from './apple-reconciliation-queue.service';
import {
  APPLE_STATUS,
  AppleInvalidResponseError,
  AppleRateLimitError,
  AppleTransientError,
  type AppleStatusEntry,
  type AppleStatusResponse,
  type AppleTransport,
} from './apple-server-api';
import { getAppleRateLimiter } from './apple-rate-limiter';

/**
 * The reconciler: claim work, ask Apple for CURRENT state, and persist an
 * authoritative snapshot — but only if the queue still says we are allowed to.
 *
 * THE RULE THIS MODULE IS BUILT AROUND
 *
 *   A successful HTTP call earns nothing. Apple answering 200 says the response
 *   is current as of Apple's view; it says nothing about whether OUR work is
 *   still the newest, or whether we still hold the lease. The generation +
 *   fencing CAS from the queue remains the sole authority for whether a fetched
 *   snapshot may commit. That is why the snapshot write happens inside
 *   completeReconciliation's callback and nowhere else.
 *
 * Nothing starts this in production. APPLE_IAP_ENABLED remains false, no worker
 * loop is registered, and no entitlement projection onto User happens here — this
 * writes AppleSubscription only.
 */

export type ReconcileOutcome =
  | { kind: 'idle' }
  | { kind: 'committed'; job: ClaimedJob }
  | { kind: 'stale'; job: ClaimedJob; observed?: string }
  | { kind: 'rate-limited'; job: ClaimedJob; retryAfterMs: number }
  | { kind: 'transient'; job: ClaimedJob; error: string }
  | { kind: 'invalid'; job: ClaimedJob; error: string }
  | { kind: 'deferred'; environment: AppleEnvironment; waitMs: number };

export interface ReconcilerDeps {
  transport: AppleTransport;
  client?: QueueClient;
  now?: () => Date;
  /** Fallback when a 429 carries no usable Retry-After. Conservative on purpose. */
  rateLimitFallbackMs?: number;
  nowFnForLimiter?: () => number;
}

export const DEFAULT_RATE_LIMIT_FALLBACK_MS = 60_000;

/** Apple status code -> our persisted status. */
export function mapAppleStatus(status: number): string {
  switch (status) {
    case APPLE_STATUS.ACTIVE: return 'active';
    case APPLE_STATUS.EXPIRED: return 'expired';
    case APPLE_STATUS.BILLING_RETRY: return 'billing_retry';
    case APPLE_STATUS.GRACE: return 'grace';
    case APPLE_STATUS.REVOKED: return 'revoked';
    default: throw new AppleInvalidResponseError(`unknown apple status ${status}`);
  }
}

/**
 * Pick the entry this job is about.
 *
 * A response may carry several subscription groups, and a group several
 * transactions. Selection is deterministic and by IDENTITY, not by position:
 * match the originalTransactionId we asked about. Falling back to "the first
 * one" would silently reconcile the wrong subscription when a customer holds
 * more than one.
 */
export function selectEntry(
  response: AppleStatusResponse,
  originalTransactionId: string,
): AppleStatusEntry {
  const matches: AppleStatusEntry[] = [];
  for (const group of [...response.data].sort((a, b) =>
    a.subscriptionGroupIdentifier.localeCompare(b.subscriptionGroupIdentifier))) {
    for (const entry of group.lastTransactions) {
      if (entry.originalTransactionId === originalTransactionId) matches.push(entry);
    }
  }
  if (matches.length === 0) {
    throw new AppleInvalidResponseError(
      `apple response contains no entry for originalTransactionId ${originalTransactionId}`,
    );
  }
  // Deterministic tie-break if Apple ever returns the same id twice: newest
  // signed transaction wins, then transactionId for total ordering.
  matches.sort((a, b) => {
    const d = (b.transaction.signedDate ?? 0) - (a.transaction.signedDate ?? 0);
    return d !== 0 ? d : a.transaction.transactionId.localeCompare(b.transaction.transactionId);
  });
  return matches[0];
}

export interface Snapshot {
  environment: AppleEnvironment;
  originalTransactionId: string;
  productId: string;
  subscriptionGroupId: string | null;
  status: string;
  expiresAt: string | null;
  gracePeriodExpiresAt: string | null;
  autoRenewStatus: number | null;
  autoRenewProductId: string | null;
  appAccountToken: string | null;
  currentTransactionId: string;
}

/**
 * Build the snapshot. Pure: no I/O, no writes. Rejects a response describing a
 * different environment than the one requested — a Sandbox answer must never
 * back a Production row (frozen design failure mode H).
 */
export function buildSnapshot(
  requested: AppleEnvironment,
  originalTransactionId: string,
  response: AppleStatusResponse,
  groupId: string | null,
): Snapshot {
  if (response.environment !== requested) {
    throw new AppleInvalidResponseError(
      `apple returned environment ${response.environment} for a ${requested} request`,
    );
  }
  const entry = selectEntry(response, originalTransactionId);
  const t = entry.transaction;
  const r = entry.renewal;
  if (!t?.transactionId || !t?.productId) {
    throw new AppleInvalidResponseError('apple transaction missing transactionId or productId');
  }
  if (t.environment && t.environment !== requested) {
    throw new AppleInvalidResponseError(
      `apple transaction environment ${t.environment} does not match ${requested}`,
    );
  }
  return {
    environment: requested,
    originalTransactionId,
    productId: t.productId,
    subscriptionGroupId: groupId,
    status: mapAppleStatus(entry.status),
    expiresAt: t.expiresDate ? new Date(t.expiresDate).toISOString() : null,
    gracePeriodExpiresAt: r?.gracePeriodExpiresDate
      ? new Date(r.gracePeriodExpiresDate).toISOString() : null,
    autoRenewStatus: r?.autoRenewStatus ?? null,
    autoRenewProductId: r?.autoRenewProductId ?? null,
    appAccountToken: t.appAccountToken ?? null,
    currentTransactionId: t.transactionId,
  };
}

/**
 * Upsert the authoritative snapshot. Runs INSIDE completeReconciliation's
 * transaction, after the CAS has already proven this work may commit.
 *
 * `plan` intentionally mirrors productId for now: mapping product -> plan and
 * projecting entitlement onto User belong to the projection stage, which this PR
 * does not implement. Nothing here writes User.
 */
export const SNAPSHOT_UPSERT_SQL = `
INSERT INTO "AppleSubscription" (
  "id", "environment", "originalTransactionId", "productId", "subscriptionGroupId",
  "plan", "status", "expiresAt", "gracePeriodExpiresAt", "autoRenewStatus",
  "autoRenewProductId", "appAccountToken", "currentTransactionId",
  "appliedGeneration", "lastReconciledAt", "createdAt", "updatedAt"
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT ("environment", "originalTransactionId") DO UPDATE SET
  "productId"            = excluded."productId",
  "subscriptionGroupId"  = excluded."subscriptionGroupId",
  "plan"                 = excluded."plan",
  "status"               = excluded."status",
  "expiresAt"            = excluded."expiresAt",
  "gracePeriodExpiresAt" = excluded."gracePeriodExpiresAt",
  "autoRenewStatus"      = excluded."autoRenewStatus",
  "autoRenewProductId"   = excluded."autoRenewProductId",
  "appAccountToken"      = excluded."appAccountToken",
  "currentTransactionId" = excluded."currentTransactionId",
  "appliedGeneration"    = excluded."appliedGeneration",
  "lastReconciledAt"     = excluded."lastReconciledAt",
  "updatedAt"            = excluded."updatedAt"
`.trim();

export async function writeSnapshot(
  tx: QueueClient,
  snapshot: Snapshot,
  appliedGeneration: number,
  now: Date,
): Promise<void> {
  const iso = now.toISOString();
  await tx.$executeRawUnsafe(
    SNAPSHOT_UPSERT_SQL,
    globalThis.crypto.randomUUID(),
    snapshot.environment,
    snapshot.originalTransactionId,
    snapshot.productId,
    snapshot.subscriptionGroupId,
    snapshot.productId, // plan — see comment above
    snapshot.status,
    snapshot.expiresAt,
    snapshot.gracePeriodExpiresAt,
    snapshot.autoRenewStatus,
    snapshot.autoRenewProductId,
    snapshot.appAccountToken,
    snapshot.currentTransactionId,
    appliedGeneration,
    iso,
    iso,
    iso,
  );
}

/**
 * One reconciliation pass. Claims at most one job.
 *
 * Ordering matters: the rate limiter is consulted BEFORE the job is claimed is
 * NOT what happens — we claim first, then check the limiter, and if no token is
 * available we RELEASE the job rather than sleeping while holding a lease. A
 * worker blocking on a token with a lease in hand is a worker that looks alive
 * while doing nothing, and blocks reclaim.
 */
export async function reconcileOnce(
  workerId: string,
  deps: ReconcilerDeps,
): Promise<ReconcileOutcome> {
  const nowFn = deps.now ?? (() => new Date());
  const client = deps.client;

  const job = await claimReconciliationJob(workerId, { client, now: nowFn() });
  if (!job) return { kind: 'idle' };

  const limiter = getAppleRateLimiter(job.environment, deps.nowFnForLimiter);
  if (!limiter.tryAcquire()) {
    const waitMs = limiter.msUntilNextToken();
    // Hand the lease back immediately — do not hold it while waiting.
    await releaseReconciliation(job, { now: nowFn(), client });
    return { kind: 'deferred', environment: job.environment, waitMs };
  }

  let response: AppleStatusResponse;
  try {
    response = await deps.transport.getAllSubscriptionStatuses({
      environment: job.environment,
      originalTransactionId: job.originalTransactionId,
    });
  } catch (err) {
    if (err instanceof AppleRateLimitError) {
      const retryAfterMs = err.retryAfterMs ?? (deps.rateLimitFallbackMs ?? DEFAULT_RATE_LIMIT_FALLBACK_MS);
      await failReconciliation(job, `apple 429`, { now: nowFn(), client, retryAfterMs });
      return { kind: 'rate-limited', job, retryAfterMs };
    }
    if (err instanceof AppleTransientError) {
      await failReconciliation(job, err.message, { now: nowFn(), client });
      return { kind: 'transient', job, error: err.message };
    }
    if (err instanceof AppleInvalidResponseError) {
      await failReconciliation(job, err.message, { now: nowFn(), client });
      return { kind: 'invalid', job, error: err.message };
    }
    await failReconciliation(job, err instanceof Error ? err.message : String(err), { now: nowFn(), client });
    return { kind: 'transient', job, error: String(err) };
  }

  // A response that cannot be trusted must never reach the snapshot write, even
  // though the HTTP call succeeded.
  let snapshot: Snapshot;
  try {
    const groupId = response.data.find((g) =>
      g.lastTransactions.some((t) => t.originalTransactionId === job.originalTransactionId),
    )?.subscriptionGroupIdentifier ?? null;
    snapshot = buildSnapshot(job.environment, job.originalTransactionId, response, groupId || null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failReconciliation(job, message, { now: nowFn(), client });
    return { kind: 'invalid', job, error: message };
  }

  // THE AUTHORITY CHECK. Apple said 200 and the snapshot is well-formed, but the
  // queue decides whether this work may still commit.
  const result = await completeReconciliation(
    job,
    async (tx) => { await writeSnapshot(tx, snapshot, job.generation, nowFn()); },
    { now: nowFn(), client },
  );

  return result.committed
    ? { kind: 'committed', job }
    : { kind: 'stale', job, observed: result.observed };
}
