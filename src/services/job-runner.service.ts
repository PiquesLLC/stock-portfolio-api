import * as Sentry from '@sentry/node';
import prisma from '../utils/prisma';
import { Prisma } from '../generated/prisma/client';

// Database corruption must never fail silently — in the 2026-07 incident,
// background jobs dead-lettered against a corrupt table for weeks with only
// console noise. Throttled so a corrupt hot path doesn't flood Sentry.
let lastCorruptionAlertAt = 0;
const CORRUPTION_ALERT_INTERVAL_MS = 60 * 60 * 1000;

export function alertOnCorruption(source: string, errorMsg: string): void {
  if (!errorMsg.includes('SQLITE_CORRUPT') && !errorMsg.includes('database disk image is malformed')) {
    return;
  }
  const now = Date.now();
  if (now - lastCorruptionAlertAt < CORRUPTION_ALERT_INTERVAL_MS) return;
  lastCorruptionAlertAt = now;
  console.error(`[DB] CRITICAL: SQLITE_CORRUPT detected via ${source} — the database file needs a rebuild-and-swap. Reads may work while writes fail; do NOT run VACUUM/REINDEX on a full disk.`);
  try {
    Sentry.captureMessage(`[DB] SQLITE_CORRUPT detected via ${source}`, {
      level: 'error',
      tags: { component: 'db-corruption' },
      extra: { errorMsg },
    });
  } catch {
    // Sentry not initialised (tests / dev without DSN)
  }
}

export type JobFailureCategory = 'TRANSIENT' | 'PERMANENT' | 'RATE_LIMITED' | 'DATA_QUALITY' | 'UNKNOWN';
export type JobAlertSeverity = 'none' | 'warning' | 'critical';

type PrismaLike = typeof prisma & {
  deadLetterEntry?: {
    create?: (args: unknown) => Promise<unknown>;
    findMany?: (args: unknown) => Promise<unknown>;
    update?: (args: unknown) => Promise<unknown>;
  };
  jobIdempotencyKey?: {
    create?: (args: unknown) => Promise<unknown>;
    findUnique?: (args: unknown) => Promise<unknown>;
    update?: (args: unknown) => Promise<unknown>;
    updateMany?: (args: unknown) => Promise<{ count: number }>;
    deleteMany?: (args: unknown) => Promise<{ count: number }>;
    aggregate?: (args: unknown) => Promise<{ _sum?: { duplicateHits?: number | null } }>;
    count?: (args: unknown) => Promise<number>;
  };
};

interface ClassifiedFailure {
  category: JobFailureCategory;
  retryable: boolean;
  backoffMultiplier: number;
  maxAttempts?: number;
}

export class JobExecutionError extends Error {
  category: JobFailureCategory;
  constructor(message: string, category: JobFailureCategory) {
    super(message);
    this.name = 'JobExecutionError';
    this.category = category;
  }
}

interface JobOptions {
  /** Unique name for this job (e.g. "milestone_check") */
  name: string;
  /** The async function to run */
  fn: () => Promise<unknown>;
  /** Max retry attempts (default 3) */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff (default 5000) */
  baseDelayMs?: number;
  /** Maximum retry delay in ms after exponential growth (default 60000) */
  maxDelayMs?: number;
  /** Optional idempotency key for deduplicating duplicate job triggers */
  idempotencyKey?: string;
  /** TTL for idempotency key in ms (default 15 minutes) */
  idempotencyTtlMs?: number;
  /** Optional JSON-serializable context for dead letter debugging */
  context?: Record<string, unknown>;
  /** Throw terminal failures to caller (default false for fire-and-forget jobs) */
  throwOnFailure?: boolean;
}

type RegisteredJobHandler = () => Promise<unknown>;

interface JobStats {
  jobName: string;
  total: number;
  success: number;
  failed: number;
  deadLettered: number;
  failureRate: number;
  alertSeverity: JobAlertSeverity;
  alertThresholds: {
    warning: number;
    critical: number;
  };
  failureCategories: Record<JobFailureCategory, number>;
  avgDurationMs: number;
  lastRun: string | null;
  lastError: string | null;
}

export interface JobRunnerMetrics {
  period: {
    hours: number;
    since: string;
  };
  runs: {
    total: number;
    running: number;
    success: number;
    failed: number;
    deadLettered: number;
    successRate: number;
    failureRate: number;
    avgDurationMs: number;
    p95DurationMs: number;
  };
  idempotency: {
    activeKeys: number;
    duplicateHits: number;
  };
  deadLetters: {
    unresolved: number;
  };
  jobs: Array<{
    jobName: string;
    total: number;
    success: number;
    failed: number;
    deadLettered: number;
    failureRate: number;
    alertSeverity: JobAlertSeverity;
    alertThresholds: {
      warning: number;
      critical: number;
    };
  }>;
}

function safeStringify(obj: unknown): string {
  try { return JSON.stringify(obj); }
  catch { return '[unserializable context]'; }
}

// Track in-flight jobs to prevent overlapping runs of the same job
const inFlightJobs = new Set<string>();
const jobHandlerRegistry = new Map<string, RegisteredJobHandler>();

interface JobAlertThreshold {
  warning: number;
  critical: number;
}

const DEFAULT_ALERT_THRESHOLD: JobAlertThreshold = { warning: 0.05, critical: 0.15 };
const JOB_ALERT_THRESHOLDS: Record<string, JobAlertThreshold> = {
  snapshot_scheduler: { warning: 0.03, critical: 0.10 },
  dividend_sync: { warning: 0.10, critical: 0.25 },
  dividend_post: { warning: 0.10, critical: 0.25 },
  deep_research_poller: { warning: 0.15, critical: 0.30 },
  anomaly_detection: { warning: 0.10, critical: 0.20 },
  milestone_check: { warning: 0.10, critical: 0.20 },
};

function getAlertThresholdForJob(jobName?: string): JobAlertThreshold {
  if (!jobName) return DEFAULT_ALERT_THRESHOLD;
  return JOB_ALERT_THRESHOLDS[jobName] || DEFAULT_ALERT_THRESHOLD;
}

function getAlertSeverity(failureRate: number, jobName?: string): JobAlertSeverity {
  const threshold = getAlertThresholdForJob(jobName);
  if (failureRate > threshold.critical) return 'critical';
  if (failureRate > threshold.warning) return 'warning';
  return 'none';
}

function classifyJobFailure(err: unknown): ClassifiedFailure {
  if (err instanceof JobExecutionError) {
    if (err.category === 'PERMANENT') return { category: 'PERMANENT', retryable: false, backoffMultiplier: 1 };
    if (err.category === 'DATA_QUALITY') return { category: 'DATA_QUALITY', retryable: false, backoffMultiplier: 1 };
    if (err.category === 'RATE_LIMITED') return { category: 'RATE_LIMITED', retryable: true, backoffMultiplier: 3 };
    if (err.category === 'UNKNOWN') return { category: 'UNKNOWN', retryable: true, backoffMultiplier: 1, maxAttempts: 2 };
    return { category: 'TRANSIENT', retryable: true, backoffMultiplier: 1 };
  }

  const e = err as {
    message?: string;
    category?: JobFailureCategory;
    failureCategory?: JobFailureCategory;
    code?: string;
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };

  const explicit = e?.failureCategory || e?.category;
  if (explicit === 'PERMANENT') return { category: 'PERMANENT', retryable: false, backoffMultiplier: 1 };
  if (explicit === 'DATA_QUALITY') return { category: 'DATA_QUALITY', retryable: false, backoffMultiplier: 1 };
  if (explicit === 'RATE_LIMITED') return { category: 'RATE_LIMITED', retryable: true, backoffMultiplier: 3 };
  if (explicit === 'UNKNOWN') return { category: 'UNKNOWN', retryable: true, backoffMultiplier: 1, maxAttempts: 2 };
  if (explicit === 'TRANSIENT') return { category: 'TRANSIENT', retryable: true, backoffMultiplier: 1 };

  const status = e?.status ?? e?.statusCode ?? e?.response?.status;
  if (status === 429) return { category: 'RATE_LIMITED', retryable: true, backoffMultiplier: 3 };
  if (status === 401 || status === 403) return { category: 'PERMANENT', retryable: false, backoffMultiplier: 1 };
  if (status === 408) return { category: 'TRANSIENT', retryable: true, backoffMultiplier: 1 };
  if (typeof status === 'number' && status >= 500 && status <= 599) {
    return { category: 'TRANSIENT', retryable: true, backoffMultiplier: 1 };
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { category: 'PERMANENT', retryable: false, backoffMultiplier: 1 };
  }

  const prismaCode = typeof e?.code === 'string' ? e.code : '';
  if (prismaCode.startsWith('P20')) {
    if (prismaCode === 'P2024') return { category: 'TRANSIENT', retryable: true, backoffMultiplier: 1 };
    return { category: 'PERMANENT', retryable: false, backoffMultiplier: 1 };
  }

  const msg = (e?.message || String(err || '')).toLowerCase();
  if (
    msg.includes('rate limit') ||
    msg.includes('too many request') ||
    msg.includes('quota exceeded') ||
    msg.includes('429')
  ) {
    return { category: 'RATE_LIMITED', retryable: true, backoffMultiplier: 3 };
  }
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('network error') ||
    msg.includes('eai_again') ||
    msg.includes('enotfound') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('504') ||
    msg.includes('5xx')
  ) {
    return { category: 'TRANSIENT', retryable: true, backoffMultiplier: 1 };
  }
  if (
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid api key') ||
    msg.includes('auth failed') ||
    msg.includes('access denied')
  ) {
    return { category: 'PERMANENT', retryable: false, backoffMultiplier: 1 };
  }
  if (
    msg.includes('malformed') ||
    msg.includes('invalid') ||
    msg.includes('validation') ||
    msg.includes('invalid json') ||
    msg.includes('json parse') ||
    msg.includes('unexpected token') ||
    msg.includes('missing required')
  ) {
    return { category: 'DATA_QUALITY', retryable: false, backoffMultiplier: 1 };
  }
  if (
    msg.includes('quote unavailable') ||
    msg.includes('bad quote') ||
    msg.includes('data quality') ||
    msg.includes('suspiciously low') ||
    msg.includes('sudden drop')
  ) {
    return { category: 'DATA_QUALITY', retryable: false, backoffMultiplier: 1 };
  }

  return { category: 'UNKNOWN', retryable: true, backoffMultiplier: 1, maxAttempts: 2 };
}

function parseFailureCategory(error: string | null): JobFailureCategory | null {
  if (!error) return null;
  const m = error.match(/^\[(TRANSIENT|PERMANENT|RATE_LIMITED|DATA_QUALITY|UNKNOWN)\]\s+/);
  return (m?.[1] as JobFailureCategory | undefined) ?? null;
}

function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return err.code === 'P2002';
  }
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'P2002';
}

async function claimIdempotencyKey(
  prismaClient: PrismaLike,
  key: string,
  jobName: string,
  ttlMs: number,
): Promise<boolean> {
  const store = prismaClient.jobIdempotencyKey;
  if (typeof store?.create !== 'function') return true;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  try {
    await store.create({
      data: {
        key,
        jobName,
        expiresAt,
      },
    });
    return true;
  } catch (err) {
    if (!isUniqueConstraintError(err)) return true;
  }

  if (typeof store.updateMany === 'function') {
    const refreshed = await store.updateMany({
      where: {
        key,
        expiresAt: { lte: now },
      },
      data: {
        jobName,
        expiresAt,
      },
    });
    if (refreshed.count > 0) return true;
  }

  if (typeof store.update === 'function') {
    await store.update({
      where: { key },
      data: {
        duplicateHits: { increment: 1 },
      },
    }).catch(() => undefined);
  }
  return false;
}

async function updateIdempotencyStatus(
  prismaClient: PrismaLike,
  key: string | undefined,
  status: 'success' | 'failed' | 'dead_lettered',
  error: string | null = null,
): Promise<void> {
  if (!key) return;
  const store = prismaClient.jobIdempotencyKey;
  if (typeof store?.update !== 'function') return;
  await store.update({
    where: { key },
    data: {
      lastRunStatus: status,
      lastRunAt: new Date(),
      lastError: error,
    },
  }).catch(() => undefined);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Run a background job with automatic retry, tracking, and dead-letter support.
 *
 * Usage:
 *   await runJob({ name: 'milestone_check', fn: checkMilestoneAlerts });
 *
 * What it does:
 * 1. Records the job start in BackgroundJobRun
 * 2. Runs the function
 * 3. On success: marks complete with duration
 * 4. On failure: retries with exponential backoff (5s, 10s, 20s)
 * 5. After all retries exhausted: writes to DeadLetterEntry for investigation
 *
 * Concurrency: Only one instance of each job name can run at a time.
 * If a job is already running when the interval fires again, the new call is skipped.
 */
export async function runJob(options: JobOptions): Promise<void> {
  const {
    name,
    fn,
    maxAttempts = 3,
    baseDelayMs = 5000,
    maxDelayMs = 60000,
    idempotencyKey,
    idempotencyTtlMs = 15 * 60 * 1000,
    context,
    throwOnFailure = false,
  } = options;
  const prismaClient = prisma as PrismaLike;

  // Skip if this job is already running (prevents overlap when job > interval)
  if (inFlightJobs.has(name)) {
    return;
  }

  if (idempotencyKey) {
    const acquired = await claimIdempotencyKey(prismaClient, idempotencyKey, name, idempotencyTtlMs);
    if (!acquired) return;
  }

  inFlightJobs.add(name);

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startMs = Date.now();
      let runId: string | null = null;

      try {
        // Record job start
        const run = await prisma.backgroundJobRun.create({
          data: {
            jobName: name,
            status: 'running',
            attempt,
            maxAttempts,
          },
        });
        runId = run.id;

        // Execute the job
        await fn();

        // Record success (telemetry — failure here should NOT retry the job)
        const durationMs = Date.now() - startMs;
        await prisma.backgroundJobRun.update({
          where: { id: runId },
          data: {
            status: 'success',
            durationMs,
            completedAt: new Date(),
          },
        }).catch((telErr) => {
          console.error(`[JobRunner] ${name} succeeded but telemetry update failed:`, telErr instanceof Error ? telErr.message : telErr);
        });
        await updateIdempotencyStatus(prismaClient, idempotencyKey, 'success');

        return; // Success — done (even if telemetry write failed)
      } catch (err) {
        const durationMs = Date.now() - startMs;
        const errorMsg = err instanceof Error ? err.message : String(err);
        const classified = classifyJobFailure(err);
        const errorWithCategory = `[${classified.category}] ${errorMsg}`;
        const effectiveMaxAttempts = classified.maxAttempts
          ? Math.min(maxAttempts, classified.maxAttempts)
          : maxAttempts;
        const canRetry = classified.retryable && attempt < effectiveMaxAttempts;

        // Update run record with failure
        if (runId) {
          const isLastAttempt = !canRetry;
          await prisma.backgroundJobRun.update({
            where: { id: runId },
            data: {
              status: isLastAttempt ? 'dead_lettered' : 'failed',
              error: errorWithCategory,
              durationMs,
              completedAt: new Date(),
            },
          }).catch(() => {}); // Don't let tracking failures break the retry loop
        }

        if (!canRetry) {
          // Retries exhausted OR classified as non-retryable
          console.error(`[JobRunner] ${name} DEAD LETTERED after ${attempt} attempts (${classified.category}): ${errorMsg}`);
          alertOnCorruption(`job:${name}`, errorMsg);
          if (typeof prismaClient.deadLetterEntry?.create === 'function') {
            await prismaClient.deadLetterEntry.create({
              data: {
                jobName: name,
                error: errorWithCategory,
                attempts: attempt,
                context: safeStringify({
                  ...(context || {}),
                  idempotencyKey: idempotencyKey || null,
                }),
              },
            }).catch((dlErr) => {
              console.error(`[JobRunner] Failed to write dead letter for ${name}:`, dlErr);
            });
          } else {
            console.warn(`[JobRunner] Dead letter model unavailable; skipped dead letter write for ${name}`);
          }
          await updateIdempotencyStatus(prismaClient, idempotencyKey, 'dead_lettered', errorWithCategory);
          if (throwOnFailure) {
            if (err instanceof JobExecutionError) throw err;
            throw new JobExecutionError(errorMsg, classified.category);
          }
          return; // Don't throw — caller (setInterval) shouldn't crash
        }

        // Retry with bounded exponential backoff
        const exponential = baseDelayMs * Math.pow(2, attempt - 1) * classified.backoffMultiplier;
        const delay = Math.round(Math.min(maxDelayMs, exponential));
        console.warn(`[JobRunner] ${name} attempt ${attempt}/${maxAttempts} failed (${classified.category}): ${errorMsg}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    await updateIdempotencyStatus(prismaClient, idempotencyKey, 'failed');
  } finally {
    inFlightJobs.delete(name);
  }
}

export function registerJobHandler(name: string, handler: RegisteredJobHandler): void {
  if (!name || typeof handler !== 'function') return;
  jobHandlerRegistry.set(name, handler);
}

export function getActiveBackgroundJobCount(): number {
  return inFlightJobs.size;
}

export async function getJobRunHistory(jobName: string, limit = 50) {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 50));
  return prisma.backgroundJobRun.findMany({
    where: { jobName },
    orderBy: { startedAt: 'desc' },
    take: safeLimit,
    select: {
      id: true,
      jobName: true,
      status: true,
      attempt: true,
      maxAttempts: true,
      durationMs: true,
      error: true,
      startedAt: true,
      completedAt: true,
    },
  });
}

export async function getDeadLetterEntriesPaginated(options?: {
  resolved?: boolean;
  page?: number;
  pageSize?: number;
}) {
  const resolved = options?.resolved ?? false;
  const page = Math.max(1, Math.floor(options?.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.floor(options?.pageSize ?? 25), 200));
  const skip = (page - 1) * pageSize;

  const [entries, total] = await Promise.all([
    prisma.deadLetterEntry.findMany({
      where: { resolved },
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.deadLetterEntry.count({ where: { resolved } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    entries,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasMore: page < totalPages,
    },
  };
}

function safeParseContext(context: string | null | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  try {
    const parsed = JSON.parse(context);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed dead-letter context and continue retry
  }
  return undefined;
}

export async function retryDeadLetterEntry(id: string, resolvedBy?: string) {
  const deadLetterStore = (prisma as PrismaLike).deadLetterEntry;
  if (typeof deadLetterStore?.findMany !== 'function' || typeof deadLetterStore?.update !== 'function') {
    return { ok: false as const, code: 'UNSUPPORTED' as const };
  }

  const matches = await deadLetterStore.findMany({
    where: { id },
    take: 1,
  }) as Array<{
    id: string;
    jobName: string;
    context?: string | null;
    resolved: boolean;
  }>;

  const entry = matches[0];
  if (!entry) {
    return { ok: false as const, code: 'NOT_FOUND' as const };
  }

  if (entry.resolved) {
    return { ok: false as const, code: 'ALREADY_RESOLVED' as const, entry };
  }

  const handler = jobHandlerRegistry.get(entry.jobName);
  if (!handler) {
    return { ok: false as const, code: 'HANDLER_NOT_REGISTERED' as const, entry };
  }

  const retryContext = {
    ...(safeParseContext(entry.context) ?? {}),
    retryDeadLetterId: entry.id,
    retryRequestedBy: resolvedBy ?? null,
  };

  try {
    await runJob({
      name: entry.jobName,
      fn: handler,
      context: retryContext,
      throwOnFailure: true,
    });

    const resolvedEntry = await deadLetterStore.update({
      where: { id: entry.id },
      data: {
        resolved: true,
        resolvedAt: new Date(),
        resolvedBy: resolvedBy ?? null,
      },
    });

    return { ok: true as const, entry: resolvedEntry };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const category = error instanceof JobExecutionError ? error.category : 'UNKNOWN';
    return {
      ok: false as const,
      code: 'RETRY_FAILED' as const,
      error: message,
      category,
      entry,
    };
  }
}

/**
 * Get aggregate stats for all jobs (or a specific job).
 */
export async function getJobStats(jobName?: string): Promise<JobStats[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // Last 24h

  const where = jobName
    ? { jobName, startedAt: { gte: since } }
    : { startedAt: { gte: since } };

  const runs = await prisma.backgroundJobRun.findMany({
    where,
    select: {
      jobName: true,
      status: true,
      durationMs: true,
      error: true,
      startedAt: true,
    },
    orderBy: { startedAt: 'desc' },
  });

  // Group by jobName
  const grouped = new Map<string, typeof runs>();
  for (const run of runs) {
    const list = grouped.get(run.jobName) || [];
    list.push(run);
    grouped.set(run.jobName, list);
  }

  const stats: JobStats[] = [];
  for (const [name, jobRuns] of grouped) {
    const success = jobRuns.filter(r => r.status === 'success').length;
    const failed = jobRuns.filter(r => r.status === 'failed').length;
    const deadLettered = jobRuns.filter(r => r.status === 'dead_lettered').length;
    const failures = failed + deadLettered;
    const failureRate = jobRuns.length > 0 ? failures / jobRuns.length : 0;
    const failureCategories: Record<JobFailureCategory, number> = {
      TRANSIENT: 0,
      PERMANENT: 0,
      RATE_LIMITED: 0,
      DATA_QUALITY: 0,
      UNKNOWN: 0,
    };
    for (const run of jobRuns) {
      const c = parseFailureCategory(run.error);
      if (c) failureCategories[c] += 1;
    }
    const durations = jobRuns.filter(r => r.durationMs != null).map(r => r.durationMs!);
    const avgDurationMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    const lastRun = jobRuns[0]?.startedAt?.toISOString() ?? null;
    const lastFailed = jobRuns.find(r => r.error);
    const thresholds = getAlertThresholdForJob(name);

    stats.push({
      jobName: name,
      total: jobRuns.length,
      success,
      failed,
      deadLettered,
      failureRate: Math.round(failureRate * 1000) / 10,
      alertSeverity: getAlertSeverity(failureRate, name),
      alertThresholds: {
        warning: thresholds.warning * 100,
        critical: thresholds.critical * 100,
      },
      failureCategories,
      avgDurationMs,
      lastRun,
      lastError: lastFailed?.error ?? null,
    });
  }

  return stats.sort((a, b) => a.jobName.localeCompare(b.jobName));
}

/**
 * Get dead letter entries (unresolved by default).
 */
export async function getDeadLetterEntries(resolved = false, limit = 50) {
  const deadLetterEntry = (prisma as PrismaLike).deadLetterEntry;
  if (typeof deadLetterEntry?.findMany !== 'function') return [];
  return deadLetterEntry.findMany({
    where: { resolved },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function getJobRunnerMetrics(hours = 24): Promise<JobRunnerMetrics> {
  const safeHours = Math.min(Math.max(Math.floor(hours), 1), 168);
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000);
  const prismaClient = prisma as PrismaLike;

  const runs = await prisma.backgroundJobRun.findMany({
    where: { startedAt: { gte: since } },
    select: {
      jobName: true,
      status: true,
      durationMs: true,
    },
  });

  const total = runs.length;
  const running = runs.filter(r => r.status === 'running').length;
  const success = runs.filter(r => r.status === 'success').length;
  const failed = runs.filter(r => r.status === 'failed').length;
  const deadLettered = runs.filter(r => r.status === 'dead_lettered').length;
  const durationSamples = runs.filter(r => r.durationMs != null).map(r => r.durationMs as number);
  const avgDurationMs = durationSamples.length > 0
    ? Math.round(durationSamples.reduce((a, b) => a + b, 0) / durationSamples.length)
    : 0;
  const p95DurationMs = Math.round(percentile(durationSamples, 95));
  const successRate = total > 0 ? success / total : 1;
  const failureRate = total > 0 ? (failed + deadLettered) / total : 0;
  const runsByJob = new Map<string, typeof runs>();
  for (const run of runs) {
    const list = runsByJob.get(run.jobName) || [];
    list.push(run);
    runsByJob.set(run.jobName, list);
  }
  const jobMetrics = [...runsByJob.entries()].map(([jobName, jobRuns]) => {
    const jobSuccess = jobRuns.filter(r => r.status === 'success').length;
    const jobFailed = jobRuns.filter(r => r.status === 'failed').length;
    const jobDeadLettered = jobRuns.filter(r => r.status === 'dead_lettered').length;
    const jobFailureRate = jobRuns.length > 0 ? (jobFailed + jobDeadLettered) / jobRuns.length : 0;
    const thresholds = getAlertThresholdForJob(jobName);

    return {
      jobName,
      total: jobRuns.length,
      success: jobSuccess,
      failed: jobFailed,
      deadLettered: jobDeadLettered,
      failureRate: Math.round(jobFailureRate * 1000) / 10,
      alertSeverity: getAlertSeverity(jobFailureRate, jobName),
      alertThresholds: {
        warning: thresholds.warning * 100,
        critical: thresholds.critical * 100,
      },
    };
  }).sort((a, b) => a.jobName.localeCompare(b.jobName));

  const deadLetters = await prisma.deadLetterEntry.count({
    where: { resolved: false },
  });

  let activeKeys = 0;
  let duplicateHits = 0;
  if (typeof prismaClient.jobIdempotencyKey?.count === 'function') {
    activeKeys = await prismaClient.jobIdempotencyKey.count({
      where: {
        expiresAt: { gt: new Date() },
      },
    });
  }
  if (typeof prismaClient.jobIdempotencyKey?.aggregate === 'function') {
    const duplicateAgg = await prismaClient.jobIdempotencyKey.aggregate({
      where: { updatedAt: { gte: since } },
      _sum: { duplicateHits: true },
    });
    duplicateHits = duplicateAgg?._sum?.duplicateHits ?? 0;
  }

  return {
    period: {
      hours: safeHours,
      since: since.toISOString(),
    },
    runs: {
      total,
      running,
      success,
      failed,
      deadLettered,
      successRate: Math.round(successRate * 1000) / 10,
      failureRate: Math.round(failureRate * 1000) / 10,
      avgDurationMs,
      p95DurationMs,
    },
    idempotency: {
      activeKeys,
      duplicateHits,
    },
    deadLetters: {
      unresolved: deadLetters,
    },
    jobs: jobMetrics,
  };
}

export async function pruneExpiredIdempotencyKeys(): Promise<number> {
  const prismaClient = prisma as PrismaLike;
  const store = prismaClient.jobIdempotencyKey;
  if (typeof store?.deleteMany !== 'function') return 0;
  const result = await store.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });
  return result.count;
}

/**
 * Mark a dead letter entry as resolved.
 */
export async function resolveDeadLetterEntry(id: string, resolvedBy?: string) {
  const deadLetterEntry = (prisma as PrismaLike).deadLetterEntry;
  if (typeof deadLetterEntry?.update !== 'function') return null;
  return deadLetterEntry.update({
    where: { id },
    data: { resolved: true, resolvedAt: new Date(), resolvedBy },
  });
}

/**
 * Clean up old job runs (keeps last 7 days).
 * Call periodically to prevent unbounded table growth.
 */
export async function pruneOldJobRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await prisma.backgroundJobRun.deleteMany({
    where: { startedAt: { lt: cutoff } },
  });
  return result.count;
}

/**
 * Heal orphaned jobs — find all BackgroundJobRun records stuck as "running"
 * and mark them as failed. On startup, ALL running records are orphans because
 * the in-memory inFlightJobs Set was cleared on restart.
 *
 * Call once on startup, before any new jobs are scheduled.
 */
export async function healOrphanedJobs(): Promise<number> {
  const result = await prisma.backgroundJobRun.updateMany({
    where: {
      status: 'running',
    },
    data: {
      status: 'failed',
      error: 'Orphaned — server restarted during execution',
      completedAt: new Date(),
    },
  });

  if (result.count > 0) {
    console.log(`[JobRunner] Healed ${result.count} orphaned job(s) from previous run`);
  }

  return result.count;
}

export async function healStuckJobs(thresholdMinutes = 30) {
  const stuckJobs = await detectStuckJobs(thresholdMinutes);
  if (stuckJobs.length === 0) return [];

  const ids = stuckJobs.map(job => job.id);
  const healedAt = new Date();
  await prisma.backgroundJobRun.updateMany({
    where: {
      id: { in: ids },
      status: 'running',
    },
    data: {
      status: 'failed',
      error: `Stuck job healed by admin after exceeding ${thresholdMinutes} minute threshold`,
      completedAt: healedAt,
    },
  });

  return stuckJobs.map(job => ({
    id: job.id,
    jobName: job.jobName,
    action: 'marked_failed',
  }));
}

/**
 * Detect stuck jobs — find BackgroundJobRun records still marked as "running"
 * that started more than `thresholdMinutes` ago. Returns them for admin review.
 *
 * Does NOT auto-fix — use healOrphanedJobs() for that.
 */
export async function detectStuckJobs(thresholdMinutes = 30) {
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);

  return prisma.backgroundJobRun.findMany({
    where: {
      status: 'running',
      startedAt: { lt: cutoff },
    },
    orderBy: { startedAt: 'desc' },
  });
}

export function getJobRunnerAlertSummary(stats: JobStats[]) {
  const totalRuns = stats.reduce((a, s) => a + s.total, 0);
  const totalFailures = stats.reduce((a, s) => a + s.failed + s.deadLettered, 0);
  const failureRate = totalRuns > 0 ? totalFailures / totalRuns : 0;
  return {
    failureRate: Math.round(failureRate * 1000) / 10,
    warningThreshold: DEFAULT_ALERT_THRESHOLD.warning * 100,
    criticalThreshold: DEFAULT_ALERT_THRESHOLD.critical * 100,
    severity: getAlertSeverity(failureRate),
  };
}
