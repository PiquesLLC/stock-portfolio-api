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
