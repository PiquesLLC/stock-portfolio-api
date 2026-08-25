import prisma from '../utils/prisma';

/**
 * Durable reconciliation queue — generation and lease primitives.
 *
 * Implements the queue half of docs/apple-authoritative-state-design-2026-08-24.md
 * (FROZEN). This module deliberately contains NO Apple API calls, NO entitlement
 * projection and NO webhook handling; it is the concurrency substrate those will
 * later sit on. APPLE_IAP_ENABLED is irrelevant here because nothing invokes it yet.
 *
 * THE INVARIANT THIS MODULE EXISTS TO ENFORCE
 *
 *   For a given (environment, originalTransactionId), no worker may commit work
 *   for generation G if a newer generation exists, or if that worker no longer
 *   owns the lease.
 *
 * WHY THE SHAPE OF THIS API IS WHAT IT IS
 *
 * Every state transition below is a SINGLE SQL statement whose WHERE clause
 * carries the precondition. None of them read a value, await, and then write it
 * back — that pattern is exactly how the payout path lost updates (finding F-3),
 * and it is the failure mode this queue is most likely to reintroduce.
 *
 * `completeReconciliation` takes the snapshot write as a CALLBACK rather than
 * returning "you may now write". That is not stylistic: it makes the dangerous
 * shape unrepresentable. A caller cannot mark the job done in one transaction
 * and write the snapshot in another, because there is no API that marks it done
 * on its own. A crash between those two commits would otherwise leave a
 * subscription permanently unreconciled at a generation the CAS can never accept
 * again — invisible to schema-level testing, and unrecoverable without manual
 * repair.
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

/** Default lease length. A worker that dies holding one is reclaimable after this. */
export const DEFAULT_LEASE_MS = 2 * 60 * 1000;

/** Retry backoff, capped. Index is attemptCount. */
const BACKOFF_MS = [0, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
export function backoffForAttempt(attemptCount: number): number {
  return BACKOFF_MS[Math.min(Math.max(attemptCount, 0), BACKOFF_MS.length - 1)];
}

/**
 * INTAKE — atomically create-or-advance the work item.
 *
 * One statement. SQLite's UPSERT increments in place, so two concurrent intakes
 * cannot lose an increment and cannot create a duplicate row: the unique index
 * on (environment, originalTransactionId) is what the ON CONFLICT targets.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It never resets targetGeneration. The counter is monotonic per subscription
 *    for the lifetime of the row, which is why these rows are never deleted:
 *    recycling the numbering would let a stale in-flight worker's CAS match a
 *    fresh generation.
 *
 *  - It does not knock a 'running' job back to 'pending'. Doing so would let a
 *    second worker claim while the first is still calling Apple — correct under
 *    the CAS, but a wasted API call against a rate-limited endpoint. The
 *    in-flight worker will fail its CAS and release the job itself.
 *
 * attemptCount/nextAttemptAt ARE reset: a new notification is new work, and a
 * job previously parked on a long backoff should not stay parked.
 */
export const ENQUEUE_SQL = `
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
    ENQUEUE_SQL,
    cryptoRandomId(),
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
 * expired (its worker died). The precondition lives entirely in the WHERE clause,
 * so two workers racing for the same row produce one winner and one zero-row
 * update; the loser simply moves on. Claiming by id after selecting candidates is
 * safe for the same reason — the UPDATE, not the SELECT, decides.
 */
export const CLAIM_SQL = `
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
  leaseOwner: string;
  attemptCount: number;
}

/**
 * Claim returns the generation observed after the claim succeeded. The worker
 * carries that number and must present it back at completion; anything that
 * advanced it in the meantime invalidates the work.
 */
export async function claimReconciliationJob(
  leaseOwner: string,
  opts: { leaseMs?: number; now?: Date; limit?: number } = {},
): Promise<ClaimedJob | null> {
  const now = opts.now ?? new Date();
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();

  const candidates = await prisma.appleReconciliation.findMany({
    where: {
      nextAttemptAt: { lte: now },
      OR: [
        { reconcileState: { in: ['pending', 'failed'] } },
        { reconcileState: 'running', leaseExpiresAt: { lte: now } },
        { reconcileState: 'running', leaseExpiresAt: null },
      ],
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: opts.limit ?? 10,
    select: { id: true },
  });

  for (const { id } of candidates) {
    const won = await prisma.$executeRawUnsafe(
      CLAIM_SQL, leaseOwner, leaseUntil, nowIso, id, nowIso, nowIso,
    );
    if (won !== 1) continue; // someone else claimed it between SELECT and UPDATE

    const row = await prisma.appleReconciliation.findUnique({
      where: { id },
      select: {
        id: true, environment: true, originalTransactionId: true,
        targetGeneration: true, leaseOwner: true, attemptCount: true,
      },
    });
    // Read back under our own lease. If the row vanished (it should not — these
    // rows are never deleted) or the lease is not ours, treat it as not claimed.
    if (!row || row.leaseOwner !== leaseOwner) continue;

    return {
      id: row.id,
      environment: row.environment as AppleEnvironment,
      originalTransactionId: row.originalTransactionId,
      generation: row.targetGeneration,
      leaseOwner,
      attemptCount: row.attemptCount,
    };
  }
  return null;
}

/**
 * COMPLETE — the CAS and the snapshot write, in ONE transaction.
 *
 * The CAS predicate carries BOTH halves of the invariant:
 *   targetGeneration = G   → no newer notification arrived
 *   leaseOwner       = me  → the lease was not reclaimed
 *
 * If it matches nothing, the transaction throws and rolls back, so `writeSnapshot`
 * cannot have persisted anything — the whole point. The job is then released back
 * to 'pending' so the newer generation is picked up.
 *
 * There is deliberately no exported way to mark a job done without supplying the
 * snapshot write.
 */
export class StaleWorkError extends Error {
  constructor(readonly reason: 'generation-advanced' | 'lease-lost') {
    super(`reconciliation work is stale: ${reason}`);
    this.name = 'StaleWorkError';
  }
}

/**
 * The CAS. Both halves of the invariant are in the WHERE clause, so the engine
 * decides — there is no read, no await, and no write-back of a value we observed
 * earlier. Exported so the real-engine test exercises THIS statement rather than
 * a re-implementation of it.
 */
export const COMPLETE_CAS_SQL = `
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
  job: Pick<ClaimedJob, 'id' | 'generation' | 'leaseOwner'>,
  writeSnapshot: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void>,
  now: Date = new Date(),
): Promise<{ committed: boolean; reason?: StaleWorkError['reason'] }> {
  try {
    await prisma.$transaction(async (tx) => {
      const won = await tx.$executeRawUnsafe(
        COMPLETE_CAS_SQL, now.toISOString(), job.id, job.generation, job.leaseOwner,
      );
      if (won === 0) throw new StaleWorkError('generation-advanced');

      // Same transaction. If this throws, the 'done' transition rolls back with
      // it and the job stays claimable — never one without the other.
      await writeSnapshot(tx);
    });
    return { committed: true };
  } catch (err) {
    if (err instanceof StaleWorkError) {
      await releaseReconciliation(job, now);
      return { committed: false, reason: err.reason };
    }
    throw err;
  }
}

/**
 * Release a job this worker can no longer finish, so the newer generation is
 * picked up promptly. Guarded on lease ownership so a worker whose lease was
 * reclaimed cannot disturb the new owner.
 */
export async function releaseReconciliation(
  job: Pick<ClaimedJob, 'id' | 'leaseOwner'>,
  now: Date = new Date(),
): Promise<void> {
  await prisma.appleReconciliation.updateMany({
    where: { id: job.id, leaseOwner: job.leaseOwner },
    data: { reconcileState: 'pending', leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now, updatedAt: now },
  });
}

/**
 * Record a failed attempt and back off. Guarded on lease ownership for the same
 * reason as release. attemptCount is incremented in the statement, not read and
 * written back.
 */
export async function failReconciliation(
  job: Pick<ClaimedJob, 'id' | 'leaseOwner' | 'attemptCount'>,
  error: string,
  now: Date = new Date(),
): Promise<void> {
  const delay = backoffForAttempt(job.attemptCount + 1);
  await prisma.appleReconciliation.updateMany({
    where: { id: job.id, leaseOwner: job.leaseOwner },
    data: {
      reconcileState: 'failed',
      attemptCount: { increment: 1 },
      nextAttemptAt: new Date(now.getTime() + delay),
      lastError: error.slice(0, 500),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    },
  });
}

/** uuid without pulling a dependency into this module's surface. */
function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}
