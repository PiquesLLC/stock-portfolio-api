// Off-site backup shipper — uploads the most recent v1 SQLite backup and
// a fresh v2 Postgres pg_dump to Cloudflare R2 (S3-compatible).
//
// Why off-site: Railway's volume backups (configured via
// scripts/setup-railway-backups.ts) live on Railway infrastructure. For
// true disaster-recovery independence we mirror them to a separate
// cloud provider. R2 is chosen for cost ($0.015/GB-mo, $0 egress)
// and S3-compatible API.
//
// REQUIRED ENV VARS (skip silently if any missing):
//   R2_ACCOUNT_ID           — your Cloudflare account ID
//   R2_ACCESS_KEY_ID        — R2 API token's access key
//   R2_SECRET_ACCESS_KEY    — R2 API token's secret
//   R2_BUCKET               — bucket name (must exist; we don't auto-create)
//
// OPTIONAL:
//   R2_PREFIX               — key prefix (default 'nala-backups/')
//
// CADENCE: scheduled by `scheduleOffsiteBackups()` in src/index.ts. Daily,
// 1 hour after the local SQLite backup runs so the file is already
// written + verified before we try to ship it.

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import * as Sentry from '@sentry/node';
import { BACKUP_DIR } from './backup.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 60 * 60 * 1000; // 1h after local backup window
const KEEP_DAYS = 30; // Retention; older objects pruned on each successful run.

let timer: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

function reportCritical(message: string, extra?: Record<string, unknown>): void {
  console.error(`[Offsite] CRITICAL: ${message}`);
  try {
    Sentry.captureMessage(`[Offsite] ${message}`, {
      level: 'error',
      tags: { component: 'offsite_backup' },
      extra,
    });
  } catch { /* Sentry uninit'd — already on stderr */ }
}

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string;
}

function readConfig(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    prefix: process.env.R2_PREFIX ?? 'nala-backups/',
  };
}

function makeClient(cfg: R2Config): S3Client {
  return new S3Client({
    region: 'auto', // R2 requires "auto"
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
}

/**
 * Upload the most recent date-stamped v1 SQLite backup to R2.
 * No-op (with a log) if no local backup exists yet.
 */
async function shipV1ToR2(client: S3Client, cfg: R2Config): Promise<boolean> {
  if (!fs.existsSync(BACKUP_DIR)) {
    console.log('[Offsite] BACKUP_DIR missing; nothing to ship for v1');
    return true;
  }
  const candidates = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^nala-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .reverse();
  if (candidates.length === 0) {
    console.log('[Offsite] no date-stamped v1 backups in /data/backups; skipping v1');
    return true;
  }
  const fileName = candidates[0];
  const localPath = path.join(BACKUP_DIR, fileName);
  const stat = fs.statSync(localPath);
  const key = `${cfg.prefix}v1/${fileName}`;

  try {
    const body = fs.createReadStream(localPath);
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: body,
        ContentLength: stat.size,
        Metadata: {
          source: 'v1-sqlite',
          shipped_at: new Date().toISOString(),
        },
      }),
    );
    console.log(
      `[Offsite] v1 shipped: ${fileName} (${(stat.size / 1024 / 1024).toFixed(1)} MB) → ${cfg.bucket}/${key}`,
    );
    return true;
  } catch (err) {
    reportCritical(`v1 upload failed for ${fileName}: ${(err as Error).message}`, { key, sizeMB: stat.size / 1024 / 1024 });
    return false;
  }
}

/**
 * Spawn pg_dump against V2_DATABASE_URL and stream the output directly
 * to an R2 object. Falls back to logging if pg_dump isn't on PATH (e.g.,
 * in a base image that didn't include postgresql). The nixpacks.toml
 * setup phase adds it for production.
 */
async function shipV2ToR2(client: S3Client, cfg: R2Config): Promise<boolean> {
  const dbUrl = process.env.V2_DATABASE_URL;
  if (!dbUrl) {
    console.log('[Offsite] V2_DATABASE_URL not set; skipping v2');
    return true;
  }

  const ts = new Date().toISOString().slice(0, 10);
  const key = `${cfg.prefix}v2/v2-${ts}.dump`;

  return new Promise<boolean>((resolve) => {
    const dump = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', dbUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrBuf = '';
    dump.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

    const upload = client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: dump.stdout,
        Metadata: { source: 'v2-postgres-pg_dump', shipped_at: new Date().toISOString() },
      }),
    );

    let dumpExited = false;
    dump.on('error', (err) => {
      if (err.message.includes('ENOENT')) {
        console.warn('[Offsite] pg_dump not on PATH — install postgresql in nixpacks.toml. Skipping v2 ship.');
      } else {
        reportCritical(`pg_dump spawn error: ${err.message}`);
      }
      resolve(false);
    });

    dump.on('exit', (code) => {
      dumpExited = true;
      if (code !== 0) {
        reportCritical(`pg_dump exited code ${code}: ${stderrBuf.slice(0, 500)}`, { key });
        resolve(false);
      }
    });

    upload
      .then(() => {
        if (dumpExited) {
          console.log(`[Offsite] v2 shipped: ${key}`);
          resolve(true);
        } else {
          // Upload finished before pg_dump's exit event — wait for exit.
          dump.once('exit', (code) => {
            if (code === 0) {
              console.log(`[Offsite] v2 shipped: ${key}`);
              resolve(true);
            } else {
              reportCritical(`pg_dump exit ${code} after upload: ${stderrBuf.slice(0, 500)}`, { key });
              resolve(false);
            }
          });
        }
      })
      .catch((err) => {
        reportCritical(`v2 upload failed: ${(err as Error).message}`, { key });
        resolve(false);
      });
  });
}

/**
 * Delete objects older than KEEP_DAYS days from BOTH v1/ and v2/ prefixes.
 * Safe to run every day; objects newer than the cutoff are skipped.
 */
async function pruneOldOffsite(client: S3Client, cfg: R2Config): Promise<void> {
  const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
  try {
    for (const sub of ['v1/', 'v2/'] as const) {
      const list = await client.send(
        new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: cfg.prefix + sub }),
      );
      for (const obj of list.Contents ?? []) {
        if (obj.LastModified && obj.LastModified.getTime() < cutoff && obj.Key) {
          await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: obj.Key }));
          console.log(`[Offsite] pruned: ${obj.Key}`);
        }
      }
    }
  } catch (err) {
    console.warn(`[Offsite] prune skipped due to error: ${(err as Error).message}`);
    // Non-fatal — pruning failure should not fail the upload path.
  }
}

async function runOnce(): Promise<void> {
  if (running) {
    console.warn('[Offsite] previous run still in flight, skipping');
    return;
  }
  const cfg = readConfig();
  if (!cfg) return; // Quietly skip when not configured.
  running = true;
  const startedAt = Date.now();
  try {
    const client = makeClient(cfg);
    const v1Ok = await shipV1ToR2(client, cfg);
    const v2Ok = await shipV2ToR2(client, cfg);
    await pruneOldOffsite(client, cfg);
    const ms = Date.now() - startedAt;
    if (v1Ok && v2Ok) {
      console.log(`[Offsite] OK (${ms}ms)`);
    } else {
      // Individual failures already Sentry-captured; surface aggregate.
      console.error(`[Offsite] partial failure: v1=${v1Ok} v2=${v2Ok} (${ms}ms)`);
    }
  } finally {
    running = false;
  }
}

/**
 * Schedule the daily off-site ship. No-op (with a log) if R2 env vars
 * are not configured — graceful degradation lets the rest of the app
 * boot normally.
 */
export function scheduleOffsiteBackups(): void {
  if (timer) clearTimeout(timer);
  if (interval) clearInterval(interval);

  if (!readConfig()) {
    console.log('[Offsite] R2_* env vars not set — daily off-site ship NOT scheduled.');
    return;
  }

  console.log('[Offsite] Scheduled daily (first run in 1h, then every 24h).');
  timer = setTimeout(() => {
    void runOnce();
    interval = setInterval(() => void runOnce(), DAY_MS);
    interval.unref();
  }, INITIAL_DELAY_MS);
  timer.unref();
}

// Exported for testing + ad-hoc invocations.
export { runOnce as runOffsiteBackupOnce };
