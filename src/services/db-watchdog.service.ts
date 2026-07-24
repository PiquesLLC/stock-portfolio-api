import * as fs from 'fs';
import * as Sentry from '@sentry/node';
import prisma from '../utils/prisma';
import { DB_PATH, getLastBackupStatus, LastBackupStatus } from './backup.service';

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

interface CheckpointRow { busy: number; log: number; checkpointed: number }

interface WatchdogState {
  enabled: boolean;
  walBytes: number | null;
  lastCheckAt: string | null;
  lastCheckpoint: CheckpointRow | null;
  consecutiveLargeWal: number;
}

const state: WatchdogState = {
  enabled: false,
  walBytes: null,
  lastCheckAt: null,
  lastCheckpoint: null,
  consecutiveLargeWal: 0,
};

let lastSentryAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;

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
  console.log(`[WalWatchdog] Started (every ${CHECK_INTERVAL_MS / 60000}min, warn at ${WAL_WARN_BYTES / 1024 / 1024}MB)`);
}

export function stopWalWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = null;
  state.enabled = false;
}
