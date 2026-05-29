// In-process daily v1↔v2 reconciliation cron.
//
// Runs reconcileAllCreators once per 24h while the shadow-write epoch is
// active. Lives inside the API process so it doesn't require a separate
// Railway service; can be deleted post-cutover.
//
// Output: a single structured log line per run, in a format easy to scrape
// from Railway log streams or Datadog. Divergent count is the headline KPI.
//
// Safety: each iteration is wrapped in try/catch so a transient v2 outage
// doesn't kill the timer. The library throws if V2_DATABASE_URL is unset,
// which is the deliberate fail-fast path — the caller of `start()` is
// expected to gate on that env var.
//
// Single-replica assumption: Railway runs this service single-replica
// (assertSingleReplicaRefreshRotationSafety in index.ts enforces it). If
// that ever changes, two replicas would do duplicate reconcile passes
// — wasted DB load but no correctness risk since the job is read-only.

import { reconcileAllCreators } from './v1-vs-v2';

const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;

async function runOnce(): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    const report = await reconcileAllCreators();
    const summary = {
      ts: startedAt,
      job: 'v2_reconcile',
      scanned: report.totalScanned,
      clean: report.cleanCount,
      divergent: report.divergent.length,
      v2_missing: report.v2Missing.length,
      duration_ms: report.durationMs,
      sample_divergent: report.divergent.slice(0, 5).map((d) => ({
        creator_id: d.creatorUserId,
        v1_cents: d.v1BalanceCents,
        v2_cents: Number(d.v2BalanceCents),
        diff_cents: Number(d.diffCents),
      })),
    };
    if (report.divergent.length > 0) {
      console.error('[V2 Reconcile] DIVERGENCE DETECTED', JSON.stringify(summary));
    } else {
      console.log('[V2 Reconcile] OK', JSON.stringify(summary));
    }
  } catch (err) {
    console.error(
      '[V2 Reconcile] FATAL',
      JSON.stringify({
        ts: startedAt,
        job: 'v2_reconcile',
        error: (err as Error).message,
      }),
    );
  }
}

/**
 * Schedule the daily v1↔v2 reconciliation. No-op (with a log line) if
 * V2_DATABASE_URL is unset — that's the signal the v2 ledger isn't wired
 * yet, and the underlying lib would throw anyway.
 *
 * Idempotent: calling twice cancels the prior schedule and re-arms with
 * fresh timers. This matters if start() ever gets called from a reload path.
 */
export function scheduleV2ReconcileDaily(): void {
  if (timer) clearTimeout(timer);
  if (interval) clearInterval(interval);

  if (!process.env.V2_DATABASE_URL) {
    console.log('[V2 Reconcile] V2_DATABASE_URL not set — daily reconciliation NOT scheduled.');
    return;
  }

  console.log('[V2 Reconcile] Scheduled daily (first run in 5 min, then every 24h).');
  timer = setTimeout(() => {
    void runOnce();
    interval = setInterval(() => void runOnce(), DAY_MS);
    interval.unref();
  }, INITIAL_DELAY_MS);
  // unref so a pending recon timer doesn't block SIGTERM shutdown (the
  // server.close() flow exits cleanly without waiting on the cron heartbeat).
  timer.unref();
}
