import type { AppleWorkerHandle } from './apple-reconciliation-worker';

/**
 * Shutdown ordering for the Apple reconciliation worker.
 *
 * This exists as one function so the ORDER is testable rather than merely
 * asserted. The requirement is not "stop the worker" and separately "disconnect
 * Prisma" — it is that the first completes before the second begins, because the
 * in-flight reconciliation pass still needs the database. Disconnecting first
 * would fail a pass that was moments from committing.
 *
 * Nothing here force-releases the reconciliation lease. If the budget is
 * exhausted, or the process dies outright, the queue's lease expiry remains the
 * recovery path — the mechanism reviewed in #34 — and another worker reclaims the
 * row later.
 */

/**
 * Ceiling on how long shutdown waits for an in-flight Apple pass.
 *
 * Above the Apple transport's 15s request timeout so a normal pass genuinely
 * finishes; below the application's hard shutdown deadline so a pathological
 * hang cannot gate the rest of teardown.
 */
export const APPLE_WORKER_STOP_BUDGET_MS = 20_000;

export type AppleWorkerStopOutcome = 'no-worker' | 'stopped' | 'budget-exceeded';

export async function stopAppleWorkerThenDisconnect(
  worker: AppleWorkerHandle | null,
  disconnect: () => Promise<void>,
  opts: { budgetMs?: number } = {},
): Promise<AppleWorkerStopOutcome> {
  const budgetMs = opts.budgetMs ?? APPLE_WORKER_STOP_BUDGET_MS;

  let outcome: AppleWorkerStopOutcome = 'no-worker';
  if (worker) {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<'budget-exceeded'>((resolve) => {
      timer = setTimeout(() => resolve('budget-exceeded'), budgetMs);
      timer.unref?.();
    });
    try {
      outcome = await Promise.race([
        worker.stop().then((): AppleWorkerStopOutcome => 'stopped'),
        budget,
      ]);
    } catch {
      // A failure stopping the worker must not prevent the rest of teardown.
      outcome = 'stopped';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Only now. Every path above reaches this line exactly once.
  await disconnect();
  return outcome;
}

/**
 * Startup cancellation.
 *
 * SIGTERM can arrive while database initialisation is still awaiting. When it
 * does, shutdown() has already set its flag, disconnected Prisma and begun
 * exiting — so startup must NOT resume afterwards and start a worker or begin
 * listening. Guarding only "server may not exist during shutdown" is not enough;
 * the other direction, "startup must never continue after shutdown has begun",
 * needs its own checks.
 *
 * The checks sit at every point where control can return from an await:
 * before starting, after initialisation, and after the worker starts.
 *
 * The catch is the subtle half. If shutdown disconnected Prisma and that makes
 * initialisation reject, the rejection is a CONSEQUENCE of the graceful
 * shutdown, not a startup failure — turning it into a fatal exit would convert
 * an ordinary deploy into a crash-looking one. So a rejection while shutting
 * down is reported as cancellation; a rejection at any other time still throws
 * and reaches the fatal path.
 *
 * There is deliberately no await between the final check and startWorker():
 * the call is synchronous, so shutdown cannot interleave in that window.
 */
export type CriticalStartupOutcome = 'started' | 'cancelled';

export async function runCriticalStartup(deps: {
  initDb: () => Promise<void>;
  startWorker: () => void;
  isShuttingDown: () => boolean;
}): Promise<CriticalStartupOutcome> {
  if (deps.isShuttingDown()) return 'cancelled';

  try {
    await deps.initDb();
  } catch (err) {
    if (deps.isShuttingDown()) return 'cancelled';
    throw err;
  }

  if (deps.isShuttingDown()) return 'cancelled';
  deps.startWorker();

  return deps.isShuttingDown() ? 'cancelled' : 'started';
}
