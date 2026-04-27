import * as fs from 'fs';
import * as path from 'path';

export const DB_PATH = process.env.DATABASE_URL?.replace('file:', '') || '/data/nala.db';
export const BACKUP_DIR = process.env.NODE_ENV === 'production' ? '/data/backups' : path.join(process.cwd(), 'prisma', 'backups');
// Each backup ≈ same size as live DB. With a 5GB volume and ~1.4GB DB, keeping
// >1 backup means stable state requires >2× DB-size of free space, which we
// don't have. Lowered from 3 to 1 after Apr 26 incident — see
// railway-volume-cleanup memory. Push to S3/R2 if longer retention is needed.
const MAX_BACKUPS = 1;
const MIN_FREE_SPACE_BYTES = 500 * 1024 * 1024;

/**
 * Delete all but the `keep` most recent backups (by filename, which is date-stamped).
 * Returns the list of deleted filenames and the bytes freed. Safe to call from
 * an admin endpoint; does not depend on `backupDatabase()` running.
 */
export function pruneBackupsToKeep(keep: number): { deleted: { name: string; sizeMB: number }[]; freedMB: number; remaining: { name: string; sizeMB: number }[] } {
  const deleted: { name: string; sizeMB: number }[] = [];
  let freedBytes = 0;

  if (!fs.existsSync(BACKUP_DIR)) {
    return { deleted, freedMB: 0, remaining: [] };
  }

  const all = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('nala-') && f.endsWith('.db'))
    .sort()
    .reverse();

  for (const name of all.slice(Math.max(0, keep))) {
    const full = path.join(BACKUP_DIR, name);
    try {
      const size = fs.statSync(full).size;
      fs.unlinkSync(full);
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

function getDataVolumeFreeBytes(): number | null {
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
    .filter(f => f.startsWith('nala-') && f.endsWith('.db'))
    .sort()
    .reverse();

  for (const old of backups.slice(MAX_BACKUPS)) {
    fs.unlinkSync(path.join(BACKUP_DIR, old));
    console.log(`[Backup] Removed old: ${old}`);
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

    pruneOldBackups();

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

    // Copy database file
    fs.copyFileSync(DB_PATH, backupPath);
    const backupSizeMB = (fs.statSync(backupPath).size / 1024 / 1024).toFixed(1);
    const freeMB = freeBytes !== null ? (freeBytes / 1024 / 1024).toFixed(1) : 'n/a';
    console.log(`[Backup] Created: ${backupPath} (${backupSizeMB}MB, free space: ${freeMB}MB)`);

    pruneOldBackups();
  } catch (err) {
    console.error('[Backup] Failed:', (err as Error).message);
  }
}
