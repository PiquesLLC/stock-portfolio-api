import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = process.env.DATABASE_URL?.replace('file:', '') || '/data/nala.db';
const BACKUP_DIR = process.env.NODE_ENV === 'production' ? '/data/backups' : path.join(process.cwd(), 'prisma', 'backups');
const MAX_BACKUPS = 3; // Keep 3 daily backups
const MIN_FREE_SPACE_BYTES = 500 * 1024 * 1024;

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
