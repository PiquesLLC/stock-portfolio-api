import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = process.env.DATABASE_URL?.replace('file:', '') || '/data/nala.db';
const BACKUP_DIR = process.env.NODE_ENV === 'production' ? '/data/backups' : path.join(process.cwd(), 'prisma', 'backups');
const MAX_BACKUPS = 7; // Keep 7 daily backups

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

    // Copy database file
    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`[Backup] Created: ${backupPath} (${(fs.statSync(backupPath).size / 1024 / 1024).toFixed(1)}MB)`);

    // Cleanup old backups — keep only MAX_BACKUPS most recent
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('nala-') && f.endsWith('.db'))
      .sort()
      .reverse();

    for (const old of backups.slice(MAX_BACKUPS)) {
      fs.unlinkSync(path.join(BACKUP_DIR, old));
      console.log(`[Backup] Removed old: ${old}`);
    }
  } catch (err) {
    console.error('[Backup] Failed:', (err as Error).message);
  }
}
