// Off-site backup shipper — uploads the most recent v1 SQLite backup and a
// fresh logical export of the v2 Postgres ledger to Cloudflare R2
// (S3-compatible).
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
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { Client as PgClient } from 'pg';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import * as Sentry from '@sentry/node';
import { BACKUP_DIR } from './backup.service';
import { scheduleDailyAtUTC } from '../utils/daily-schedule';

const DAY_MS = 24 * 60 * 60 * 1000;
// Retention; older objects pruned on each successful run. 8 days, not 30,
// deliberately: the v1 snapshot is ~1.1GB/day, so 30 days is ~33GB (~$0.35/mo
// at R2's $0.015/GB-mo) while 8 days is ~9GB — inside R2's 10GB free tier.
// Off-site exists for provider-level disaster recovery, which a week of history
// covers; the volume also holds a same-day local backup and Railway keeps its own.
const KEEP_DAYS = 8;

// Even an empty gzip stream is ~20 bytes, and our header line alone exceeds
// this. Anything smaller is not a real export.
const MIN_PLAUSIBLE_DUMP_BYTES = 128;

let scheduled: { cancel: () => void } | null = null;
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
 * Logical export of every table in the v2 public schema to gzipped NDJSON.
 *
 * Tables are enumerated from pg_tables rather than hardcoded, so adding a model
 * to prisma-v2 can't silently leave it unbacked-up.
 */
async function exportV2Logical(
  dbUrl: string,
  destPath: string,
): Promise<{ tables: number; rows: number }> {
  const pg = new PgClient({ connectionString: dbUrl });
  await pg.connect();
  try {
    const { rows: tableRows } = await pg.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );

    const gz = zlib.createGzip();
    const out = fs.createWriteStream(destPath);
    const finished = new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      gz.on('error', reject);
    });
    gz.pipe(out);

    const write = (line: string): Promise<void> =>
      new Promise((resolve, reject) => {
        // Respect backpressure — a large table would otherwise buffer entirely
        // in memory before gzip drains it.
        if (gz.write(line)) return resolve();
        gz.once('drain', resolve);
        gz.once('error', reject);
      });

    await write(JSON.stringify({
      __meta: {
        format: 'v2-logical-ndjson',
        version: 1,
        exportedAt: new Date().toISOString(),
        tables: tableRows.map((t) => t.tablename),
      },
    }) + '\n');

    let rows = 0;
    for (const { tablename } of tableRows) {
      const res = await pg.query(`SELECT * FROM "${tablename}"`);
      for (const r of res.rows) {
        await write(JSON.stringify({ t: tablename, r }) + '\n');
        rows++;
      }
    }

    gz.end();
    await finished;
    return { tables: tableRows.length, rows };
  } finally {
    await pg.end().catch(() => { /* already closed */ });
  }
}

/**
 * Export the v2 Postgres ledger and upload it to R2 as a single PutObject.
 *
 * Deliberately NOT pg_dump. The nixpacks archive pins postgresql 16.6 while the
 * Railway v2 server is 18.4, and pg_dump REFUSES to dump a newer server
 * ("aborting because of server version mismatch") — so v2 had never once
 * shipped, first masked by an upload bug and then by this. Pinning
 * `postgresql_18` was tried and the build failed (not in that archive), and
 * bumping the archive itself also moves nodejs/npm/openssl, which this repo has
 * been burned by before (see nixpacks.toml).
 *
 * node-postgres speaks the wire protocol and is version-agnostic, so the entire
 * class of problem disappears. `pg` is already a direct dependency, so this
 * needs no build change at all.
 *
 * Trade-off, stated plainly: the artifact is gzipped NDJSON, not a pg_dump
 * archive, so restoring is a short script rather than `pg_restore`. That is
 * acceptable for a two-model shadow ledger and should be revisited if v2
 * becomes primary after the cutover.
 */
async function shipV2ToR2(client: S3Client, cfg: R2Config): Promise<boolean> {
  const dbUrl = process.env.V2_DATABASE_URL;
  if (!dbUrl) {
    console.log('[Offsite] V2_DATABASE_URL not set; skipping v2');
    return true;
  }

  const ts = new Date().toISOString().slice(0, 10);
  const key = `${cfg.prefix}v2/v2-${ts}.ndjson.gz`;

  // The upload below passes an explicit ContentLength — do NOT change it to
  // stream a body of unknown length. The SDK uses aws-chunked encoding for ANY
  // Readable (middleware-flexible-checksums, requestChecksumCalculation defaults
  // to WHEN_SUPPORTED) and sets `x-amz-decoded-content-length` FROM the
  // content-length header; with no ContentLength that header is literally
  // `undefined`, which R2 rejects outright (observed in prod 2026-07-24, v2
  // failing every run while v1 succeeded). ContentLength doesn't avoid
  // aws-chunked, it makes the header VALID.
  const tmpPath = path.join(os.tmpdir(), `v2-${ts}-${process.pid}.ndjson.gz`);

  try {
    const stats = await exportV2Logical(dbUrl, tmpPath);

    // Zero rows means we connected to the wrong database, or the ledger is
    // empty — either way it is not a backup worth keeping, and shipping it would
    // quietly overwrite yesterday's good object under the same date-stamped key.
    if (stats.rows === 0) {
      reportCritical(
        `v2 ship failed: export produced ZERO rows across ${stats.tables} table(s) — wrong database or empty ledger`,
        { key, tables: stats.tables },
      );
      return false;
    }

    const size = fs.statSync(tmpPath).size;
    if (size < MIN_PLAUSIBLE_DUMP_BYTES) {
      reportCritical(
        `v2 ship failed: export is implausibly small (${size} bytes)`,
        { key, size, rows: stats.rows },
      );
      return false;
    }
    // gzip magic (1f 8b) — proves the stream was finalised, not truncated
    // mid-write, before we upload it as a backup.
    const magic = Buffer.alloc(2);
    const fd = fs.openSync(tmpPath, 'r');
    try { fs.readSync(fd, magic, 0, 2, 0); } finally { fs.closeSync(fd); }
    if (magic[0] !== 0x1f || magic[1] !== 0x8b) {
      reportCritical('v2 ship failed: export is not a valid gzip stream (bad magic)', { key });
      return false;
    }

    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: fs.createReadStream(tmpPath),
        ContentLength: size,
        Metadata: {
          source: 'v2-postgres-logical-ndjson',
          shipped_at: new Date().toISOString(),
          tables: String(stats.tables),
          rows: String(stats.rows),
        },
      }),
    );

    console.log(
      `[Offsite] v2 shipped: ${key} (${(size / 1024).toFixed(1)} KB, ${stats.tables} tables, ${stats.rows} rows)`,
    );
    return true;
  } catch (err) {
    // Deliberately does NOT delete `key` on failure. The key is date-stamped, so
    // a same-day re-run targets the object an EARLIER successful run wrote —
    // deleting it would destroy a good backup and leave nothing. The old code
    // needed that cleanup because it streamed (a failed multipart could leave a
    // partial); with a single PutObject of known length R2 commits atomically,
    // so a failed upload cannot leave a partial object behind.
    // Message is generic because this also covers statSync / magic-byte reads.
    reportCritical(`v2 ship failed: ${(err as Error).message}`, { key });
    return false;
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort */ }
  }
}

/**
 * Delete objects older than KEEP_DAYS days from BOTH v1/ and v2/ prefixes.
 * Safe to run every day; objects newer than the cutoff are skipped.
 *
 * Paginates through `IsTruncated`/`NextContinuationToken` so a long-running
 * deployment with many ad-hoc backups can't accumulate orphan objects past
 * the S3 1000-key response cap.
 *
 * NOTE on multipart orphans: a SIGTERM mid-upload can leave incomplete
 * multipart uploads in R2 that this DeleteObject sweep can't reach. The
 * bucket should have a lifecycle rule for AbortIncompleteMultipartUpload
 * after 1 day — see docs/v2-cutover.md.
 */
async function pruneOldOffsite(
  client: S3Client,
  cfg: R2Config,
  shipped: { v1: boolean; v2: boolean },
): Promise<void> {
  const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
  try {
    for (const sub of ['v1/', 'v2/'] as const) {
      if (sub === 'v1/' ? !shipped.v1 : !shipped.v2) {
        console.warn(`[Offsite] prune SKIPPED for ${sub} — this run did not ship it; refusing to delete history while backups are failing`);
        continue;
      }
      let continuationToken: string | undefined;
      do {
        const list = await client.send(
          new ListObjectsV2Command({
            Bucket: cfg.bucket,
            Prefix: cfg.prefix + sub,
            ContinuationToken: continuationToken,
          }),
        );
        for (const obj of list.Contents ?? []) {
          if (obj.LastModified && obj.LastModified.getTime() < cutoff && obj.Key) {
            await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: obj.Key }));
            console.log(`[Offsite] pruned: ${obj.Key}`);
          }
        }
        continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
      } while (continuationToken);
    }
  } catch (err) {
    console.warn(`[Offsite] prune skipped due to error: ${(err as Error).message}`);
    // Non-fatal — pruning failure should not fail the upload path.
  }
}

async function runOnce(): Promise<void> {
  if (running) {
    // CRITICAL, not warn: `running` can only still be true a day later if a
    // previous run never settled. That silently stops BOTH v1 and v2 offsite
    // backups until the process restarts, and this line is the only signal it
    // ever happened — it must page, not whisper.
    reportCritical('previous run still in flight — offsite backups are NOT running');
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
    // Prune ONLY the prefixes that shipped successfully this run. Pruning
    // unconditionally means a broken shipper keeps eating surviving history and
    // empties the bucket precisely when backups are already failing — the exact
    // scenario off-site storage exists for.
    await pruneOldOffsite(client, cfg, { v1: v1Ok, v2: v2Ok });
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
  if (scheduled) scheduled.cancel();
  scheduled = null;

  if (!readConfig()) {
    console.log('[Offsite] R2_* env vars not set — daily off-site ship NOT scheduled.');
    return;
  }

  // Fixed hour, 1h after the 07:10 UTC local backup so the file it ships is
  // already written + verified. (Was boot-anchored — see daily-schedule.ts.)
  scheduled = scheduleDailyAtUTC(8, 10, () => void runOnce(), 'offsite-backup');
}

// Exported for testing + ad-hoc invocations.
export { runOnce as runOffsiteBackupOnce };
