import * as fs from 'fs';
import * as path from 'path';
import * as Sentry from '@sentry/node';
import { createClient } from '@libsql/client';
import prisma from '../utils/prisma';

export const DB_PATH = process.env.DATABASE_URL?.replace('file:', '') || '/data/nala.db';
export const BACKUP_DIR = process.env.NODE_ENV === 'production' ? '/data/backups' : path.join(process.cwd(), 'prisma', 'backups');
// Each backup ≈ same size as live DB. With a 5GB volume and ~1.4GB DB, keeping
// >1 backup means stable state requires >2× DB-size of free space, which we
// don't have. Lowered from 3 to 1 after Apr 26 incident — see
// railway-volume-cleanup memory. Push to S3/R2 if longer retention is needed.
const MAX_BACKUPS = 1;
const MIN_FREE_SPACE_BYTES = 500 * 1024 * 1024;

// libsql adds these journal/shared-memory sidecar files when opening a DB
// in WAL mode (the production journal_mode). The backup `.db` file inherits
// its source's WAL header, so even briefly opening it (e.g., for quick_check)
// creates these sidecars. We track them so pruning catches them too — without
// this, sidecars from earlier runs accumulate and eat the 5 GB volume.
const SIDECAR_EXTS = ['-wal', '-shm', '-journal'] as const;

// Strict match for date-stamped daily backups ONLY.
// Excludes one-shot snapshots like `nala-pre-cutover-<ISO-ts>.db` which
// the daily prune-to-keep-1 logic must NOT sweep — they're canonical
// rollback targets created by scripts/pre-cutover-snapshot.ts.
const DAILY_BACKUP_REGEX = /^nala-\d{4}-\d{2}-\d{2}\.db$/;

function reportCritical(message: string, extra?: Record<string, unknown>): void {
  console.error(`[Backup] CRITICAL: ${message}`);
  try {
    Sentry.captureMessage(`[Backup] ${message}`, {
      level: 'error',
      tags: { component: 'backup' },
      extra,
    });
  } catch {
    // Sentry not initialised (e.g., tests / dev without DSN) — don't mask the
    // underlying problem.
  }
}

function unlinkSidecars(basePath: string): void {
  for (const ext of SIDECAR_EXTS) {
    const sidecar = basePath + ext;
    if (fs.existsSync(sidecar)) {
      try {
        fs.unlinkSync(sidecar);
      } catch (e) {
        console.warn(`[Backup] sidecar cleanup failed for ${sidecar}: ${(e as Error).message}`);
      }
    }
  }
}

/**
 * Checkpoint the WAL into the main DB file before copying. Without this,
 * recent writes living in `nala.db-wal` would be missing from the snapshot.
 *
 * Uses the existing Prisma libsql connection (rather than a fresh one) so
 * the checkpoint sees the same lock state Prisma sees. PRAGMA wal_checkpoint
 * returns a row `(busy, log, checkpointed)` — busy=1 means SQLite gave up
 * because another writer holds a lock. We log this loudly because the
 * silent-busy case is the worst failure mode (we'd label the snapshot
 * "verified" while it actually missed the last N minutes of writes).
 *
 * Returns true if the WAL was fully drained (busy=0), false if partial.
 * The copy proceeds either way — a partial checkpoint is still better
 * than no checkpoint — but the caller can decide whether to escalate.
 */
// Exported for unit testing. Production callers go through backupDatabase().
export async function checkpointWal(): Promise<{ ok: boolean; busy: number; log: number; checkpointed: number } | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ busy: number; log: number; checkpointed: number }>>(
      'PRAGMA wal_checkpoint(TRUNCATE)',
    );
    const row = rows?.[0];
    if (!row) {
      console.warn('[Backup] WAL checkpoint returned no row');
      return null;
    }
    const ok = row.busy === 0;
    if (!ok) {
      reportCritical(
        `WAL checkpoint INCOMPLETE — busy=${row.busy} log=${row.log} checkpointed=${row.checkpointed}. ` +
          `Snapshot may miss recent writes. Re-run when concurrent writers settle.`,
        { busy: row.busy, log: row.log, checkpointed: row.checkpointed },
      );
    }
    return { ok, ...row };
  } catch (err) {
    console.warn(`[Backup] WAL checkpoint warning: ${(err as Error).message} (continuing with copy)`);
    return null;
  }
}

/**
 * Open the freshly-copied backup file with a sandboxed libsql client and
 * run `PRAGMA quick_check`. Catches obvious corruption (torn page,
 * malformed b-tree) without the wall-clock cost of `integrity_check` on
 * a ~1.4 GB DB. Returns true if intact.
 *
 * The client is closed afterwards; any -wal/-shm sidecars libsql created
 * are cleaned up by the caller via `unlinkSidecars(backupPath)`.
 */
async function verifyBackup(backupPath: string): Promise<boolean> {
  let client: ReturnType<typeof createClient> | null = null;
  try {
    client = createClient({ url: `file:${path.resolve(backupPath)}` });
    const result = await client.execute('PRAGMA quick_check');
    const rows = result.rows;
    const ok = rows.length === 1 && rows[0].quick_check === 'ok';
    if (!ok) {
      reportCritical(
        `quick_check returned ${JSON.stringify(rows)} — backup is suspect.`,
        { path: backupPath, rows },
      );
    }
    return ok;
  } catch (err) {
    reportCritical(`verification failed: ${(err as Error).message}`, { path: backupPath });
    return false;
  } finally {
    try { client?.close(); } catch { /* ignore */ }
  }
}

/**
 * Delete all but the `keep` most recent backups (by filename, which is date-stamped).
 * Returns the list of deleted filenames and the bytes freed. Safe to call from
 * an admin endpoint; does not depend on `backupDatabase()` running.
 *
 * Also sweeps any orphan `-wal`/`-shm`/`-journal` sidecar files for the deleted
 * backups so they don't accumulate on the 5 GB volume.
 */
export function pruneBackupsToKeep(keep: number): { deleted: { name: string; sizeMB: number }[]; freedMB: number; remaining: { name: string; sizeMB: number }[] } {
  const deleted: { name: string; sizeMB: number }[] = [];
  let freedBytes = 0;

  if (!fs.existsSync(BACKUP_DIR)) {
    return { deleted, freedMB: 0, remaining: [] };
  }

  const all = fs.readdirSync(BACKUP_DIR)
    .filter(f => DAILY_BACKUP_REGEX.test(f))
    .sort()
    .reverse();

  for (const name of all.slice(Math.max(0, keep))) {
    const full = path.join(BACKUP_DIR, name);
    try {
      const size = fs.statSync(full).size;
      fs.unlinkSync(full);
      unlinkSidecars(full);
      deleted.push({ name, sizeMB: +(size / 1024 / 1024).toFixed(2) });
      freedBytes += size;
    } catch (e) {
      console.warn(`[Backup] Failed to delete ${name}: ${(e as Error).message}`);
    }
  }

  const remaining = all.slice(0, Math.max(0, keep)).map(name => {
    try {
      const size = fs.statSync(path.join(BACKUP_DIR, name)).size;
      return { name, sizeMB: +(size / 1024 / 1024).toFixed(2) };
    } catch {
      return { name, sizeMB: 0 };
    }
  });

  return { deleted, freedMB: +(freedBytes / 1024 / 1024).toFixed(2), remaining };
}

export function getDataVolumeFreeBytes(): number | null {
  if (!fs.existsSync('/data')) {
    return null;
  }

  const stats = fs.statfsSync('/data');
  return stats.bsize * stats.bavail;
}

function pruneOldBackups(): void {
  if (!fs.existsSync(BACKUP_DIR)) {
    return;
  }

  const backups = fs.readdirSync(BACKUP_DIR)
    .filter(f => DAILY_BACKUP_REGEX.test(f))
    .sort()
    .reverse();

  for (const old of backups.slice(MAX_BACKUPS)) {
    const full = path.join(BACKUP_DIR, old);
    fs.unlinkSync(full);
    unlinkSidecars(full);
    console.log(`[Backup] Removed old: ${old} (+ sidecars)`);
  }
}

export async function backupDatabase(): Promise<void> {
  try {
    if (!fs.existsSync(DB_PATH)) {
      console.log('[Backup] Database file not found, skipping');
      return;
    }

    // Ensure backup directory exists
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const date = new Date().toISOString().split('T')[0];
    const backupPath = path.join(BACKUP_DIR, `nala-${date}.db`);

    // Skip if today's backup already exists
    if (fs.existsSync(backupPath)) {
      console.log(`[Backup] Today's backup already exists: ${backupPath}`);
      return;
    }

    const freeBytes = getDataVolumeFreeBytes();
    if (freeBytes !== null && freeBytes < MIN_FREE_SPACE_BYTES) {
      const freeMB = (freeBytes / 1024 / 1024).toFixed(1);
      console.warn(`[Backup] Skipped due to low disk space on /data: ${freeMB}MB free`);
      return;
    }

    // Drain WAL into the main DB file so the copy is self-contained.
    const ckpt = await checkpointWal();

    // Copy database file
    fs.copyFileSync(DB_PATH, backupPath);
    const backupSizeMB = (fs.statSync(backupPath).size / 1024 / 1024).toFixed(1);
    const freeMB = freeBytes !== null ? (freeBytes / 1024 / 1024).toFixed(1) : 'n/a';

    // Verify the copy survived. If the quick_check fails, delete the corrupt
    // file so we don't poison the directory with an unrestorable artifact —
    // and so today's same-day guard doesn't make tomorrow's run a no-op.
    const ok = await verifyBackup(backupPath);
    unlinkSidecars(backupPath); // clean up -wal/-shm libsql created during verify
    if (!ok) {
      try {
        fs.unlinkSync(backupPath);
        console.error(`[Backup] CRITICAL: deleted corrupt backup ${backupPath}`);
      } catch (e) {
        reportCritical(`also failed to delete corrupt backup: ${(e as Error).message}`, { path: backupPath });
      }
      return;
    }
    const ckptTag = ckpt?.ok ? 'full' : ckpt ? `partial(busy=${ckpt.busy})` : 'unknown';
    console.log(
      `[Backup] Created + verified: ${backupPath} (${backupSizeMB}MB, free space: ${freeMB}MB, ckpt=${ckptTag})`,
    );

    // Prune AFTER verification succeeds — never trade a known-good old backup
    // for a not-yet-verified new one. (The same-day guard above already
    // protects against re-running prune on a day where backup is already done.)
    pruneOldBackups();
  } catch (err) {
    reportCritical(`Backup failed: ${(err as Error).message}`, { stack: (err as Error).stack });
  }
}
