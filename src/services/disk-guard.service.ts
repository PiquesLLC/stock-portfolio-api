import * as fs from 'fs';
import * as Sentry from '@sentry/node';
import prisma from '../utils/prisma';
import { config } from '../config';
import { DB_PATH, BACKUP_DIR, getDataVolumeFreeBytes, pruneBackupsToKeep, backupDatabase } from './backup.service';
import { cleanupStaleData } from './cleanup.service';

/**
 * Disk self-healing guard.
 *
 * The prod DB is SQLite on a fixed Railway volume (/data). Two failure modes:
 *  - unbounded table growth (now bounded by cleanupStaleData retention), and
 *  - the file never shrinking after deletes (auto_vacuum was NONE; now INCREMENTAL
 *    via initSqlitePragmas, which takes effect after the first VACUUM below).
 *
 * This job runs periodically. When /data crosses WARN%, it prunes. At CRITICAL%
 * it additionally reclaims: it frees the redundant daily backup (a same-day copy
 * of the live DB — the live DB is the source of truth) to make room, runs VACUUM
 * (which both shrinks the file AND one-time-converts it to auto_vacuum=INCREMENTAL),
 * then regenerates a fresh, now-small backup. If it is STILL critical afterward,
 * the situation is genuinely unfixable in-app (too much live data for the volume)
 * and it fires a cooldown-gated alert so a human can grow the volume.
 *
 * The heavy reclaim (delete-backup + VACUUM) and the alert are both gated by a
 * cooldown PERSISTED on /data, so a flapping/looping pod can't re-VACUUM, churn the
 * backup, or spam alerts on every restart. VACUUM only runs with the same
 * `free >= 1.2x DB` headroom guard the admin cleanup endpoint uses (the Apr-26
 * incident showed VACUUM at tight disk hangs).
 */

interface DiskStatus {
  totalMB: number;
  freeMB: number;
  usedPercent: number;
  dbMB: number;
}

function getDiskStatus(): DiskStatus | null {
  if (!fs.existsSync('/data')) return null; // local dev — no volume
  try {
    const st = fs.statfsSync('/data');
    const total = st.bsize * st.blocks;
    const free = st.bsize * st.bavail;
    const usedPercent = total > 0 ? Math.round(((total - free) / total) * 100) : 0;
    let dbMB = 0;
    try { dbMB = Math.round(fs.statSync(DB_PATH).size / 1048576); } catch { /* DB path may differ in dev */ }
    return { totalMB: Math.round(total / 1048576), freeMB: Math.round(free / 1048576), usedPercent, dbMB };
  } catch {
    return null;
  }
}

/** Chunked HoldingSnapshot prune (keep last `days`), looped until drained. Bounded WAL. */
async function pruneHoldingSnapshots(days: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < 4000; i++) {
    const n = await prisma.$executeRawUnsafe(
      `DELETE FROM "HoldingSnapshot" WHERE rowid IN (SELECT rowid FROM "HoldingSnapshot" WHERE "timestamp" < datetime('now', '-${days} days') LIMIT 5000)`
    );
    total += n;
    if (n < 5000) break;
  }
  return total;
}

// Cooldown state persisted on /data so a flapping/looping pod doesn't re-run the heavy
// reclaim or re-alert on every boot. In dev (no /data) read/write no-op and the guard
// is inert anyway (getDiskStatus returns null).
const STATE_PATH = '/data/.disk-guard-state.json';
const RECLAIM_COOLDOWN_MS = 60 * 60 * 1000; // at most one heavy reclaim (delete-backup + VACUUM) per hour
interface GuardState { lastReclaimAt: number; lastAlertAt: number; }
function loadState(): GuardState {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return { lastReclaimAt: Number(s.lastReclaimAt) || 0, lastAlertAt: Number(s.lastAlertAt) || 0 };
  } catch {
    return { lastReclaimAt: 0, lastAlertAt: 0 };
  }
}
function saveState(s: GuardState): void {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s)); } catch { /* best-effort */ }
}

export async function runDiskGuard(): Promise<void> {
  const before = getDiskStatus();
  if (!before) return;                                 // no /data (dev): no-op
  if (before.usedPercent < config.diskWarnPct) return; // healthy

  const state = loadState();
  console.warn(`[DiskGuard] usedPercent=${before.usedPercent}% freeMB=${before.freeMB} dbMB=${before.dbMB} (warn=${config.diskWarnPct} critical=${config.diskCriticalPct}) — self-healing`);

  // 1) Standard retention prune (safe; 90-day windows). Includes incremental_vacuum.
  try {
    await cleanupStaleData();
  } catch (e) {
    console.error('[DiskGuard] cleanupStaleData failed:', (e as Error).message);
  }

  // 2) At CRITICAL: heavy reclaim (aggressive prune + VACUUM), at most once per hour to
  //    avoid back-to-back VACUUM/backup churn if the disk stays critical.
  if (before.usedPercent >= config.diskCriticalPct) {
    if (Date.now() - state.lastReclaimAt < RECLAIM_COOLDOWN_MS) {
      console.warn('[DiskGuard] heavy reclaim ran within the last hour — skipping VACUUM/backup churn this tick');
    } else {
      try {
        const pruned = await pruneHoldingSnapshots(7);
        console.warn(`[DiskGuard] aggressive prune: HoldingSnapshot >7d deleted=${pruned}`);
        await prisma.$executeRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});

        const dbBytes = (() => { try { return fs.statSync(DB_PATH).size; } catch { return 0; } })();
        let free = getDataVolumeFreeBytes();

        // VACUUM needs temp headroom. If too tight, free the redundant daily backup
        // (live DB is the source of truth) — it is regenerated immediately after.
        if (free !== null && dbBytes > 0 && free < dbBytes * 1.2) {
          const res = pruneBackupsToKeep(0);
          console.warn(`[DiskGuard] freed backups for VACUUM headroom: deleted=${res.deleted} freedMB=${res.freedMB}`);
          free = getDataVolumeFreeBytes();
        }

        if (free !== null && dbBytes > 0 && free >= dbBytes * 1.2) {
          console.warn('[DiskGuard] running VACUUM (shrinks file + converts to auto_vacuum=INCREMENTAL)...');
          await prisma.$executeRawUnsafe('VACUUM');
          console.warn('[DiskGuard] VACUUM complete');
          // Regenerate a fresh (now-small) backup to close the no-backup window we opened by
          // deleting the prior backup above. If it does NOT reappear (e.g. backup skipped on
          // still-low disk), surface it LOUDLY — a missing prod backup must never be silent.
          try { await backupDatabase(); } catch (e) { console.error('[DiskGuard] post-VACUUM backup failed:', (e as Error).message); }
          try {
            const haveBackup = fs.existsSync(BACKUP_DIR) && fs.readdirSync(BACKUP_DIR).some(f => /^nala-\d{4}-\d{2}-\d{2}\.db$/.test(f));
            if (!haveBackup) {
              console.error('[DiskGuard] CRITICAL: reclaim left NO daily backup on /data — regenerate ASAP');
              try { Sentry.captureMessage('[DiskGuard] CRITICAL: no daily backup after reclaim', { level: 'error', tags: { component: 'disk_guard' } }); } catch { /* */ }
            } else {
              console.warn('[DiskGuard] fresh backup regenerated after reclaim');
            }
          } catch { /* best-effort verification */ }
        } else {
          console.warn(`[DiskGuard] VACUUM skipped — insufficient headroom (free=${free} dbBytes=${dbBytes})`);
        }

        state.lastReclaimAt = Date.now();
        saveState(state);
      } catch (e) {
        console.error('[DiskGuard] aggressive reclaim failed:', (e as Error).message);
      }
    }
  } else {
    // WARN level: reclaim freelist pages incrementally (effective once auto_vacuum=INCREMENTAL).
    await prisma.$executeRawUnsafe('PRAGMA incremental_vacuum').catch(() => {});
  }

  // 3) Re-measure; alert if STILL critical (unfixable in-app → needs a bigger volume).
  //    Cooldown persists across restarts so a crash/restart loop can't spam.
  const after = getDiskStatus();
  if (after && after.usedPercent >= config.diskCriticalPct) {
    if (Date.now() - state.lastAlertAt >= config.diskAlertCooldownMs) {
      state.lastAlertAt = Date.now();
      saveState(state);
      const detail = `Disk still ${after.usedPercent}% (${after.freeMB}MB free of ${after.totalMB}MB; DB ${after.dbMB}MB) after auto-cleanup. ACTION REQUIRED: grow the Railway volume.`;
      console.error(`[DiskGuard] CRITICAL/UNFIXABLE — ${detail}`);
      try {
        Sentry.captureMessage('[DiskGuard] CRITICAL: disk full after auto-cleanup', {
          level: 'error',
          tags: { component: 'disk_guard' },
          extra: { before, after },
        });
      } catch { /* Sentry not initialised */ }
    }
  } else if (after) {
    console.log(`[DiskGuard] recovered: ${before.usedPercent}% → ${after.usedPercent}% (freeMB ${before.freeMB} → ${after.freeMB})`);
  }
}
