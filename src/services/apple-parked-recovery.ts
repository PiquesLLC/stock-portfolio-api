import prisma from '../utils/prisma';
import { PERMANENT_PARK_MS, type AppleEnvironment, type QueueClient } from './apple-reconciliation-queue.service';

/**
 * Administrative recovery for PARKED reconciliation jobs.
 *
 * A permanent verification failure parks a row ~100 years out. That is right
 * when Apple's data is genuinely bad — but INVALID_APP_IDENTIFIER, a wrong
 * bundle id, an expired root certificate or a bad key are equally capable of
 * coming from OUR misconfiguration. In that case the rows were parked by a bug
 * we then fixed, and "wait for Apple to send another notification" is not a
 * recovery mechanism: it is a hope.
 *
 * So recovery is explicit and OPERATOR-TRIGGERED. Nothing requeues
 * automatically, because an automatic sweep would defeat parking entirely — the
 * whole point is that these rows stop consuming the queue until a human decides
 * the cause is fixed.
 *
 * Deliberately not exposed as an HTTP route. It is reachable through a CLI
 * (npm run apple:requeue-parked), which keeps it out of the public surface and
 * makes each use a recorded, intentional act.
 */

/**
 * A row counts as parked when its next attempt is absurdly far away. The
 * ordinary backoff ladder tops out at one hour, so a threshold of one year
 * cannot mistake a backed-off row for a parked one — an important distinction,
 * since waking a row that is merely rate-limited would undo the backoff.
 */
export const PARKED_THRESHOLD_MS = 365 * 24 * 60 * 60 * 1000;

export interface RequeueFilter {
  environment?: AppleEnvironment;
  originalTransactionId?: string;
  /** Required to requeue everything. A typo must not wake every subscription. */
  all?: boolean;
}

export class RequeueScopeError extends Error {
  constructor() {
    super(
      'refusing to requeue every parked Apple reconciliation without an explicit --all: ' +
      'pass an environment, an originalTransactionId, or --all',
    );
    this.name = 'RequeueScopeError';
  }
}

/**
 * One statement. Only rows that are BOTH failed and parked are touched, and
 * `running` rows are excluded so a live worker's job is never yanked out from
 * under it.
 */
export const __TEST_ONLY_REQUEUE_SQL = `
UPDATE "AppleReconciliation" SET
  "reconcileState"  = 'pending',
  "attemptCount"    = 0,
  "nextAttemptAt"   = ?,
  "lastError"       = NULL,
  "leaseOwner"      = NULL,
  "leaseExpiresAt"  = NULL,
  "updatedAt"       = ?
WHERE "reconcileState" = 'failed'
  AND "nextAttemptAt" > ?
`.trim();

export async function requeueParkedAppleReconciliations(
  filter: RequeueFilter,
  opts: { client?: QueueClient; now?: Date } = {},
): Promise<number> {
  const scoped = Boolean(filter.environment || filter.originalTransactionId);
  if (!scoped && !filter.all) throw new RequeueScopeError();

  const db = (opts.client ?? (prisma as unknown as QueueClient));
  const now = opts.now ?? new Date();
  const iso = now.toISOString();
  const parkedAfter = new Date(now.getTime() + PARKED_THRESHOLD_MS).toISOString();

  let sql = __TEST_ONLY_REQUEUE_SQL;
  const args: unknown[] = [iso, iso, parkedAfter];
  if (filter.environment) { sql += `\n  AND "environment" = ?`; args.push(filter.environment); }
  if (filter.originalTransactionId) {
    sql += `\n  AND "originalTransactionId" = ?`;
    args.push(filter.originalTransactionId);
  }

  return db.$executeRawUnsafe(sql, ...args);
}

/** How many rows are currently parked, for reporting before and after. */
export async function countParkedAppleReconciliations(
  filter: Omit<RequeueFilter, 'all'> = {},
  opts: { client?: QueueClient; now?: Date } = {},
): Promise<number> {
  const db = (opts.client ?? (prisma as unknown as QueueClient));
  const now = opts.now ?? new Date();
  const parkedAfter = new Date(now.getTime() + PARKED_THRESHOLD_MS).toISOString();

  let sql = `SELECT COUNT(*) AS n FROM "AppleReconciliation"
             WHERE "reconcileState" = 'failed' AND "nextAttemptAt" > ?`;
  const args: unknown[] = [parkedAfter];
  if (filter.environment) { sql += ` AND "environment" = ?`; args.push(filter.environment); }
  if (filter.originalTransactionId) {
    sql += ` AND "originalTransactionId" = ?`;
    args.push(filter.originalTransactionId);
  }
  const rows = await db.$queryRawUnsafe<{ n: number | bigint }>(sql, ...args);
  return Number(rows[0]?.n ?? 0);
}

/** Sanity check that the park constant and the threshold cannot cross. */
export const __PARK_EXCEEDS_THRESHOLD = PERMANENT_PARK_MS > PARKED_THRESHOLD_MS;
