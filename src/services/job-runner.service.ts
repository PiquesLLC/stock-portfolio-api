import prisma from '../utils/prisma';

interface JobOptions {
  /** Unique name for this job (e.g. "milestone_check") */
  name: string;
  /** The async function to run */
  fn: () => Promise<unknown>;
  /** Max retry attempts (default 3) */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff (default 5000) */
  baseDelayMs?: number;
  /** Optional JSON-serializable context for dead letter debugging */
  context?: Record<string, unknown>;
}

interface JobStats {
  jobName: string;
  total: number;
  success: number;
  failed: number;
  deadLettered: number;
  avgDurationMs: number;
  lastRun: string | null;
  lastError: string | null;
}

function safeStringify(obj: unknown): string {
  try { return JSON.stringify(obj); }
  catch { return '[unserializable context]'; }
}

// Track in-flight jobs to prevent overlapping runs of the same job
const inFlightJobs = new Set<string>();

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
  const { name, fn, maxAttempts = 3, baseDelayMs = 5000, context } = options;

  // Skip if this job is already running (prevents overlap when job > interval)
  if (inFlightJobs.has(name)) {
    return;
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

        return; // Success — done (even if telemetry write failed)
      } catch (err) {
        const durationMs = Date.now() - startMs;
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Update run record with failure
        if (runId) {
          const isLastAttempt = attempt >= maxAttempts;
          await prisma.backgroundJobRun.update({
            where: { id: runId },
            data: {
              status: isLastAttempt ? 'dead_lettered' : 'failed',
              error: errorMsg,
              durationMs,
              completedAt: new Date(),
            },
          }).catch(() => {}); // Don't let tracking failures break the retry loop
        }

        if (attempt >= maxAttempts) {
          // All retries exhausted — write to dead letter queue
          console.error(`[JobRunner] ${name} DEAD LETTERED after ${attempt} attempts: ${errorMsg}`);
          await prisma.deadLetterEntry.create({
            data: {
              jobName: name,
              error: errorMsg,
              attempts: attempt,
              context: context ? safeStringify(context) : null,
            },
          }).catch((dlErr) => {
            console.error(`[JobRunner] Failed to write dead letter for ${name}:`, dlErr);
          });
          return; // Don't throw — caller (setInterval) shouldn't crash
        }

        // Retry with exponential backoff
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.warn(`[JobRunner] ${name} attempt ${attempt}/${maxAttempts} failed: ${errorMsg}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  } finally {
    inFlightJobs.delete(name);
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
    const durations = jobRuns.filter(r => r.durationMs != null).map(r => r.durationMs!);
    const avgDurationMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    const lastRun = jobRuns[0]?.startedAt?.toISOString() ?? null;
    const lastFailed = jobRuns.find(r => r.error);

    stats.push({
      jobName: name,
      total: jobRuns.length,
      success,
      failed,
      deadLettered,
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
  return prisma.deadLetterEntry.findMany({
    where: { resolved },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/**
 * Mark a dead letter entry as resolved.
 */
export async function resolveDeadLetterEntry(id: string, resolvedBy?: string) {
  return prisma.deadLetterEntry.update({
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
