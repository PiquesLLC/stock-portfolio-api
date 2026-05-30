#!/usr/bin/env npx -y ts-node
// Pre-cutover SQLite snapshot — call at T-1 (right before V1_WALLET_FREEZE).
//
// Differs from the daily backup (src/services/backup.service.ts) in two
// ways:
//   1. Filename is `nala-pre-cutover-<ISO-ts>.db` — does NOT collide with
//      the daily `nala-<YYYY-MM-DD>.db` shape, so the same-day guard
//      can't suppress it and the prune-to-keep-1 logic won't sweep it.
//   2. Same WAL-checkpoint + quick_check pipeline, but the result is
//      labeled "PRE-CUTOVER" so an operator scanning logs sees the
//      special snapshot landed.
//
// USAGE (on the Railway container):
//   railway run --service stock-portfolio-api -- npx ts-node scripts/pre-cutover-snapshot.ts
//
// OR via the dashboard's one-shot run:
//   set V2_RUN_PRE_CUTOVER_SNAPSHOT=true on the API service, redeploy,
//   then unset. (Wire similar to V2_RUN_GATE_ONCE if you want automation.)
//
// EXIT CODES:
//   0  snapshot written + verified
//   1  snapshot failed at any stage
//
// The script intentionally bypasses the daily backup's same-day guard
// and prune logic — it's a manual "important moment" snapshot, not part
// of the steady-state rotation.

import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@libsql/client';
import prisma from '../src/utils/prisma';

const DB_PATH = process.env.DATABASE_URL?.replace('file:', '') || '/data/nala.db';
const BACKUP_DIR =
  process.env.NODE_ENV === 'production'
    ? '/data/backups'
    : path.join(process.cwd(), 'prisma', 'backups');
const MIN_FREE_SPACE_BYTES = 500 * 1024 * 1024;

function getDataVolumeFreeBytes(): number | null {
  if (!fs.existsSync('/data')) return null;
  const stats = fs.statfsSync('/data');
  return stats.bsize * stats.bavail;
}

async function checkpointWal(): Promise<{ busy: number; log: number; checkpointed: number } | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ busy: number; log: number; checkpointed: number }>
    >('PRAGMA wal_checkpoint(TRUNCATE)');
    return rows?.[0] ?? null;
  } catch (e) {
    console.error('[Pre-cutover] WAL checkpoint failed:', (e as Error).message);
    return null;
  }
}

async function quickCheck(backupPath: string): Promise<boolean> {
  let client: ReturnType<typeof createClient> | null = null;
  try {
    client = createClient({ url: `file:${path.resolve(backupPath)}` });
    const result = await client.execute('PRAGMA quick_check');
    return result.rows.length === 1 && result.rows[0].quick_check === 'ok';
  } catch (e) {
    console.error('[Pre-cutover] quick_check failed:', (e as Error).message);
    return false;
  } finally {
    try { client?.close(); } catch { /* ignore */ }
  }
}

function unlinkSidecars(basePath: string): void {
  for (const ext of ['-wal', '-shm', '-journal'] as const) {
    const p = basePath + ext;
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

async function main(): Promise<void> {
  console.log(`[Pre-cutover] Source DB: ${DB_PATH}`);

  if (!fs.existsSync(DB_PATH)) {
    console.error(`[Pre-cutover] FATAL: DB not found at ${DB_PATH}`);
    process.exit(1);
  }

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const freeBytes = getDataVolumeFreeBytes();
  if (freeBytes !== null && freeBytes < MIN_FREE_SPACE_BYTES) {
    const freeMB = (freeBytes / 1024 / 1024).toFixed(1);
    console.error(
      `[Pre-cutover] FATAL: only ${freeMB} MB free on /data; need >= ${(MIN_FREE_SPACE_BYTES / 1024 / 1024).toFixed(0)} MB.`,
    );
    process.exit(1);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `nala-pre-cutover-${ts}.db`);

  console.log('[Pre-cutover] Running WAL checkpoint...');
  const ckpt = await checkpointWal();
  if (ckpt && ckpt.busy !== 0) {
    console.warn(
      `[Pre-cutover] WAL checkpoint partial: busy=${ckpt.busy} log=${ckpt.log} checkpointed=${ckpt.checkpointed}. ` +
        `Snapshot may miss recent writes. Proceeding anyway — re-run if cutover is delayed.`,
    );
  } else if (ckpt) {
    console.log(
      `[Pre-cutover] WAL checkpoint OK: log=${ckpt.log} checkpointed=${ckpt.checkpointed}`,
    );
  } else {
    console.warn('[Pre-cutover] WAL checkpoint result unknown (proceeding).');
  }

  console.log(`[Pre-cutover] Copying ${DB_PATH} → ${backupPath}...`);
  fs.copyFileSync(DB_PATH, backupPath);
  const sizeMB = (fs.statSync(backupPath).size / 1024 / 1024).toFixed(1);
  console.log(`[Pre-cutover] Copied: ${sizeMB} MB`);

  console.log('[Pre-cutover] Running quick_check on snapshot...');
  const ok = await quickCheck(backupPath);
  unlinkSidecars(backupPath);

  if (!ok) {
    console.error('[Pre-cutover] FATAL: quick_check FAILED — deleting corrupt snapshot.');
    try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
    process.exit(1);
  }

  console.log(
    `[Pre-cutover] PRE-CUTOVER SNAPSHOT OK: ${backupPath} (${sizeMB} MB). ` +
      `This is your canonical rollback target for the next 7 days.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[Pre-cutover] FATAL:', err);
  process.exit(1);
});
