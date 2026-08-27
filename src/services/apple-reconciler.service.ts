import { Status } from '@apple/app-store-server-library';
import {
  claimReconciliationJob,
  completeReconciliation,
  failReconciliation,
  deferReconciliation,
  PERMANENT_PARK_MS,
  type AppleEnvironment,
  type ClaimedJob,
  type QueueClient,
} from './apple-reconciliation-queue.service';
import {
  AppleInvalidResponseError,
  AppleRateLimitError,
  AppleTransientError,
  type AppleStatusEntry,
  type AppleStatusResponse,
  type AppleTransport,
} from './apple-server-api';
import { getAppleRateLimiter, applyAppleRateLimitCooldown } from './apple-rate-limiter';
import { planForAppleProduct, UnknownAppleProductError } from './apple-product-plan';
import {
  projectAppleEntitlementForUser,
  resolveProjectionEnvironment,
  parseSandboxProjectionPolicy,
  BillingRailConflictError,
  AppleProjectionDataError,
  type SandboxProjectionPolicy,
} from './apple-entitlement-projection.service';
import {
  bindSubscriptionOwner,
  AppleOwnershipConflictError,
} from './apple-ownership.service';
import { AppleVerificationPermanentError, AppleVerificationTransientError } from './apple-verifier';

/**
 * The reconciler: claim work, ask Apple for CURRENT state, persist an
 * authoritative snapshot — but only if the queue still says we may.
 *
 * THE RULE THIS MODULE IS BUILT AROUND
 *
 *   A successful HTTP call earns nothing. Apple answering 200 says the response
 *   is current as of Apple's view; it says nothing about whether OUR work is
 *   still newest, or whether we still hold the lease. The generation + fencing
 *   CAS from the queue remains the sole authority for whether a fetched snapshot
 *   may commit. That is why the snapshot write happens inside
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
  | { kind: 'persistence-failed'; job: ClaimedJob; error: string }
  | { kind: 'permanently-invalid'; job: ClaimedJob; error: string }
  | { kind: 'deferred'; environment: AppleEnvironment; waitMs: number };

export interface ReconcilerDeps {
  transport: AppleTransport;
  client?: QueueClient;
  now?: () => Date;
  /**
   * Called immediately after a job is claimed, before the Apple request.
   * Observability only — it exists so a worker can report a STUCK request rather
   * than reporting null for the whole time an operator cares about.
   */
  onJobClaimed?: (job: ClaimedJob) => void;
  /** Fallback when a 429 carries no usable Retry-After. Conservative on purpose. */
  rateLimitFallbackMs?: number;
  /**
   * Sandbox projection permission. Omitted in production, where it is read
   * from the process environment and therefore defaults to "nobody". Tests
   * inject it rather than mutating process.env so one suite cannot leak
   * permission into another.
   */
  sandboxProjection?: SandboxProjectionPolicy;
}

export const DEFAULT_RATE_LIMIT_FALLBACK_MS = 60_000;

/** Apple status -> persisted status, via the library enum rather than literals. */
export function mapAppleStatus(status: number): string {
  switch (status) {
    case Status.ACTIVE: return 'active';
    case Status.EXPIRED: return 'expired';
    case Status.BILLING_RETRY: return 'billing_retry';
    case Status.BILLING_GRACE_PERIOD: return 'grace';
    case Status.REVOKED: return 'revoked';
    default: throw new AppleInvalidResponseError(`unknown apple status ${status}`);
  }
}

export interface SelectedEntry {
  /** From the UNSIGNED envelope. Cross-checked, never persisted on its own. */
  outerGroup: string | null;
  entry: AppleStatusEntry;
}

/**
 * Select the entry this job is about, using the VERIFIED identity only.
 *
 * There is deliberately NO ordering between distinct transactions. The frozen
 * design forbids cross-transaction signedDate comparison, and picking "the
 * newest" or "the lowest id" among genuinely different transactions would be
 * inventing an authority Apple does not grant. So:
 *
 *   0 matches  -> invalid
 *   1 match    -> selected
 *   2+ matches -> ambiguous, therefore invalid
 *
 * Multiple matches are refused even when their transactionIds agree. Equal
 * transactionIds do not make two entries LITERAL duplicates: status, group and
 * renewal data can still differ, and collapsing them by taking matches[0] would
 * quietly restore authority-by-array-position — the thing removing signedDate
 * ordering was meant to eliminate. Proving field-by-field equivalence would be
 * the only safe way to tolerate them, and nothing needs that today.
 */
export function selectEntry(
  response: AppleStatusResponse,
  originalTransactionId: string,
): SelectedEntry {
  const matches: SelectedEntry[] = [];
  for (const group of response.data) {
    for (const entry of group.lastTransactions) {
      // Identity comes from the signed payload, never the envelope.
      if (entry.transaction?.originalTransactionId === originalTransactionId) {
        matches.push({ outerGroup: group.subscriptionGroupIdentifier || null, entry });
      }
    }
  }
  if (matches.length === 0) {
    throw new AppleInvalidResponseError(
      `apple response contains no verified entry for originalTransactionId ${originalTransactionId}`,
    );
  }
  if (matches.length > 1) {
    throw new AppleInvalidResponseError(
      `apple response is ambiguous for ${originalTransactionId}: ${matches.length} matching entries`,
    );
  }
  return matches[0];
}

/**
 * Assert the response is internally consistent and about what we asked.
 *
 * Every identifier that can disagree is checked against the REQUESTED value:
 * the unsigned envelope id, the verified transaction id, and the verified
 * renewal id. The envelope is not signed, so if it disagrees with the signed
 * payload something is wrong and nothing may be written — we do not silently
 * prefer one over the other.
 */
function assertConsistent(
  requestedEnv: AppleEnvironment,
  requestedOti: string,
  response: AppleStatusResponse,
  entry: AppleStatusEntry,
  outerGroup: string | null,
): void {
  if (response.environment !== requestedEnv) {
    throw new AppleInvalidResponseError(
      `apple returned environment ${response.environment} for a ${requestedEnv} request`,
    );
  }
  const t = entry.transaction;
  const r = entry.renewal;

  if (entry.outerOriginalTransactionId != null && entry.outerOriginalTransactionId !== requestedOti) {
    throw new AppleInvalidResponseError(
      `apple envelope originalTransactionId ${entry.outerOriginalTransactionId} does not match requested ${requestedOti}`,
    );
  }
  if (t?.originalTransactionId !== requestedOti) {
    throw new AppleInvalidResponseError(
      `verified transaction originalTransactionId ${t?.originalTransactionId} does not match requested ${requestedOti}`,
    );
  }
  if (r?.originalTransactionId != null && r.originalTransactionId !== requestedOti) {
    throw new AppleInvalidResponseError(
      `verified renewal originalTransactionId ${r.originalTransactionId} does not match requested ${requestedOti}`,
    );
  }
  if (t?.environment && t.environment !== requestedEnv) {
    throw new AppleInvalidResponseError(
      `verified transaction environment ${t.environment} does not match ${requestedEnv}`,
    );
  }
  if (r?.environment && r.environment !== requestedEnv) {
    throw new AppleInvalidResponseError(
      `verified renewal environment ${r.environment} does not match ${requestedEnv}`,
    );
  }
  if (!t?.transactionId || !t?.productId) {
    throw new AppleInvalidResponseError('verified transaction missing transactionId or productId');
  }
  /**
   * The subscription group has exactly the same problem originalTransactionId
   * had: the envelope's copy is unsigned. Apple's signed transaction carries it
   * too, so when both are present they must agree, and we persist the VERIFIED
   * one. Failing closed here rather than preferring one silently — a disagreement
   * means the response cannot be trusted about which group this belongs to.
   */
  if (t.subscriptionGroupIdentifier && outerGroup && t.subscriptionGroupIdentifier !== outerGroup) {
    throw new AppleInvalidResponseError(
      `apple envelope subscription group ${outerGroup} does not match verified ${t.subscriptionGroupIdentifier}`,
    );
  }
}

export interface Snapshot {
  environment: AppleEnvironment;
  originalTransactionId: string;
  productId: string;
  subscriptionGroupId: string | null;
  plan: string;
  status: string;
  expiresAt: string | null;
  gracePeriodExpiresAt: string | null;
  autoRenewStatus: number | null;
  autoRenewProductId: string | null;
  appAccountToken: string | null;
  currentTransactionId: string;
}

/** Pure: no I/O, no writes. Throws AppleInvalidResponseError on anything untrusted. */
export function buildSnapshot(
  requested: AppleEnvironment,
  originalTransactionId: string,
  response: AppleStatusResponse,
): Snapshot {
  const { outerGroup, entry } = selectEntry(response, originalTransactionId);
  assertConsistent(requested, originalTransactionId, response, entry, outerGroup);

  const t = entry.transaction;
  const r = entry.renewal;
  let plan: string;
  try {
    plan = planForAppleProduct(t.productId);
  } catch (err) {
    // An unrecognised product must fail reconciliation, never normalize to free.
    if (err instanceof UnknownAppleProductError) throw new AppleInvalidResponseError(err.message);
    throw err;
  }

  return {
    environment: requested,
    originalTransactionId,
    productId: t.productId,
    // Verified value wins; the envelope only fills in when Apple omitted it from
    // the signed payload, and assertConsistent has already proven they agree.
    subscriptionGroupId: t.subscriptionGroupIdentifier ?? outerGroup,
    plan,
    status: mapAppleStatus(entry.status),
    expiresAt: t.expiresDate ? new Date(t.expiresDate).toISOString() : null,
    gracePeriodExpiresAt: r?.gracePeriodExpiresDate ? new Date(r.gracePeriodExpiresDate).toISOString() : null,
    autoRenewStatus: r?.autoRenewStatus ?? null,
    autoRenewProductId: r?.autoRenewProductId ?? null,
    appAccountToken: t.appAccountToken ?? null,
    currentTransactionId: t.transactionId,
  };
}

/**
 * Upsert the authoritative snapshot. Runs INSIDE completeReconciliation's
 * transaction, after the CAS has proven this work may commit.
 *
 * Writes AppleSubscription only. Entitlement projection onto User is a later
 * stage and does not happen here.
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
    snapshot.plan,
    snapshot.status,
    snapshot.expiresAt,
    snapshot.gracePeriodExpiresAt,
    snapshot.autoRenewStatus,
    snapshot.autoRenewProductId,
    snapshot.appAccountToken,
    snapshot.currentTransactionId,
    appliedGeneration,
    iso, iso, iso,
  );
}

/**
 * One reconciliation pass. Claims at most one job.
 *
 * The limiter is consulted AFTER the claim, and a worker with no token releases
 * the job rather than sleeping on it: a worker blocking on a token while holding
 * a lease looks alive while doing nothing, and blocks reclaim. The release
 * carries a due time so sustained pressure does not become a claim/release loop.
 */
export async function reconcileOnce(
  workerId: string,
  deps: ReconcilerDeps,
): Promise<ReconcileOutcome> {
  const nowFn = deps.now ?? (() => new Date());
  const client = deps.client;
  const sandboxPolicy = deps.sandboxProjection ?? parseSandboxProjectionPolicy(process.env);

  const job = await claimReconciliationJob(workerId, { client, now: nowFn() });
  if (!job) return { kind: 'idle' };
  deps.onJobClaimed?.(job);

  const limiter = getAppleRateLimiter(job.environment);
  if (!limiter.tryAcquire()) {
    const waitMs = Math.max(limiter.msUntilNextToken(), 0);
    const now = nowFn();
    // Generation-aware: a notification may have arrived while we held the lease,
    // and a stale worker must not park brand-new work behind a cooldown.
    await deferReconciliation(job, new Date(now.getTime() + waitMs), { now, client });
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
      const now = nowFn();
      const retryAfterMs = err.retryAfterMs ?? (deps.rateLimitFallbackMs ?? DEFAULT_RATE_LIMIT_FALLBACK_MS);
      // Hold off the WHOLE environment, not just this row: parking one job leaves
      // every other worker free to keep hitting a limit Apple already refused.
      applyAppleRateLimitCooldown(job.environment, now.getTime() + retryAfterMs);
      await failReconciliation(job, 'apple 429', { now, client, retryAfterMs });
      return { kind: 'rate-limited', job, retryAfterMs };
    }
    const message = err instanceof Error ? err.message : String(err);

    /**
     * A verification failure that is permanent must NOT retry forever: the
     * signature, bundle or environment will not change by waiting. It is parked
     * instead, and a new Apple notification revives it through intake.
     *
     * A verification failure that could not COMPLETE (OCSP unreachable and the
     * like) says nothing about the payload, so it takes ordinary backoff.
     */
    if (err instanceof AppleVerificationPermanentError) {
      await failReconciliation(job, message, { now: nowFn(), client, retryAfterMs: PERMANENT_PARK_MS });
      return { kind: 'permanently-invalid', job, error: message };
    }
    if (err instanceof AppleVerificationTransientError) {
      await failReconciliation(job, message, { now: nowFn(), client });
      return { kind: 'transient', job, error: message };
    }

    const transient = err instanceof AppleTransientError;
    const invalid = err instanceof AppleInvalidResponseError;
    await failReconciliation(job, message, { now: nowFn(), client });
    return invalid ? { kind: 'invalid', job, error: message } : { kind: 'transient', job, error: transient ? message : String(err) };
  }

  // A response that cannot be trusted must never reach the snapshot write, even
  // though the HTTP call succeeded.
  let snapshot: Snapshot;
  try {
    snapshot = buildSnapshot(job.environment, job.originalTransactionId, response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failReconciliation(job, message, { now: nowFn(), client });
    return { kind: 'invalid', job, error: message };
  }

  // THE AUTHORITY CHECK. Apple said 200 and the snapshot is well-formed, but the
  // queue decides whether this work may still commit.
  try {
    /**
     * ONE captured instant for the whole commit: the CAS stamp, the snapshot
     * and every entitlement predicate. Calling nowFn() separately per step
     * would let an expiry sit on one side of "now" for the snapshot and the
     * other side for the projection.
     */
    const commitNow = nowFn();
    const result = await completeReconciliation(
      job,
      async (tx) => {
        await writeSnapshot(tx, snapshot, job.generation, commitNow);

        /**
         * Ownership binding, in the SAME transaction as the snapshot and behind
         * the same generation fence.
         *
         * This is where a purchase becomes a customer’s. It is derived from the
         * AUTHORITATIVE snapshot Apple’s Server API just returned — the token
         * Apple echoed back — never from anything a client submitted. A stale
         * generation loses the CAS above and cannot bind; a worker that lost its
         * lease cannot bind; and a projection failure below rolls a fresh binding
         * back with it.
         *
         * Sandbox DOES bind, so a test purchase is attributable and auditable.
         * Binding is NOT permission to project — see the projection gate below.
         */
        const binding = await bindSubscriptionOwner(
          tx,
          {
            environment: snapshot.environment,
            originalTransactionId: snapshot.originalTransactionId,
          },
          commitNow,
        );

        /**
         * Projection gate.
         *
         * Production always projects, exactly as before. Sandbox projects ONLY
         * for a user named in the server-side allowlist while the server-side
         * flag is on — nothing in the snapshot, the token or the request can
         * reach this decision.
         *
         * The resolved environment is then what the projection READS FROM, so a
         * QA account holding both Production and Sandbox rows never mixes them:
         * a Sandbox pass sees only Sandbox facts and a Production pass only
         * Production facts.
         *
         * Gating here rather than inside the projection is what keeps grant and
         * downgrade symmetric. An unallowlisted Sandbox reconciliation performs
         * NO projection at all, so it can neither hand out a plan nor take one
         * away — there is no half-gated path where Sandbox may grant but not
         * downgrade.
         */
        const projectionEnvironment = resolveProjectionEnvironment(
          snapshot.environment, binding.userId, sandboxPolicy,
        );
        if (!projectionEnvironment || !binding.userId) return;
        await projectAppleEntitlementForUser(tx, binding.userId, commitNow, projectionEnvironment);
      },
      { now: commitNow, client },
    );
    return result.committed
      ? { kind: 'committed', job }
      : { kind: 'stale', job, observed: result.observed };
  } catch (err) {
    /**
     * The snapshot write itself failed and completeReconciliation rolled the CAS
     * back with it, keeping our lease. This is NOT an invalid response — Apple's
     * answer was fine; our database was not. SQLITE_BUSY on a contended volume
     * is the live example, and this repo has seen exactly that.
     *
     * So it goes through the normal failure machinery: attemptCount, backoff,
     * lastError, lease released. Releasing due-now instead would let the next
     * loop reclaim immediately and hammer the very database that is struggling.
     */
    const message = err instanceof Error ? err.message : String(err);

    /**
     * A billing-rail conflict, or corrupt persisted Apple state, is not a
     * transient database problem and will not fix itself on the next attempt.
     * Retrying it on the normal ladder would hammer the queue every few
     * seconds forever. Park it durably instead; the existing parked-job
     * recovery requeues it once an operator has resolved the underlying
     * double rail or bad row.
     */
    if (
      err instanceof BillingRailConflictError
      || err instanceof AppleProjectionDataError
      || err instanceof AppleOwnershipConflictError
    ) {
      await failReconciliation(job, `projection blocked: ${message}`, {
        now: nowFn(), client, retryAfterMs: PERMANENT_PARK_MS,
      });
      return { kind: 'permanently-invalid', job, error: message };
    }

    await failReconciliation(job, `snapshot persistence failed: ${message}`, { now: nowFn(), client });
    return { kind: 'persistence-failed', job, error: message };
  }
}
