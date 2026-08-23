import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@libsql/client';
import * as Sentry from '@sentry/node';
import prisma, { RESOLVED_DB_FILE, initSqlitePragmas } from '../utils/prisma';
import { DB_PATH, getLastBackupStatus, LastBackupStatus } from './backup.service';
import { getInFlightJobs } from './job-runner.service';
import { getInFlightRequests, type InFlightRequestRow } from '../middleware/inflight';

// WAL watchdog — detects SQLite checkpoint starvation.
//
// During the 2026-07-14 outage the WAL grew to 258MB (~63k un-checkpointed
// frames) because a pinned read snapshot blocked every auto-checkpoint for
// ~4¾ hours; write latency degraded with WAL size until writes timed out
// (P1008 storm), and NOTHING alerted — /health stayed green and Sentry only
// knew SQLITE_CORRUPT. This watchdog turns that silent state into a signal
// within minutes: it measures the WAL file, passively checkpoints when it
// grows, and raises a throttled Sentry alert when the WAL stays large across
// consecutive checks (i.e. passive checkpoints are NOT reclaiming — a reader
// is stuck).
//
// Deliberately NOT a runJob job: it must keep working (and stay silent on
// the write path) precisely when the DB is unhealthy.

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const WAL_WARN_BYTES = 64 * 1024 * 1024;
const SENTRY_THROTTLE_MS = 60 * 60 * 1000;

// Write-liveness probe — detects "the write lock is held and nothing can write".
//
// The WAL watchdog above cannot see this state: it early-returns whenever the
// WAL is SMALL, and the 2026-07-25 outage had a 0-byte WAL for its entire 23
// minutes (the holder took the write lock and never wrote). So writes were dead,
// snapshots recorded 0/16, refresh-token writes timed out, users could not renew
// sessions — and nothing alerted, because every instrumented check was looking
// at something else. This probe asks the only question that matters directly:
// can anyone get the write lock right now?
//
// Runs on its own 60s timer rather than the 5-min WAL tick so an outage is
// caught in ~3 minutes instead of ~10. Alerts only after consecutive failures so
// ordinary contention can't page.
const WRITE_PROBE_INTERVAL_MS = 60 * 1000;
// 1s, not 5s. @libsql/client's file driver is SYNCHRONOUS, so a contended
// BEGIN IMMEDIATE blocks the Node event loop for the whole busy_timeout — no
// HTTP, no timers — every 60s for the duration of a wedge. (Prisma's adapter is
// the same sync client, so this is additive rather than novel, but this repo has
// already taken an outage from a main-thread freeze.) Detection loses nothing:
// a >1s wait to take the lock is already pathological, and three consecutive
// failures are required regardless.
const WRITE_PROBE_BUSY_MS = 1000;
const WRITE_PROBE_ALERT_AFTER = 3;

// Self-heal escalation.
//
// The 2026-07-24 and 2026-08-22 wedges were both cured by a restart and by
// nothing else. The holder never released on its own — 23min and ~20min of dead
// writes respectively, each ended only when a human saw the Sentry alert and
// redeployed by hand. Detection without recovery just means someone gets paged
// faster, so the probe now acts on what it finds.
//
// Two steps, because their costs differ by orders of magnitude:
//  - RESET drops Prisma's connection pool. If the holder is a leaked adapter
//    connection inside THIS process — which both the 0-byte WAL (the holder
//    wrote nothing) and the interactive-transaction timeout that demonstrably
//    did not fire point at — this releases the lock without a restart. NOT free:
//    it aborts in-flight queries, so interactive transactions in the request
//    path roll back and those requests 500. Cheap only relative to a restart,
//    and justified only because nothing can write anyway.
//  - RESTART exits non-zero so the platform starts a clean container. Proven to
//    work twice, costs ~1-2min.
//
// Thresholds are in probe ticks, i.e. minutes. Both sit ABOVE the alert at 3, so
// a human still sees the incident ~2 minutes before anything heals underneath
// them — a self-heal that silently hides a recurring fault is how a latent bug
// survives to become an outage on the day it finally cannot be healed.
const WRITE_PROBE_RESET_AFTER = 5;
const WRITE_PROBE_RESTART_AFTER = 10;
// $disconnect() has to talk to the very pool it is trying to drop, so it can
// hang. Cap it: without a bound, a reset that never returns would leave the
// ladder parked on 'reset' forever and the restart step would never be reached.
const POOL_RESET_TIMEOUT_MS = 5000;

// Only these failures justify acting. BEGIN IMMEDIATE fails permanently and
// identically for faults a restart cannot fix — SQLITE_READONLY (volume
// remounted read-only), SQLITE_CANTOPEN, SQLITE_FULL (this repo has a
// disk-guard because that happens), SQLITE_CORRUPT (the 2026-07-12 outage,
// whose signature is reads working while writes fail). For all of those the
// status quo — degraded but serving reads, one alert an hour — beats exiting
// every ten minutes forever and burying the real fault under restart noise.
// An allowlist fails closed; the blocklist this replaced failed open.
// SQLITE_BUSY_SNAPSHOT and SQLITE_BUSY_TIMEOUT both match on the 'sqlite_busy'
// prefix. SQLITE_LOCKED needs its own entry — its message is "database TABLE is
// locked", which does not contain 'database is locked'. SQLITE_PROTOCOL is the
// classic broken-lock-state left by a crashed writer: precisely what a restart
// cures. The last three are Prisma/adapter wordings that cannot reach this path
// today (detail comes only from the probe's own libsql client) and are here as
// future-proofing against that changing.
const WEDGE_SIGNATURES = [
  'sqlite_busy',
  'sqlite_locked',
  'sqlite_protocol',
  'database is locked',
  'database table is locked',
  'operation has timed out',
  'sockettimeout',
  'p1008',
];

// Even a correctly-diagnosed wedge gets a budget. The in-memory latch bounds
// restarts per PROCESS, which is no bound at all when every restart makes a
// fresh process; this ledger lives on the volume so the count survives the
// restart it is counting. Past the budget the watchdog degrades to alert-only
// and waits for a human — a service that reboots hourly forever is its own
// outage.
const SELF_RESTART_BUDGET = 3;
const SELF_RESTART_WINDOW_MS = 6 * 60 * 60 * 1000;

// A failed pragma re-arm is RETRIED before it is allowed to escalate. Re-arming
// means $connect plus three pragmas against a database that is by definition
// wedged, so failing — or merely exceeding the cap — is the expected case here,
// not a corner one. Escalating on the first miss would collapse the whole ladder
// into "restart at 5" during exactly the incident it was built for.
const POOL_REARM_MAX_ATTEMPTS = 3;
const POOL_REARM_VERIFY_TIMEOUT_MS = 2000;

interface CheckpointRow { busy: number; log: number; checkpointed: number }

interface WatchdogState {
  enabled: boolean;
  walBytes: number | null;
  lastCheckAt: string | null;
  lastCheckpoint: CheckpointRow | null;
  consecutiveLargeWal: number;
  writeLockOk: boolean | null;
  writeLockProbeMs: number | null;
  consecutiveWriteFailures: number;
  /**
   * When this outage episode had its Prisma pool dropped. Doubles as the
   * "already tried the cheap fix" latch for the escalation ladder, and is
   * cleared on recovery so a later, unrelated wedge gets its own reset before
   * anything restarts the process.
   */
  poolResetAt: string | null;
  /**
   * The pool was dropped but could not be brought back with its pragmas — so
   * writers would be running without busy_timeout. Retried for a few ticks, then
   * escalated, because it is not repairable in place.
   */
  poolRearmFailed: boolean;
  rearmAttempts: number;
}

const state: WatchdogState = {
  enabled: false,
  walBytes: null,
  lastCheckAt: null,
  lastCheckpoint: null,
  consecutiveLargeWal: 0,
  writeLockOk: null,
  writeLockProbeMs: null,
  consecutiveWriteFailures: 0,
  poolResetAt: null,
  poolRearmFailed: false,
  rearmAttempts: 0,
};

let lastSentryAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let writeTimer: ReturnType<typeof setInterval> | null = null;
let lastWriteAlertAt = 0;
let writeProbeInFlight = false;
// One-way latch: a restart has been ordered and the exit is already armed.
let restartRequested = false;
let lastPoolAlertAt = 0;

// Backup-staleness — rides the same 5-min tick. A failure-only alert can't see a
// WEDGED backup cron that never fires (it leaves yesterday's `ok` sidecar), so we
// check the AGE of the newest backup. Daily backup runs ~07:10 UTC; 26h = +2h grace.
const BACKUP_STALE_MS = 26 * 60 * 60 * 1000;
let lastBackupAlertAt = 0;

/**
 * Pure staleness check (unit-tested). Stale when there is no backup, the last one
 * FAILED, or the newest is older than BACKUP_STALE_MS.
 */
export function isBackupStale(status: LastBackupStatus | null, nowMs: number): { stale: boolean; detail: string } {
  if (!status) return { stale: true, detail: 'no backup status found — has a backup ever completed?' };
  const ageMs = nowMs - new Date(status.at).getTime();
  const ageH = Number.isFinite(ageMs) ? (ageMs / 3_600_000).toFixed(1) : 'unknown';
  if (!status.ok) return { stale: true, detail: `last backup FAILED at ${status.at} (age ${ageH}h): ${status.note}` };
  // An unparseable timestamp is suspicious — treat as stale rather than silently fresh.
  if (!Number.isFinite(ageMs)) return { stale: true, detail: `unparseable backup timestamp "${status.at}"` };
  if (ageMs > BACKUP_STALE_MS) return { stale: true, detail: `newest backup is ${ageH}h old (at ${status.at}) — daily backup may be wedged` };
  return { stale: false, detail: `ok, ${ageH}h old` };
}

function checkBackupStaleness(): void {
  let result: { stale: boolean; detail: string };
  try {
    result = isBackupStale(getLastBackupStatus(), Date.now());
  } catch {
    return; // never let the backup check break the WAL watchdog
  }
  if (result.stale && Date.now() - lastBackupAlertAt >= SENTRY_THROTTLE_MS) {
    lastBackupAlertAt = Date.now();
    console.warn(`[BackupWatchdog] STALE: ${result.detail}`);
    try {
      Sentry.captureMessage('[Backup] no fresh backup — daily backup may be wedged or failing', {
        level: 'error',
        tags: { component: 'backup' },
        extra: { detail: result.detail },
      });
    } catch { /* Sentry not initialised */ }
  }
}

function walPath(): string {
  return `${DB_PATH}-wal`;
}

export type WriteLockAction = 'none' | 'reset' | 'restart';

/**
 * Self-heal is production-only and opt-out. In dev and under tests a
 * `process.exit` on a contended lock would be actively hostile, and the failure
 * this treats — a holder that never releases across a 46-hour uptime — does not
 * occur there in the first place.
 */
function isSelfHealEnabled(): boolean {
  // Case-folded, and generous about what "off" looks like: this is the
  // emergency brake on a feature that kills production, and it gets typed by a
  // human mid-incident. An exact-match-'off' brake that silently ignores
  // `=OFF`, `=false` or `=0` is a brake that fails when it is needed.
  const flag = (process.env.DB_WRITE_LOCK_SELF_HEAL ?? '').trim().toLowerCase();
  if (['off', 'false', '0', 'no', 'disabled'].includes(flag)) return false;
  return process.env.NODE_ENV === 'production';
}

/**
 * Ledger of self-restarts, on the persistent volume so it survives the very
 * restarts it counts. Same placement logic as index.ts's boot-repair markers.
 */
function selfRestartLedgerPath(): string {
  const base = process.env.RAILWAY_VOLUME_MOUNT_PATH
    || (fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'prisma'));
  return path.join(base, '.write-lock-self-restarts.json');
}

/** Restart timestamps inside the rolling window. Never throws — a ledger that
 *  cannot be read must not become a reason the watchdog stops working. */
export function readSelfRestartLedger(nowMs: number = Date.now()): number[] {
  try {
    const raw = fs.readFileSync(selfRestartLedgerPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
      .filter(t => nowMs - t <= SELF_RESTART_WINDOW_MS);
  } catch {
    return []; // no ledger yet, unreadable, or corrupt — treat as no restarts
  }
}

function recordSelfRestart(nowMs: number = Date.now()): void {
  try {
    const next = [...readSelfRestartLedger(nowMs), nowMs];
    fs.writeFileSync(selfRestartLedgerPath(), JSON.stringify(next), 'utf8');
  } catch (e) {
    // Losing the ledger costs the budget, not the restart — but say so, because
    // a silently unwritable ledger means the budget is not really enforced.
    console.error(`[WriteWatchdog] could not record self-restart in the ledger: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * What should the watchdog DO about an ongoing write-lock outage?
 *
 * Pure, and exported, so the escalation ladder can be unit-tested — the
 * alternative is logic whose only proof is killing the process.
 */
export function decideWriteLockAction(input: {
  consecutiveFailures: number;
  detail: string;
  selfHealEnabled: boolean;
  poolAlreadyReset: boolean;
  poolRearmFailed: boolean;
  rearmAttempts: number;
  restartsInWindow: number;
}): { action: WriteLockAction; reason: string } {
  if (!input.selfHealEnabled) {
    return { action: 'none', reason: 'self-heal disabled' };
  }
  const detail = input.detail.toLowerCase();
  // A missing database file is not lock contention, and no restart remounts a
  // volume. Kept as its own branch ahead of the signature check purely so the
  // alert says which impossible thing happened.
  if (detail.includes('does not exist')) {
    return { action: 'none', reason: 'database file missing — a restart cannot remount a volume' };
  }
  const budgetSpent = input.restartsInWindow >= SELF_RESTART_BUDGET;
  const standDown = (): { action: WriteLockAction; reason: string } => ({
    action: 'none',
    reason: `self-restart budget spent (${input.restartsInWindow} in the last `
      + `${SELF_RESTART_WINDOW_MS / 3_600_000}h) — escalating to a human instead of rebooting again`,
  });

  // An un-armed pool is its own escalation path: writers have no busy_timeout,
  // which is worse than the wedge and outlives it. It still goes through this
  // function rather than around it, so the budget applies here too — a re-arm
  // that can never succeed must not become an unbounded restart loop.
  //
  // Deliberately ABOVE the signature gate. An un-armed pool is a property of
  // THIS PROCESS, not of whatever the probe last failed on: if the lock clears
  // and the next failure is something else entirely, the pool is still un-armed
  // and the escalation must not be dropped on the way past.
  if (input.poolRearmFailed) {
    if (input.rearmAttempts < POOL_REARM_MAX_ATTEMPTS) {
      return {
        action: 'reset',
        reason: `pool re-arm failed (attempt ${input.rearmAttempts} of ${POOL_REARM_MAX_ATTEMPTS}) — retrying before escalating`,
      };
    }
    if (budgetSpent) return standDown();
    return {
      action: 'restart',
      reason: `pool re-arm failed ${input.rearmAttempts}× — writers have no busy_timeout and it cannot be repaired in place`,
    };
  }

  // Fail closed: act ONLY on the wedge signature. Everything else — read-only
  // volume, disk full, corruption — is a fault the ladder cannot fix and would
  // make worse by restarting through it.
  if (!WEDGE_SIGNATURES.some(sig => detail.includes(sig))) {
    return {
      action: 'none',
      reason: 'failure does not match the write-lock wedge signature — self-heal cannot fix this fault',
    };
  }

  // Restart is checked first so an outage that survives its reset keeps climbing
  // instead of re-resetting a pool that has already been proven not to help.
  if (input.consecutiveFailures >= WRITE_PROBE_RESTART_AFTER && input.poolAlreadyReset) {
    if (budgetSpent) return standDown();
    return {
      action: 'restart',
      reason: `${input.consecutiveFailures} consecutive failed probes and the pool reset did not clear it`,
    };
  }
  if (input.consecutiveFailures >= WRITE_PROBE_RESET_AFTER && !input.poolAlreadyReset) {
    return {
      action: 'reset',
      reason: `${input.consecutiveFailures} consecutive failed probes — dropping the Prisma pool`,
    };
  }
  return { action: 'none', reason: 'below escalation threshold' };
}

interface LockSuspects {
  inFlightJobs: Array<{ name: string; ageMs: number }>;
  inFlightRequests: InFlightRequestRow[];
}

/**
 * Everything this process knows about who might be sitting on the write lock.
 *
 * SQLite cannot name a lock holder — there is no `PRAGMA` for it — so the only
 * available answer is application-side: what was already running when writes
 * stopped. On 2026-08-22 every actor in the logs was a victim timing out on
 * acquire, and reconstructing even that much took an hour of log archaeology.
 */
function captureLockSuspects(): LockSuspects {
  let inFlightJobs: LockSuspects['inFlightJobs'] = [];
  let inFlightRequests: LockSuspects['inFlightRequests'] = [];
  // Forensics must never be the reason an alert or a self-heal fails to fire.
  try { inFlightJobs = getInFlightJobs().slice(0, 10); } catch { /* best effort */ }
  try { inFlightRequests = getInFlightRequests().slice(0, 10); } catch { /* best effort */ }
  return { inFlightJobs, inFlightRequests };
}

/**
 * Log suspects as well as attaching them to Sentry. On a self-heal restart the
 * console line is what survives, and on 2026-08-22 the Railway logs outlived the
 * Sentry issue's usefulness anyway.
 */
function logLockSuspects(suspects: LockSuspects): void {
  const secs = (ms: number): string => `${Math.round(ms / 1000)}s`;
  const jobs = suspects.inFlightJobs.map(j => `${j.name}(${secs(j.ageMs)})`).join(', ') || 'none';
  // The 504'd-but-still-running rows are the interesting ones, so mark them
  // rather than letting them read as ordinary open requests.
  const reqs = suspects.inFlightRequests
    .slice(0, 5)
    .map(r => `${r.request}(${secs(r.ageMs)}${r.responded ? ', responded' : ''})`)
    .join(', ') || 'none';
  console.error(`[WriteWatchdog] lock suspects — jobs: ${jobs} | requests: ${reqs}`);
}

/**
 * Drop Prisma's connection pool, then rebuild it WITH its pragmas.
 *
 * The re-arm is not optional. `busy_timeout` is per-connection SQLite state —
 * unlike journal_mode and auto_vacuum, which live in the database header — and
 * it dies with the pool. initSqlitePragmas has exactly one other caller, at
 * boot, so a bare $disconnect would leave every subsequent writer running at
 * libsql's default busy_timeout of 0.0: instant SQLITE_BUSY on microseconds of
 * ordinary contention, process-wide, permanently, and invisible to this probe
 * (which uses its own connection with its own timeout). That is strictly worse
 * than the outage being treated, so a reset that cannot re-arm reports failure
 * and the caller escalates.
 */
async function resetPrismaPool(): Promise<{ ok: boolean; detail: string }> {
  let bound: ReturnType<typeof setTimeout> | undefined;
  let raceError = '';
  try {
    await Promise.race([
      (async () => {
        await prisma.$disconnect();
        await prisma.$connect();
        await initSqlitePragmas();
      })(),
      new Promise<never>((_, reject) => {
        bound = setTimeout(
          () => reject(new Error(`pool reset did not return within ${POOL_RESET_TIMEOUT_MS}ms`)),
          POOL_RESET_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (e) {
    raceError = e instanceof Error ? e.message : String(e);
  } finally {
    if (bound) clearTimeout(bound);
  }

  // Ask the database, don't trust the stopwatch. Losing the race does not cancel
  // the work — the re-arm may well land a moment after the cap — and this
  // verdict now feeds a decision that can kill the process, so "slow" must not
  // be indistinguishable from "failed".
  const armed = await verifyPoolArmed();
  if (armed) {
    return {
      ok: true,
      detail: raceError
        ? `pool re-armed despite the reset overrunning (${raceError})`
        : 'pool reconnected with busy_timeout re-armed',
    };
  }
  return { ok: false, detail: raceError || 'busy_timeout did not read back as re-armed' };
}

/** Read busy_timeout back off the live pool. Bounded, and never throws. */
async function verifyPoolArmed(): Promise<boolean> {
  let bound: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      prisma.$queryRawUnsafe<Array<Record<string, unknown>>>('PRAGMA busy_timeout'),
      new Promise<never>((_, reject) => {
        bound = setTimeout(() => reject(new Error('read-back timed out')), POOL_REARM_VERIFY_TIMEOUT_MS);
      }),
    ]);
    // SQLite names the column "timeout", but read positionally as well rather
    // than depending on that.
    const value = Object.values(rows?.[0] ?? {})[0];
    // Strict about the VALUE, permissive about its REPRESENTATION. Prisma raw
    // queries through a driver adapter can hand back BigInt for integer columns,
    // and a `typeof === 'number'` test would read a perfectly re-armed pool as
    // un-armed — then retry, then kill a healthy process over a JS type tag.
    const n = Number(value);
    return Number.isFinite(n) && n > 0;
  } catch {
    return false;
  } finally {
    if (bound) clearTimeout(bound);
  }
}

/**
 * Exit non-zero and let the platform start a clean container.
 *
 * No graceful shutdown: the normal path drains by writing to the database, which
 * is precisely what is impossible here, so it would hang until the hard-exit
 * timer fired anyway. Crash-loop risk is bounded by construction — a fresh
 * process must fail WRITE_PROBE_RESTART_AFTER consecutive probes before it can
 * reach this again, i.e. at most one restart per ~10 minutes.
 */
async function restartForWedgedWriteLock(reason: string, suspects: LockSuspects): Promise<void> {
  // Latch. Nothing else stops a subsequent 60s tick from re-entering here if the
  // flush below never settles, which would post one `fatal` event per minute
  // and still never exit.
  if (restartRequested) return;
  restartRequested = true;

  console.error(`[WriteWatchdog] SELF-HEAL RESTART: ${reason}. Exiting so the platform starts a clean container.`);

  // Arm the exit FIRST, the same way app.ts's uncaughtException handler does.
  // Everything below it can block: Sentry.flush's own timeout is not a
  // guarantee, and recordSelfRestart is a synchronous write to the very volume
  // that may be wedged or full. An exit that depends on either of those
  // completing is not an exit.
  setTimeout(() => process.exit(1), 3000).unref();
  recordSelfRestart();

  try {
    Sentry.captureMessage('[DB] self-heal restart — the SQLite write lock never released', {
      level: 'fatal',
      tags: { component: 'write-liveness' },
      extra: { reason, ...suspects, processUptimeSec: Math.round(process.uptime()) },
    });
    // Without the flush the exit races the transport and the restart — the one
    // event that explains the gap in the logs — never reaches Sentry.
    await Sentry.flush(2000);
  } catch { /* Sentry not initialised */ }
  process.exit(1);
}

/** Ask the ladder what to do, given the current state and this probe's error. */
function decideFromState(detail: string): { action: WriteLockAction; reason: string } {
  // Read the ledger only once something could actually act on it: this is a
  // synchronous volume read on the event loop, during an incident in which the
  // volume itself may be part of the problem.
  const couldEscalate = state.consecutiveWriteFailures >= WRITE_PROBE_RESET_AFTER || state.poolRearmFailed;
  return decideWriteLockAction({
    consecutiveFailures: state.consecutiveWriteFailures,
    detail,
    selfHealEnabled: isSelfHealEnabled(),
    poolAlreadyReset: state.poolResetAt !== null,
    poolRearmFailed: state.poolRearmFailed,
    rearmAttempts: state.rearmAttempts,
    restartsInWindow: couldEscalate ? readSelfRestartLedger().length : 0,
  });
}

/** Carry out whatever the ladder decided. The single executor for both callers. */
async function applySelfHealAction(action: WriteLockAction, reason: string): Promise<void> {
  const suspects = captureLockSuspects();
  logLockSuspects(suspects);

  if (action === 'reset') {
    // Latch BEFORE awaiting: the probe's in-flight guard is already released by
    // this point, so an overlapping tick could otherwise reset the pool twice
    // and then never escalate past it.
    state.poolResetAt ??= new Date().toISOString();
    state.rearmAttempts += 1;
    const result = await resetPrismaPool();
    // Record the outcome and let the NEXT tick's decision escalate. Restarting
    // from here would route around decideWriteLockAction — and therefore around
    // the self-restart budget — which is the whole reason that function is pure
    // and exported.
    state.poolRearmFailed = !result.ok;
    console.error(`[WriteWatchdog] SELF-HEAL RESET: ${reason} — ${result.detail}`);
    return;
  }

  await restartForWedgedWriteLock(reason, suspects);
}

/** Run the escalation ladder for an ongoing outage. No-op until a threshold trips. */
async function maybeSelfHeal(detail: string): Promise<void> {
  const { action, reason } = decideFromState(detail);
  if (action === 'none') {
    // Log the refusals that are decisions rather than "nothing to do here" —
    // a budget-exhausted or wrong-signature outage is a thing a human needs to
    // know the watchdog deliberately declined to fix.
    if (state.consecutiveWriteFailures >= WRITE_PROBE_RESET_AFTER) {
      console.error(`[WriteWatchdog] self-heal standing down: ${reason}`);
    }
    return;
  }
  await applySelfHealAction(action, reason);
}

/**
 * Called when the write lock recovers while a pool re-arm is outstanding.
 *
 * A successful probe says the LOCK cleared. It says nothing about whether the
 * app's Prisma pool came back armed, because the probe runs on its own dedicated
 * connection and cannot see the pool at all — the two are independent facts.
 *
 * That distinction matters most on the reset's most LIKELY success path: the
 * $disconnect drops the leaked adapter connection (which is the whole
 * hypothesis, so the lock releases) and then $connect or the pragmas fail. The
 * next probe passes on its own connection. Clearing the flag there would leave
 * every writer at busy_timeout=0 for the rest of the uptime — the exact outcome
 * the escalation exists to prevent, reached by the reset working.
 */
async function reconcilePoolArming(): Promise<void> {
  if (await verifyPoolArmed()) {
    console.warn('[WriteWatchdog] pool re-arm confirmed after the write lock recovered');
    state.poolRearmFailed = false;
    state.rearmAttempts = 0;
    return;
  }
  // Still un-armed. Same ladder, same budget — an empty detail is correct here
  // because there is no current probe failure; the poolRearmFailed branch sits
  // above the signature gate precisely so this case is not filtered out.
  const { action, reason } = decideFromState('');
  if (action === 'none') {
    console.error(`[WriteWatchdog] pool is still un-armed after recovery and self-heal is standing down: ${reason}`);
    // This is the worst steady state in the whole design — the process keeps
    // running with every writer at busy_timeout=0, process-wide, indefinitely —
    // and it is the one state the write-lock alert cannot cover: that alert
    // lives in the probe's FAILURE branch, and here the probe is SUCCEEDING.
    // The lock is fine; the pool is broken. Without this, "escalating to a
    // human" escalates to a console line nobody is watching.
    if (Date.now() - lastPoolAlertAt >= SENTRY_THROTTLE_MS) {
      lastPoolAlertAt = Date.now();
      try {
        Sentry.captureMessage('[DB] pool is un-armed and self-heal has stood down — writers have no busy_timeout', {
          level: 'fatal',
          tags: { component: 'write-liveness' },
          extra: { reason, rearmAttempts: state.rearmAttempts, processUptimeSec: Math.round(process.uptime()) },
        });
      } catch { /* Sentry not initialised */ }
    }
    return;
  }
  await applySelfHealAction(action, reason);
}

/**
 * Can anything acquire the SQLite write lock right now?
 *
 * `BEGIN IMMEDIATE` takes the write lock without writing anything, and the
 * immediate `ROLLBACK` releases it — so the probe answers the question without
 * itself becoming a writer that could starve the app.
 *
 * Runs on a DEDICATED libsql connection, never the shared Prisma client: if the
 * app's pool is saturated the probe would queue behind application queries and
 * measure pool pressure instead of lock availability. Same reasoning as
 * backup.service's VACUUM INTO connection.
 *
 * KNOWN BLIND SPOT, accepted deliberately: because the connection is fresh, this
 * cannot see Prisma POOL exhaustion — a state where the app can't write but a
 * new connection can. It answers "is the write lock obtainable", which is the
 * failure mode of the 2026-07-25 outage, not "can the app write". Pool
 * saturation needs a separate signal.
 */
export async function runWriteLivenessProbeOnce(): Promise<void> {
  // setInterval does not await. If a probe ever outlives its tick (connection
  // open has no timeout of its own), overlapping runs would each increment
  // consecutiveWriteFailures and trip the alert threshold early.
  if (writeProbeInFlight) return;
  writeProbeInFlight = true;

  const startedAt = Date.now();
  let client: ReturnType<typeof createClient> | null = null;
  let ok = false;
  let detail = '';
  try {
    // A MISSING database is a failure, never a success. createClient would
    // otherwise CREATE an empty file here, trivially win the lock on it, and
    // report healthy forever — e.g. if the Railway volume failed to mount, the
    // real database would be gone while this said everything was fine. That is
    // the textbook way monitoring lies.
    if (!fs.existsSync(RESOLVED_DB_FILE)) {
      throw new Error(`database file does not exist at ${RESOLVED_DB_FILE} — volume not mounted?`);
    }
    // RESOLVED_DB_FILE, not backup.service's DB_PATH: the two diverge in dev
    // (<root>/dev.db vs <root>/prisma/dev.db) and probing a different database
    // than the app uses would make this monitor structurally meaningless.
    client = createClient({ url: `file:${RESOLVED_DB_FILE}` });
    // Load-bearing: libsql's own connection default is 0.0, so without this the
    // probe becomes a hair-trigger that fails on microseconds of normal
    // contention. Must precede BEGIN IMMEDIATE.
    await client.execute(`PRAGMA busy_timeout = ${WRITE_PROBE_BUSY_MS}`);
    await client.execute('BEGIN IMMEDIATE');
    await client.execute('ROLLBACK');
    ok = true;
  } catch (e) {
    // Fold the driver's error CODE in, not just its message. This string now
    // decides whether self-heal is allowed to act, and libsql's LibsqlError.code
    // (SQLITE_BUSY, SQLITE_READONLY, ...) is a far more stable discriminator
    // than message wording that a dependency bump can reword.
    const code = (e as { code?: unknown })?.code;
    const message = e instanceof Error ? e.message : String(e);
    detail = typeof code === 'string' && code ? `${code}: ${message}` : message;
  } finally {
    // Log rather than swallow: this is the ONE path where the probe itself could
    // retain the write lock it just took.
    try { client?.close(); } catch (e) {
      console.error(`[WriteWatchdog] failed to close probe connection: ${e instanceof Error ? e.message : e}`);
    }
    writeProbeInFlight = false;
  }

  const probeMs = Date.now() - startedAt;
  state.writeLockOk = ok;
  state.writeLockProbeMs = probeMs;

  if (ok) {
    if (state.consecutiveWriteFailures > 0) {
      // Whether a pool reset preceded the recovery is the most useful single bit
      // for the next incident: it separates "the holder was a leaked connection
      // in this process" from "it cleared on its own", which is exactly the
      // question two post-mortems have now failed to answer.
      const healed = state.poolResetAt ? ` (after the pool reset at ${state.poolResetAt})` : '';
      console.warn(`[WriteWatchdog] write lock RECOVERED after ${state.consecutiveWriteFailures} failed probe(s) (${probeMs}ms)${healed}`);
      // Clear the throttle on recovery. Otherwise a SECOND, distinct outage
      // inside the same hour would be silently suppressed by the throttle that
      // was meant only to stop one ongoing outage from spamming.
      lastWriteAlertAt = 0;
    }
    state.consecutiveWriteFailures = 0;
    if (state.poolRearmFailed) {
      // Verify, never assume: this probe's success is evidence about the lock,
      // not about the pool. See reconcilePoolArming.
      await reconcilePoolArming();
    }
    // Clear the reset latch only once the pool is actually confirmed healthy —
    // AFTER the reconcile, not before it. Clearing first let a reconcile-driven
    // reset immediately re-set poolResetAt, so a wedge on the very next tick
    // would see poolAlreadyReset and skip straight to restart with no cheap
    // step, contradicting the invariant this field's own doc-comment promises.
    if (!state.poolRearmFailed) {
      state.poolResetAt = null;
      state.rearmAttempts = 0;
    }
    return;
  }

  state.consecutiveWriteFailures += 1;
  console.error(
    `[WriteWatchdog] CANNOT acquire write lock after ${probeMs}ms: ${detail} ` +
      `(consecutive=${state.consecutiveWriteFailures})`,
  );

  // Escalation runs BEFORE the alert's early-returns below. After them, the
  // Sentry throttle — a noise control — would silently disable recovery for the
  // remaining 59 minutes of an outage.
  await maybeSelfHeal(detail);

  if (state.consecutiveWriteFailures < WRITE_PROBE_ALERT_AFTER) return;
  if (Date.now() - lastWriteAlertAt < SENTRY_THROTTLE_MS) return;
  lastWriteAlertAt = Date.now();

  // These two extras are what actually identified the 2026-07-25 incident after
  // the fact: a 0-byte WAL meant the holder wrote nothing, and an uptime of ~91s
  // meant it started during boot. Capture them at alert time so the NEXT
  // occurrence is diagnosable without archaeology.
  let walBytes: number | null = null;
  try { walBytes = fs.existsSync(walPath()) ? fs.statSync(walPath()).size : 0; } catch { /* ignore */ }

  // Who was running when writes stopped. The 2026-08-22 alert carried none of
  // this, so identifying even the victims meant pulling the dead deployment's
  // logs by hand before they aged out.
  const suspects = captureLockSuspects();
  logLockSuspects(suspects);

  try {
    Sentry.captureMessage('[DB] cannot acquire the SQLite write lock — writes are stalled', {
      level: 'error',
      tags: { component: 'write-liveness' },
      extra: {
        detail,
        probeMs,
        consecutiveFailures: state.consecutiveWriteFailures,
        walBytes,
        processUptimeSec: Math.round(process.uptime()),
        ...suspects,
      },
    });
  } catch { /* Sentry not initialised */ }
}

export function getWalWatchdogState(): Readonly<WatchdogState> {
  return state;
}

export async function runWalWatchdogOnce(): Promise<void> {
  // Backup-staleness rides this tick and must run regardless of WAL size (the
  // WAL block below early-returns when the WAL is small).
  checkBackupStaleness();

  state.lastCheckAt = new Date().toISOString();
  let walBytes: number | null = null;
  try {
    walBytes = fs.existsSync(walPath()) ? fs.statSync(walPath()).size : 0;
  } catch {
    walBytes = null;
  }
  state.walBytes = walBytes;
  if (walBytes === null || walBytes < WAL_WARN_BYTES) {
    state.consecutiveLargeWal = 0;
    return;
  }

  // WAL is large — try to drain passively (never blocks writers; a PASSIVE
  // checkpoint against a pinned reader just backfills what it can).
  let row: CheckpointRow | null = null;
  try {
    const rows = await prisma.$queryRawUnsafe<CheckpointRow[]>('PRAGMA wal_checkpoint(PASSIVE)');
    row = rows?.[0] ?? null;
  } catch (e) {
    console.warn(`[WalWatchdog] passive checkpoint failed: ${(e as Error).message}`);
  }
  state.lastCheckpoint = row;

  // File size alone can't distinguish "high-water mark from a past incident"
  // from "actively pinned": the WAL file never shrinks without TRUNCATE. The
  // live signal is un-backfilled frames (log - checkpointed) staying high.
  const pinnedFrames = row ? row.log - row.checkpointed : null;
  const looksStarved = pinnedFrames === null || pinnedFrames > 1000;
  state.consecutiveLargeWal = looksStarved ? state.consecutiveLargeWal + 1 : 0;

  console.warn(
    `[WalWatchdog] WAL ${(walBytes / 1024 / 1024).toFixed(0)}MB; checkpoint ` +
      (row ? `busy=${row.busy} log=${row.log} checkpointed=${row.checkpointed}` : 'unavailable') +
      ` (consecutive-starved=${state.consecutiveLargeWal})`,
  );

  if (state.consecutiveLargeWal >= 2 && Date.now() - lastSentryAt >= SENTRY_THROTTLE_MS) {
    lastSentryAt = Date.now();
    try {
      Sentry.captureMessage('[DB] WAL checkpoint starvation — a long-lived reader is pinning the WAL', {
        level: 'error',
        tags: { component: 'wal-watchdog' },
        extra: { walBytes, checkpoint: row },
      });
    } catch { /* Sentry not initialised */ }
  }
}

export function startWalWatchdog(): void {
  if (timer) return;
  state.enabled = true;
  timer = setInterval(() => { void runWalWatchdogOnce(); }, CHECK_INTERVAL_MS);
  timer.unref();
  // Separate, faster timer: a write-lock outage kills snapshots and logins, so
  // ~3min detection beats riding the 5-min WAL tick (~10min).
  writeTimer = setInterval(() => { void runWriteLivenessProbeOnce(); }, WRITE_PROBE_INTERVAL_MS);
  writeTimer.unref();
  // Probe once immediately. Interval-only would leave a wedge that is ALREADY
  // present at startup unreported for 3+ minutes — and boot is exactly when the
  // 2026-07-25 incident began.
  void runWriteLivenessProbeOnce();
  console.log(
    `[WalWatchdog] Started (every ${CHECK_INTERVAL_MS / 60000}min, warn at ${WAL_WARN_BYTES / 1024 / 1024}MB); ` +
      `write-liveness probe every ${WRITE_PROBE_INTERVAL_MS / 1000}s (alert after ${WRITE_PROBE_ALERT_AFTER} consecutive failures); ` +
      `self-heal ${isSelfHealEnabled()
        ? `ON (pool reset at ${WRITE_PROBE_RESET_AFTER}, restart at ${WRITE_PROBE_RESTART_AFTER})`
        : 'OFF'}`,
  );
}

export function stopWalWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (writeTimer) clearInterval(writeTimer);
  writeTimer = null;
  state.enabled = false;
}
