import { reconcileOnce, type ReconcileOutcome, type ReconcilerDeps } from './apple-reconciler.service';
import {
  assertSupportedSingletonTopology,
  buildWorkerId,
  type SingletonMode,
} from './apple-worker-topology';
import { missingAppleTransportConfig, type AppleTransportConfig } from './apple-transport-factory';

/**
 * The Apple reconciliation worker runtime.
 *
 * ONE sequential loop, concurrency 1. Deliberately not setInterval: an interval
 * whose callback is async can re-enter before the previous tick finishes, which
 * is how a "concurrency 1" worker quietly becomes concurrent. A while-loop that
 * awaits each pass cannot overlap by construction.
 *
 * Concurrency stays at 1 not because Apple requires it — the 50/s Production and
 * 5/s Sandbox limiter is the external ceiling — but because initial volume does
 * not justify a second concurrency state machine against SQLite. It can be
 * raised later without changing the shape of this file.
 *
 * SINGLETON: see apple-worker-topology.ts. Railway's volume-backed service
 * cannot have replicas, so the platform provides cross-process enforcement; this
 * module provides in-process enforcement; and the topology assertion fails
 * CLOSED if the platform guarantee ever stops holding.
 *
 * NOTHING STARTS THIS AUTOMATICALLY. It is not registered at boot, and it is
 * gated on APPLE_RECONCILIATION_WORKER_ENABLED — deliberately separate from
 * APPLE_IAP_ENABLED, so exercising the runtime never means turning
 * customer-facing Apple IAP on.
 */

export const WORKER_ENABLED_ENV = 'APPLE_RECONCILIATION_WORKER_ENABLED';
const DEFAULT_IDLE_SLEEP_MS = 1_000;

export interface AppleWorkerStatus {
  enabled: boolean;
  running: boolean;
  stopping: boolean;
  workerId: string | null;
  singletonMode: SingletonMode | null;
  startedAt: string | null;
  lastLoopAt: string | null;
  lastOutcome: ReconcileOutcome['kind'] | null;
  /** Identifiers only — never a JWS, never a payload. */
  currentJob: { environment: string; originalTransactionId: string; generation: number } | null;
  processedCount: number;
  committedCount: number;
  staleCount: number;
  failedCount: number;
  rateLimitedCount: number;
  parkedCount: number;
  deferredCount: number;
  idleCount: number;
}

export interface AppleWorkerOptions {
  deps: ReconcilerDeps;
  /** Trust-boundary configuration, validated before the loop starts. */
  transportConfig: AppleTransportConfig;
  env?: NodeJS.ProcessEnv;
  idleSleepMs?: number;
  /** Test seam: stop after N passes so a test need not race a real loop. */
  maxPasses?: number;
  onError?: (err: unknown) => void;
}

export class AppleWorkerAlreadyRunningError extends Error {
  constructor() {
    super('an Apple reconciliation worker is already running in this process');
    this.name = 'AppleWorkerAlreadyRunningError';
  }
}

export class AppleWorkerConfigError extends Error {
  constructor(readonly missing: string[]) {
    // Names only. Never values.
    super(`Apple reconciliation worker cannot start: missing ${missing.join(', ')}`);
    this.name = 'AppleWorkerConfigError';
  }
}

export interface AppleWorkerHandle {
  workerId: string;
  singletonMode: SingletonMode;
  /** Resolves when the loop has fully stopped. */
  stop(): Promise<void>;
  /** Resolves when the loop exits on its own (maxPasses, or stop()). */
  done: Promise<void>;
}

/* ── module-level state: the in-process singleton guard ─────────────────── */

let current: AppleWorkerHandle | null = null;
let status: AppleWorkerStatus = emptyStatus();

function emptyStatus(): AppleWorkerStatus {
  return {
    enabled: false, running: false, stopping: false, workerId: null, singletonMode: null,
    startedAt: null, lastLoopAt: null, lastOutcome: null, currentJob: null,
    processedCount: 0, committedCount: 0, staleCount: 0, failedCount: 0,
    rateLimitedCount: 0, parkedCount: 0, deferredCount: 0, idleCount: 0,
  };
}

export function getAppleWorkerStatus(): AppleWorkerStatus {
  return { ...status, currentJob: status.currentJob ? { ...status.currentJob } : null };
}

export function isAppleWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WORKER_ENABLED_ENV] === 'true';
}

/** Test seam — never called in production. */
export function __resetAppleWorkerForTests(): void {
  current = null;
  status = emptyStatus();
}

/** Interruptible sleep so stop() does not wait out a full idle interval. */
function sleep(ms: number, signal: { stopping: boolean }): Promise<void> {
  return new Promise((resolve) => {
    if (signal.stopping) return resolve();
    const timer = setTimeout(resolve, ms);
    // Do not hold the process open on this timer.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/**
 * Start the worker. Refuses if one is already running in this process.
 *
 * Order matters: topology first, then configuration, then the loop. Both checks
 * are FATAL and happen before any job is claimed — discovering missing
 * credentials per-job would mean burning attemptCount on rows that never had a
 * chance.
 */
export function startAppleReconciliationWorker(opts: AppleWorkerOptions): AppleWorkerHandle {
  if (current) throw new AppleWorkerAlreadyRunningError();

  const env = opts.env ?? process.env;
  const singletonMode = assertSupportedSingletonTopology(env);

  const missing = missingAppleTransportConfig(opts.transportConfig);
  if (missing.length > 0) throw new AppleWorkerConfigError(missing);

  const workerId = buildWorkerId(env);
  const idleSleepMs = opts.idleSleepMs ?? DEFAULT_IDLE_SLEEP_MS;
  const signal = { stopping: false };

  status = {
    ...emptyStatus(),
    enabled: true, running: true, workerId, singletonMode,
    startedAt: new Date().toISOString(),
  };

  const loop = (async () => {
    let passes = 0;
    while (!signal.stopping) {
      if (opts.maxPasses != null && passes >= opts.maxPasses) break;
      passes += 1;

      let outcome: ReconcileOutcome;
      try {
        outcome = await reconcileOnce(workerId, opts.deps);
      } catch (err) {
        // A throw here means something outside the reconciler's own handling.
        // Keep the loop alive; the queue's lease expiry covers anything left.
        opts.onError?.(err);
        status.failedCount += 1;
        status.lastLoopAt = new Date().toISOString();
        await sleep(idleSleepMs, signal);
        continue;
      }

      status.lastLoopAt = new Date().toISOString();
      status.lastOutcome = outcome.kind;
      status.processedCount += 1;
      status.currentJob = null;

      switch (outcome.kind) {
        case 'committed': status.committedCount += 1; break;
        case 'stale': status.staleCount += 1; break;
        case 'rate-limited': status.rateLimitedCount += 1; break;
        case 'permanently-invalid': status.parkedCount += 1; break;
        case 'deferred': status.deferredCount += 1; break;
        case 'idle': status.idleCount += 1; break;
        default: status.failedCount += 1; break;   // transient | invalid | persistence-failed
      }

      // Work happened -> look again immediately. Nothing to do -> back off a
      // little so an empty queue does not spin.
      if (outcome.kind === 'idle' || outcome.kind === 'deferred') {
        await sleep(idleSleepMs, signal);
      }
    }

    status.running = false;
    status.stopping = false;
    status.currentJob = null;
    current = null;
  })();

  const handle: AppleWorkerHandle = {
    workerId,
    singletonMode,
    done: loop,
    async stop() {
      /**
       * Stop CLAIMING, then let the current pass finish.
       *
       * The in-flight reconciliation's lease is deliberately NOT released. If the
       * pass completes, its generation + fencing CAS decides whether it may
       * commit, exactly as normal. If the process dies first, the queue's lease
       * expiry makes the row reclaimable — a mechanism already reviewed in #34.
       * Releasing here would invent a third path and risk handing the row to
       * another worker while this one is still talking to Apple.
       */
      signal.stopping = true;
      status.stopping = true;
      await loop;
    },
  };

  current = handle;
  return handle;
}

/**
 * The gated entry point a bootstrap would call.
 *
 * Returns null when APPLE_RECONCILIATION_WORKER_ENABLED is not exactly 'true',
 * WITHOUT touching Apple, the queue or the topology assertion. That ordering
 * matters: a disabled worker must be inert even in a deployment with no Apple
 * credentials and no volume, which is exactly today's production.
 *
 * The flag is separate from APPLE_IAP_ENABLED on purpose — exercising this
 * runtime must never be the same act as turning customer-facing Apple IAP on.
 */
export function startAppleWorkerIfEnabled(opts: AppleWorkerOptions): AppleWorkerHandle | null {
  const env = opts.env ?? process.env;
  if (!isAppleWorkerEnabled(env)) {
    status = { ...emptyStatus(), enabled: false };
    return null;
  }
  return startAppleReconciliationWorker(opts);
}

/**
 * Wire SIGTERM to a graceful stop. Returns a function that removes the handler.
 *
 * Railway sends SIGTERM before stopping a deployment and allows a draining
 * period. The Apple HTTP transport already times out at 15s and reconciliation
 * leases last 2 minutes, so a drain comfortably above the network timeout (~30s)
 * lets an in-flight pass finish rather than needing cancellation semantics here.
 */
export function installAppleWorkerSignalHandlers(handle: AppleWorkerHandle): () => void {
  const onSignal = () => { void handle.stop(); };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  return () => {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  };
}
