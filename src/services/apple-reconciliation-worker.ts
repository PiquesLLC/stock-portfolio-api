import { reconcileOnce, type ReconcileOutcome } from './apple-reconciler.service';
import type { ClaimedJob, QueueClient } from './apple-reconciliation-queue.service';
import {
  assertSupportedSingletonTopology,
  buildWorkerId,
  type SingletonMode,
} from './apple-worker-topology';
import {
  appleTransportConfigFromEnv,
  missingAppleTransportConfig,
  createProductionAppleTransport,
  type AppleTransportConfig,
} from './apple-transport-factory';
import type { AppleTransport } from './apple-server-api';

/**
 * The Apple reconciliation worker runtime.
 *
 * ONE sequential loop, concurrency 1. Deliberately not setInterval: an interval
 * whose callback is async can re-enter before the previous tick finishes, which
 * is how a "concurrency 1" worker quietly becomes concurrent. A while-loop that
 * awaits each pass cannot overlap by construction.
 *
 * SINGLETON: see apple-worker-topology.ts. Railway's volume-backed service
 * cannot have replicas; this module adds the in-process guard; the topology
 * assertion fails CLOSED if the platform guarantee stops holding.
 *
 * ── SHUTDOWN IS NOT WIRED HERE, DELIBERATELY ──────────────────────────────
 *
 * There is no SIGTERM listener in this module. index.ts already owns the
 * application's shutdown: it begins teardown, disconnects Prisma, and enforces
 * an 8-second hard exit. A second listener calling stop() would RACE that —
 * Prisma could disconnect, or the process exit, while an Apple pass that is
 * allowed 15 seconds is still in flight.
 *
 * The correct integration is for central shutdown to call worker.stop() and
 * await it BEFORE disconnecting Prisma, with the app's hard deadline and
 * Railway's draining period both raised above the Apple request timeout.
 * Railway's documented default draining is 0 seconds and railway.json currently
 * sets none, so that is a real configuration change, not an assumption.
 *
 * That integration — bootstrap + central-shutdown wiring + draining config — is
 * a MANDATORY pre-enable stage of its own. It has not disappeared by being left
 * out of this PR.
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
  /** Live while a pass is in flight. Identifiers only — never a JWS or payload. */
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

export interface AppleWorkerTestOptions {
  env?: NodeJS.ProcessEnv;
  client?: QueueClient;
  idleSleepMs?: number;
  /** Test seam: stop after N passes so a test need not race a real loop. */
  maxPasses?: number;
  onError?: (err: unknown) => void;
  /**
   * TEST SEAM ONLY. Production always builds the transport from the SAME
   * configuration that was validated — see startAppleWorker.
   */
  __transportFactory?: (cfg: AppleTransportConfig) => AppleTransport;
}

export class AppleWorkerAlreadyRunningError extends Error {
  constructor() {
    super('an Apple reconciliation worker is already running in this process');
    this.name = 'AppleWorkerAlreadyRunningError';
  }
}

export class AppleWorkerConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(`Apple reconciliation worker cannot start: missing ${missing.join(', ')}`);
    this.name = 'AppleWorkerConfigError';
  }
}

export interface AppleWorkerHandle {
  workerId: string;
  singletonMode: SingletonMode;
  /** Stops claiming, awaits the in-flight pass, resolves when fully stopped. */
  stop(): Promise<void>;
  done: Promise<void>;
}

/* ── module state: the in-process singleton guard ───────────────────────── */

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

/**
 * THE production entrypoint. There is no other way to start a loop.
 *
 * Every gate is inside, in order, and none can be supplied by the caller:
 *
 *   flag → topology → config from env → validate → build transport FROM THAT
 *   SAME config → loop
 *
 * The transport is derived from the validated configuration rather than accepted
 * as a parameter. Previously the worker validated one config object and then ran
 * a separately-supplied transport, so both checks were advisory: it could pass
 * validation for credentials it never used.
 */
/**
 * Guard for the test-only surface. Production has neither marker, so importing
 * an injectable entrypoint into a production module fails loudly at call time
 * rather than quietly handing a caller the ability to bypass every gate.
 */
function assertTestOnly(fnName: string): void {
  const inTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
  if (!inTest) {
    throw new Error(
      `${fnName} is a test-only entrypoint and must never be reached in production. ` +
      'Use startAppleWorker(), which reads the real environment and builds the real transport.',
    );
  }
}

/**
 * THE production entrypoint. It takes NO ARGUMENTS, deliberately.
 *
 * Every gate reads the real process environment and constructs the real
 * transport, so none of them can be supplied — or bypassed — by a caller.
 * A previous revision accepted env, client and a transport factory here, which
 * meant the enable flag, the topology assertion, the validated configuration and
 * even the authoritative database could all be substituted at the call site.
 * The gates were load-bearing in intent and advisory in fact.
 */
export function startAppleWorker(): AppleWorkerHandle | null {
  return startInternal({});
}

/** Injectable surface. Refuses to run outside a test process. */
export function __TEST_ONLY_startAppleWorker(opts: AppleWorkerTestOptions = {}): AppleWorkerHandle | null {
  assertTestOnly('__TEST_ONLY_startAppleWorker');
  return startInternal(opts);
}

function startInternal(opts: AppleWorkerTestOptions): AppleWorkerHandle | null {
  const env = opts.env ?? process.env;

  // Flag first: a disabled worker must be inert even where the topology is
  // unsupported and no Apple credentials exist — which is today's production.
  if (!isAppleWorkerEnabled(env)) {
    status = { ...emptyStatus(), enabled: false };
    return null;
  }

  if (current) throw new AppleWorkerAlreadyRunningError();

  const singletonMode = assertSupportedSingletonTopology(env);

  const transportConfig = appleTransportConfigFromEnv(env);
  const missing = missingAppleTransportConfig(transportConfig);
  if (missing.length > 0) throw new AppleWorkerConfigError(missing);

  const transport = opts.__transportFactory
    ? opts.__transportFactory(transportConfig)
    : createProductionAppleTransport(transportConfig).transport;

  return runLoop({ ...opts, env, singletonMode, transport });
}

/* ── the loop ───────────────────────────────────────────────────────────── */

interface LoopOptions extends AppleWorkerTestOptions {
  env: NodeJS.ProcessEnv;
  singletonMode: SingletonMode;
  transport: AppleTransport;
}

function runLoop(opts: LoopOptions): AppleWorkerHandle {
  const workerId = buildWorkerId(opts.env);
  const idleSleepMs = opts.idleSleepMs ?? DEFAULT_IDLE_SLEEP_MS;

  /** Interruptible sleep: stop() wakes it instead of waiting out the interval. */
  const control = { stopping: false, wake: null as null | (() => void) };
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    if (control.stopping) return resolve();
    const timer = setTimeout(finish, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    control.wake = finish;
    function finish() {
      clearTimeout(timer);
      control.wake = null;
      resolve();
    }
  });

  status = {
    ...emptyStatus(),
    enabled: true, running: true, workerId, singletonMode: opts.singletonMode,
    startedAt: new Date().toISOString(),
  };

  const loop = (async () => {
    let passes = 0;
    while (!control.stopping) {
      if (opts.maxPasses != null && passes >= opts.maxPasses) break;
      passes += 1;

      let outcome: ReconcileOutcome;
      try {
        outcome = await reconcileOnce(workerId, {
          client: opts.client,
          transport: opts.transport,
          // Live observability: set the moment a job is claimed, so a stuck
          // Apple request is visible rather than reported as null.
          onJobClaimed: (job: ClaimedJob) => {
            status.currentJob = {
              environment: job.environment,
              originalTransactionId: job.originalTransactionId,
              generation: job.generation,
            };
          },
        });
      } catch (err) {
        opts.onError?.(err);
        status.failedCount += 1;
        status.lastLoopAt = new Date().toISOString();
        status.currentJob = null;
        await sleep(idleSleepMs);
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

      if (outcome.kind === 'idle' || outcome.kind === 'deferred') await sleep(idleSleepMs);
    }

    status.running = false;
    status.stopping = false;
    status.currentJob = null;
    current = null;
  })();

  const handle: AppleWorkerHandle = {
    workerId,
    singletonMode: opts.singletonMode,
    done: loop,
    async stop() {
      /**
       * Stop CLAIMING, then let the current pass finish.
       *
       * The in-flight reconciliation's lease is deliberately NOT released. If the
       * pass completes, its generation + fencing CAS decides whether it may
       * commit. If the process dies first, the queue's lease expiry makes the row
       * reclaimable — a mechanism already reviewed in #34. Releasing here would
       * invent a third path and risk handing the row to another worker while this
       * one is still talking to Apple.
       */
      control.stopping = true;
      status.stopping = true;
      control.wake?.();          // do not wait out an idle interval
      await loop;
    },
  };

  current = handle;
  return handle;
}

/** Test-only: run the loop with an explicit transport, bypassing env gates. */
export function __TEST_ONLY_runLoop(opts: LoopOptions): AppleWorkerHandle {
  assertTestOnly('__TEST_ONLY_runLoop');
  if (current) throw new AppleWorkerAlreadyRunningError();
  return runLoop(opts);
}
