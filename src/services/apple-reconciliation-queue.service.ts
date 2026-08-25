import prisma from '../utils/prisma';

/**
 * Durable reconciliation queue — generation and lease primitives.
 *
 * Implements the queue half of docs/apple-authoritative-state-design-2026-08-24.md
 * (FROZEN). This module deliberately contains NO Apple API calls, NO entitlement
 * projection and NO webhook handling; it is the concurrency substrate those will
 * later sit on.
 *
 * THE INVARIANT THIS MODULE EXISTS TO ENFORCE
 *
 *   For a given (environment, originalTransactionId), no worker may commit work
 *   for generation G if a newer generation exists, or if that worker no longer
 *   owns the lease.
 *
 * WHY THE SHAPE OF THIS API IS WHAT IT IS
 *
 * Every state transition below is a SINGLE SQL statement whose WHERE clause (or
 * CASE expression) carries the precondition. None of them read a value, await,
 * and then write it back — that pattern is how the payout path lost updates
 * (finding F-3), and it is the failure mode this queue is most likely to
 * reintroduce.
 *
 * `completeReconciliation` takes the snapshot write as a CALLBACK rather than
 * returning "you may now write". The PUBLIC SERVICE API therefore exposes no
 * standalone completion operation: a caller cannot mark the job done in one
 * transaction and write the snapshot in another. A crash between those two
 * commits would otherwise leave a subscription permanently unreconciled at a
 * generation the CAS can never accept again — invisible to schema-level testing,
 * and unrecoverable without manual repair.
 *
 * (The raw CAS statement is exported under a __TEST_ONLY_ name so the
 * real-engine test can exercise the exact SQL. That is a testing seam, not a
 * supported way to complete a job, and it is the reason this comment says "the
 * public API does not expose" rather than the stronger claim that the unsafe
 * split is unrepresentable.)
 */

/** Column domains, mirrored from the DB CHECK constraints. */
export const RECONCILE_STATES = ['pending', 'running', 'failed', 'done'] as const;
export type ReconcileState = (typeof RECONCILE_STATES)[number];

export const APPLE_ENVIRONMENTS = ['Production', 'Sandbox'] as const;
export type AppleEnvironment = (typeof APPLE_ENVIRONMENTS)[number];

export interface QueueKey {
  environment: AppleEnvironment;
  originalTransactionId: string;
}

/**
 * The seam that lets the real-engine test drive the PRODUCTION claim path
 * against an in-memory database instead of re-implementing it.
 *
 * It is deliberately two raw methods that PrismaClient already satisfies, rather
 * than a mock of the Prisma query API: the point of the integration test is that
 * the statements the service actually issues are the ones under test.
 */
export interface QueueClient {
  $executeRawUnsafe(sql: string, ...args: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(sql: string, ...args: unknown[]): Promise<T[]>;
  /**
   * Interactive transaction. Required by completeReconciliation, which must bind
   * the CAS and the snapshot write into one commit — the whole reason that
   * function takes a callback.
   */
  $transaction<T>(fn: (tx: QueueClient) => Promise<T>): Promise<T>;
}

/** PrismaClient satisfies QueueClient structurally; this narrows the overloads. */
function asQueueClient(p: typeof prisma): QueueClient {
  return p as unknown as QueueClient;
}

/** Default lease length. A worker that dies holding one is reclaimable after this. */
export const DEFAULT_LEASE_MS = 2 * 60 * 1000;

/**
 * Retry backoff by attempt number. Index 0 is unused: a failure always produces
 * at least attempt 1. Evaluated in SQL against the row's CURRENT attemptCount,
 * never against a value the worker captured before its await.
 */
const BACKOFF_MS = [0, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
export function backoffForAttempt(attemptCount: number): number {
  return BACKOFF_MS[Math.min(Math.max(attemptCount, 0), BACKOFF_MS.length - 1)];
}

/**
 * INTAKE — atomically create-or-advance the work item.
 *
 * One statement. SQLite's UPSERT increments in place, so two concurrent intakes
 * cannot lose an increment and cannot create a duplicate row.
 *
 * It never resets targetGeneration: the counter is monotonic per subscription for
 * the lifetime of the row, which is why these rows are never deleted — recycling
 * the numbering would let a stale in-flight worker's CAS match a fresh generation.
 *
 * It does not knock a 'running' job back to 'pending'. Doing so would let a second
 * worker claim while the first is still calling a rate-limited Apple endpoint. The
 * in-flight worker releases the job itself once its CAS fails.
 */
export const __TEST_ONLY_ENQUEUE_SQL = `
INSERT INTO "AppleReconciliation" (
  "id", "environment", "originalTransactionId", "targetGeneration",
  "reconcileState", "attemptCount", "nextAttemptAt", "createdAt", "updatedAt"
) VALUES (?, ?, ?, 1, 'pending', 0, ?, ?, ?)
ON CONFLICT ("environment", "originalTransactionId") DO UPDATE SET
  "targetGeneration" = "AppleReconciliation"."targetGeneration" + 1,
  "reconcileState"   = CASE WHEN "AppleReconciliation"."reconcileState" = 'running'
                            THEN 'running' ELSE 'pending' END,
  "attemptCount"     = 0,
  "nextAttemptAt"    = excluded."nextAttemptAt",
  "lastError"        = NULL,
  "updatedAt"        = excluded."updatedAt"
`.trim();

export async function enqueueReconciliation(
  key: QueueKey,
  client: { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number> } = prisma,
  now: Date = new Date(),
): Promise<void> {
  const iso = now.toISOString();
  await client.$executeRawUnsafe(
    __TEST_ONLY_ENQUEUE_SQL,
    globalThis.crypto.randomUUID(),
    key.environment,
    key.originalTransactionId,
    iso, // nextAttemptAt — immediately eligible
    iso, // createdAt
    iso, // updatedAt
  );
}

/**
 * CLAIM — take the lease on one eligible job.
 *
 * Eligible means: due, and either not running, or running under a lease that has
 * expired. The precondition lives entirely in the WHERE clause, so two workers
 * racing produce one winner and one zero-row update.
 */
export const __TEST_ONLY_CLAIM_SQL = `
UPDATE "AppleReconciliation" SET
  "reconcileState"  = 'running',
  "leaseOwner"      = ?,
  "leaseExpiresAt"  = ?,
  "updatedAt"       = ?
WHERE "id" = ?
  AND "nextAttemptAt" <= ?
  AND "reconcileState" IN ('pending', 'failed', 'running')
  AND ("reconcileState" <> 'running' OR "leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ?)
`.trim();

export interface ClaimedJob {
  id: string;
  environment: AppleEnvironment;
  originalTransactionId: string;
  /** The generation this worker is responsible for. Captured AT CLAIM TIME. */
  generation: number;
  /**
   * FENCING TOKEN — unique to THIS acquisition, not to the worker.
   *
   * A worker identity is NOT sufficient. If the same identity reclaims a lease
   * it previously lost to expiry, a stalled request from the earlier lease would
   * still satisfy `leaseOwner = me` and could commit over the newer lease. The
   * token is minted per acquisition so the earlier lease's value can never match
   * again.
   */
  leaseToken: string;
  /** Human-facing worker identity, for logs. Never used by a CAS. */
  workerId: string;
  attemptCount: number;
}

/**
 * Mint a fencing token. The worker label is retained as a prefix purely so logs
 * and stuck-lease inspection stay readable; the uniqueness comes from the uuid.
 */
export function mintLeaseToken(workerId: string): string {
  return `${workerId}:${globalThis.crypto.randomUUID()}`;
}

export const __TEST_ONLY_CANDIDATES_SQL = `
SELECT "id" FROM "AppleReconciliation"
WHERE "nextAttemptAt" <= ?
  AND ( "reconcileState" IN ('pending', 'failed')
        OR ( "reconcileState" = 'running'
             AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ?) ) )
ORDER BY "nextAttemptAt" ASC
LIMIT ?
`.trim();

export const __TEST_ONLY_READBACK_SQL = `
SELECT "id", "environment", "originalTransactionId", "targetGeneration",
       "leaseOwner", "attemptCount"
FROM "AppleReconciliation" WHERE "id" = ?
`.trim();

export async function claimReconciliationJob(
  workerId: string,
  opts: { leaseMs?: number; now?: Date; limit?: number; client?: QueueClient } = {},
): Promise<ClaimedJob | null> {
  const db: QueueClient = opts.client ?? prisma;
  const now = opts.now ?? new Date();
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();

  const candidates = await db.$queryRawUnsafe<{ id: string }>(
    __TEST_ONLY_CANDIDATES_SQL, nowIso, nowIso, opts.limit ?? 10,
  );

  for (const { id } of candidates) {
    // Minted HERE, once per acquisition. A worker identity is not sufficient:
    // the same identity reclaiming a lease it lost to expiry would otherwise
    // present a value indistinguishable from the earlier lease's, letting stale
    // work commit over the newer one.
    const leaseToken = mintLeaseToken(workerId);
    const won = await db.$executeRawUnsafe(
      __TEST_ONLY_CLAIM_SQL, leaseToken, leaseUntil, nowIso, id, nowIso, nowIso,
    );
    if (won !== 1) continue; // someone else claimed it between SELECT and UPDATE

    const [row] = await db.$queryRawUnsafe<{
      id: string; environment: string; originalTransactionId: string;
      targetGeneration: number; leaseOwner: string | null; attemptCount: number;
    }>(__TEST_ONLY_READBACK_SQL, id);

    // Read back under our own token. If it is not ours, another worker took the
    // row in the interval and we must not treat it as claimed.
    if (!row || row.leaseOwner !== leaseToken) continue;

    return {
      id: row.id,
      environment: row.environment as AppleEnvironment,
      originalTransactionId: row.originalTransactionId,
      generation: Number(row.targetGeneration),
      leaseToken,
      workerId,
      attemptCount: Number(row.attemptCount),
    };
  }
  return null;
}

/**
 * The reason a completion was rejected is NOT distinguished by the CAS: one
 * statement tests generation, lease and state together, and a zero-row result
 * does not say which predicate missed. Reporting a specific cause here would be
 * telemetry we cannot substantiate, so the reason is simply 'stale'.
 *
 * `observed` is a best-effort post-hoc read for operators. It is diagnostic only
 * — it is taken AFTER the rollback, so it can itself be out of date, and nothing
 * may branch on it.
 */
export type StaleObservation = 'generation-advanced' | 'lease-lost' | 'not-running' | 'unknown';

export class StaleWorkError extends Error {
  constructor() {
    super('reconciliation work is stale');
    this.name = 'StaleWorkError';
  }
}

/**
 * The CAS. Both halves of the invariant are in the WHERE clause, so the engine
 * decides — no read, no await, no write-back of a previously observed value.
 *
 * Exported ONLY so the real-engine test exercises this exact statement. It is not
 * a supported completion path: using it directly reintroduces the split-commit
 * hazard the callback API exists to prevent.
 */
export const __TEST_ONLY_COMPLETE_CAS_SQL = `
UPDATE "AppleReconciliation" SET
  "reconcileState"  = 'done',
  "leaseOwner"      = NULL,
  "leaseExpiresAt"  = NULL,
  "lastError"       = NULL,
  "updatedAt"       = ?
WHERE "id" = ?
  AND "targetGeneration" = ?
  AND "leaseOwner" = ?
  AND "reconcileState" = 'running'
`.trim();

export async function completeReconciliation(
  job: Pick<ClaimedJob, 'id' | 'generation' | 'leaseToken'>,
  writeSnapshot: (tx: QueueClient) => Promise<void>,
  opts: { now?: Date; client?: QueueClient } = {},
): Promise<{ committed: boolean; observed?: StaleObservation }> {
  const db: QueueClient = opts.client ?? asQueueClient(prisma);
  const now = opts.now ?? new Date();
  try {
    await db.$transaction(async (tx) => {
      const won = await tx.$executeRawUnsafe(
        __TEST_ONLY_COMPLETE_CAS_SQL, now.toISOString(), job.id, job.generation, job.leaseToken,
      );
      if (won === 0) throw new StaleWorkError();

      // Same transaction. If this throws, the 'done' transition rolls back with
      // it and the job stays claimable — never one without the other.
      await writeSnapshot(tx);
    });
    return { committed: true };
  } catch (err) {
    if (err instanceof StaleWorkError) {
      const observed = await observeStaleCause(job, db);
      await releaseReconciliation(job, { now, client: db });
      return { committed: false, observed };
    }
    /**
     * A snapshot-write failure rolled the CAS back with it — nothing persisted.
     *
     * The lease is deliberately NOT released here. Releasing due-now turns a
     * persistent write problem (SQLITE_BUSY on a contended database is the live
     * example) into an immediate reclaim-and-retry loop against the very
     * resource that is struggling. The caller owns the recovery decision and
     * should route this through failReconciliation so the failure gets
     * attemptCount, backoff and lastError like any other.
     *
     * Keeping the lease is safe: if the process dies before the caller acts,
     * lease expiry makes the job reclaimable anyway.
     */
    throw err;
  }
}

/** Diagnostic only — see StaleObservation. Never used for a decision. */
async function observeStaleCause(
  job: Pick<ClaimedJob, 'id' | 'generation' | 'leaseToken'>,
  db: QueueClient,
): Promise<StaleObservation> {
  const [row] = await db.$queryRawUnsafe<{
    targetGeneration: number; leaseOwner: string | null; reconcileState: string;
  }>(`SELECT "targetGeneration", "leaseOwner", "reconcileState" FROM "AppleReconciliation" WHERE "id" = ?`, job.id);
  if (!row) return 'unknown';
  if (Number(row.targetGeneration) !== job.generation) return 'generation-advanced';
  if (row.leaseOwner !== job.leaseToken) return 'lease-lost';
  if (row.reconcileState !== 'running') return 'not-running';
  return 'unknown';
}

/**
 * Release a job this worker can no longer finish. Guarded on the fencing token,
 * so a worker whose lease was reclaimed cannot disturb the new owner.
 */
export const __TEST_ONLY_RELEASE_SQL = `
UPDATE "AppleReconciliation" SET
  "reconcileState"  = 'pending',
  "leaseOwner"      = NULL,
  "leaseExpiresAt"  = NULL,
  "nextAttemptAt"   = ?,
  "updatedAt"       = ?
WHERE "id" = ? AND "leaseOwner" = ?
`.trim();

/** Hand the job back, due immediately. Deliberately simple. */
export async function releaseReconciliation(
  job: Pick<ClaimedJob, 'id' | 'leaseToken'>,
  opts: { now?: Date; client?: QueueClient } = {},
): Promise<void> {
  const db: QueueClient = opts.client ?? asQueueClient(prisma);
  const iso = (opts.now ?? new Date()).toISOString();
  await db.$executeRawUnsafe(__TEST_ONLY_RELEASE_SQL, iso, iso, job.id, job.leaseToken);
}

/**
 * DEFER — hand the job back but keep it out of the claim pool until `dueAt`.
 *
 * Used when the shared rate limiter has no token: releasing due-NOW under
 * sustained pressure is a claim/release loop that hammers the database while
 * accomplishing nothing.
 *
 * GENERATION-AWARE, and it must be. A worker deferring after an await can be
 * stale: a notification may have arrived, bumped targetGeneration and reset
 * nextAttemptAt to now, all while this worker still held the lease. Parking on
 * `dueAt` regardless would let a stale worker delay brand-new work by up to the
 * cooldown — the same defect already removed from failReconciliation, one
 * function over. So the future due time applies ONLY while the generation is
 * still ours; a superseded generation is released due-now.
 */
export const __TEST_ONLY_DEFER_SQL = `
UPDATE "AppleReconciliation" SET
  "reconcileState"  = 'pending',
  "leaseOwner"      = NULL,
  "leaseExpiresAt"  = NULL,
  "nextAttemptAt"   = CASE WHEN "targetGeneration" = ? THEN ? ELSE ? END,
  "updatedAt"       = ?
WHERE "id" = ?
  AND "leaseOwner" = ?
  AND "reconcileState" = 'running'
`.trim();

export async function deferReconciliation(
  job: Pick<ClaimedJob, 'id' | 'leaseToken' | 'generation'>,
  dueAt: Date,
  opts: { now?: Date; client?: QueueClient } = {},
): Promise<void> {
  const db: QueueClient = opts.client ?? asQueueClient(prisma);
  const iso = (opts.now ?? new Date()).toISOString();
  await db.$executeRawUnsafe(
    __TEST_ONLY_DEFER_SQL,
    job.generation, dueAt.toISOString(), iso, iso, job.id, job.leaseToken,
  );
}

/**
 * FAILURE — generation-aware, in one statement.
 *
 * A stale worker must not be able to punish a newer generation. Because intake
 * deliberately leaves a running job running, a G=1 worker can still be in flight
 * when G=2 arrives and resets attemptCount/nextAttemptAt. If failure blindly
 * marked the ROW failed and installed a backoff, that stale worker would park the
 * brand-new G=2 for up to the maximum delay — undoing the very promise intake
 * makes, and doing it across an await.
 *
 * So the statement branches on whether the generation is still ours:
 *   still ours  -> failed, attemptCount + 1, backoff, record the error
 *   superseded  -> pending, attemptCount 0, due now, no error recorded
 * and releases the lease either way.
 *
 * The backoff is chosen by CASE over the row's CURRENT attemptCount, not over the
 * value this worker captured before its await.
 */
export const __TEST_ONLY_FAIL_SQL = `
UPDATE "AppleReconciliation" SET
  "reconcileState"  = CASE WHEN "targetGeneration" = ? THEN 'failed' ELSE 'pending' END,
  "attemptCount"    = CASE WHEN "targetGeneration" = ? THEN "attemptCount" + 1 ELSE 0 END,
  "lastError"       = CASE WHEN "targetGeneration" = ? THEN ? ELSE NULL END,
  "nextAttemptAt"   = CASE
                        WHEN "targetGeneration" <> ? THEN ?
                        WHEN "attemptCount" + 1 <= 1 THEN ?
                        WHEN "attemptCount" + 1 = 2 THEN ?
                        WHEN "attemptCount" + 1 = 3 THEN ?
                        WHEN "attemptCount" + 1 = 4 THEN ?
                        ELSE ?
                      END,
  "leaseOwner"      = NULL,
  "leaseExpiresAt"  = NULL,
  "updatedAt"       = ?
WHERE "id" = ?
  AND "leaseOwner" = ?
  AND "reconcileState" = 'running'
`.trim();

export async function failReconciliation(
  job: Pick<ClaimedJob, 'id' | 'leaseToken' | 'generation'>,
  error: string,
  opts: { now?: Date; client?: QueueClient; retryAfterMs?: number } = {},
): Promise<void> {
  const db: QueueClient = opts.client ?? asQueueClient(prisma);
  const now = opts.now ?? new Date();
  const iso = now.toISOString();
  /**
   * When Apple tells us when to come back (Retry-After on a 429), that
   * instruction wins over our own ladder: it is fed into every backoff slot so
   * the chosen delay is Apple's regardless of attemptCount. A superseded
   * generation is still released immediately — a rate limit must not park a
   * newer generation any more than a failure may.
   */
  const after = (ms: number) =>
    new Date(now.getTime() + (opts.retryAfterMs ?? ms)).toISOString();
  await db.$executeRawUnsafe(
    __TEST_ONLY_FAIL_SQL,
    job.generation,                 // reconcileState CASE
    job.generation,                 // attemptCount CASE
    job.generation,                 // lastError CASE
    error.slice(0, 500),
    job.generation,                 // nextAttemptAt: superseded?
    iso,                            //   -> due immediately
    after(BACKOFF_MS[1]),
    after(BACKOFF_MS[2]),
    after(BACKOFF_MS[3]),
    after(BACKOFF_MS[4]),
    after(BACKOFF_MS[5]),
    iso,                            // updatedAt
    job.id,
    job.leaseToken,
  );
}
