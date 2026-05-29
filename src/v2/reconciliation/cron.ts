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

import * as Sentry from '@sentry/node';
import { reconcileAllCreators } from './v1-vs-v2';

const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
// Don't page on the same drift signature more than once per 6h. The cron
// runs every 24h so this only matters during the initial-day burst or when
// scheduleV2ReconcileDaily is invoked from multiple paths; defensive.
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastAlertAt = 0;

async function runOnce(): Promise<void> {
  // Overlap guard: if a previous run is still in flight (e.g., v2 Postgres
  // degraded and per-creator queries stalled past the 24h interval), do NOT
  // start a second pass — that would double DB load on an already-sick
  // system. The next tick will pick up cleanly once the in-flight run ends.
  if (running) {
    console.warn(
      '[V2 Reconcile] SKIP — previous run still in flight (overlap guard).',
    );
    return;
  }
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const report = await reconcileAllCreators();
    // bigint → Number coercion: safe for per-creator wallet cents — single
    // creator balances will not approach Number.MAX_SAFE_INTEGER (2^53 - 1
    // cents = ~$90 quadrillion). Used only for log emission.
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
      // Stable message string so Sentry groups all drift events into ONE
      // issue (avoids paging once per fluctuating creator count). The
      // per-run details land in `extra`. Also rate-limit Sentry sends to
      // one per ALERT_COOLDOWN_MS so a multi-day drift doesn't page daily.
      const stableMessage = '[V2 Reconcile] DIVERGENCE DETECTED — v1↔v2 creator balance drift';
      const detailLine = `${stableMessage} (count=${report.divergent.length})`;
      console.error(detailLine, JSON.stringify(summary));
      const now = Date.now();
      if (now - lastAlertAt > ALERT_COOLDOWN_MS) {
        lastAlertAt = now;
        // Mirrors the webhook-metrics pattern at
        // src/utils/webhook-metrics.ts:108-109. Sentry.init lives in src/app.ts.
        Sentry.captureMessage(stableMessage, {
          level: 'error',
          tags: { component: 'v2_reconciliation' },
          extra: summary,
        });
      }
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
  } finally {
    running = false;
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
