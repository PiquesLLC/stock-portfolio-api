// Fixed-hour daily scheduling for maintenance jobs.
//
// WHY THIS EXISTS (2026-07-14 outage): every "daily" job used to be anchored
// to process start (`setTimeout(30s)` + `setInterval(24h)`), so the whole
// maintenance fleet — DB backup, snapshot retention, a dozen daily refreshes —
// fired in the same minute, 24h after whatever minute the last deploy happened
// to land on. The weekly Monday-morning content deploy anchored that minute to
// 12:12 UTC (8:12 AM ET, pre-market), where backup + retention + the fleet +
// market traffic stacked onto the single serialized SQLite connection and
// caused a 4¾-hour write-timeout storm. Maintenance must run at a FIXED
// off-peak UTC hour, independent of deploy time.
//
// Not a cron replacement: second-level precision is not needed, and timers
// survive neither restarts nor missed windows (a deploy during the window
// skips that day — acceptable for jobs that are also safe to miss once).

type DailyHandle = { cancel: () => void };

/**
 * Run `fn` every day at the given UTC hour:minute (+ optional fixed offsetMs
 * to stagger jobs that share an hour). First run is the next occurrence —
 * never immediately on boot.
 *
 * The chained-setTimeout form (re-armed after each fire) stays accurate
 * across clock drift and never double-fires after event-loop stalls, unlike
 * `setInterval(24h)`. Timers are unref'd so they don't hold the process open.
 */
export function scheduleDailyAtUTC(
  hourUTC: number,
  minuteUTC: number,
  fn: () => void,
  label: string,
): DailyHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const msUntilNext = (): number => {
    const now = new Date();
    const next = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      hourUTC, minuteUTC, 0, 0,
    ));
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime() - now.getTime();
  };

  const arm = (): void => {
    if (cancelled) return;
    const delay = msUntilNext();
    timer = setTimeout(() => {
      // Re-arm BEFORE running so a slow/hanging job cannot silently stop
      // the schedule. msUntilNext() computed post-fire lands on tomorrow.
      arm();
      try {
        fn();
      } catch (err) {
        console.error(`[Schedule] ${label} threw synchronously:`, err instanceof Error ? err.message : err);
      }
    }, delay);
    timer.unref();
  };

  arm();
  const firstInMin = Math.round(msUntilNext() / 60000);
  console.log(`[Schedule] ${label} daily at ${String(hourUTC).padStart(2, '0')}:${String(minuteUTC).padStart(2, '0')} UTC (first run in ~${firstInMin}min)`);

  return {
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}
