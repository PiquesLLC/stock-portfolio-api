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
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';
import { spawn } from 'child_process';
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

// Distinguishes "pg_dump isn't installed" (expected during a nixpacks rollout,
// log-and-continue) from a real failure (Sentry CRITICAL). Not a user-facing string.
const ENOENT_SENTINEL = '__PG_DUMP_ENOENT__';

// A custom-format pg_dump of an EMPTY database is still ~1KB of valid archive.
// Anything under this is not a real backup of the v2 ledger.
const MIN_PLAUSIBLE_DUMP_BYTES = 4096;

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
 * Parse V2_DATABASE_URL into pg_dump-friendly env vars (so the password
 * never appears in argv / /proc/<pid>/cmdline). pg_dump reads PGPASSWORD
 * + PGHOST + PGPORT + PGUSER + PGDATABASE + PGSSLMODE.
 */
function parsePgEnv(dbUrl: string): Record<string, string> {
  const u = new URL(dbUrl);
  const database = u.pathname.replace(/^\//, '');
  // Refuse an empty database name rather than let libpq silently default it to
  // the USERNAME. That path produces a well-formed, exit-0, ~1KB dump of the
  // WRONG (usually nonexistent-but-implicit) database — a backup that looks
  // successful and restores to nothing.
  if (!database) {
    throw new Error('V2_DATABASE_URL has no database name in its path');
  }
  const env: Record<string, string> = {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGDATABASE: database,
  };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/**
 * Spawn pg_dump against V2_DATABASE_URL, spool it to a temp file, then upload
 * that file to R2 as a single PutObject. Credentials go via env vars (NEVER
 * argv) so they don't appear in `ps aux` / `/proc/<pid>/cmdline`.
 *
 * Race semantics: we resolve only once pg_dump has exited AND the temp file has
 * flushed, so a truncated dump can never be uploaded as if it were good. On any
 * failure nothing is uploaded at all, which is why no abort/cleanup of a
 * partial object is needed (single PutObject commits atomically).
 */
async function shipV2ToR2(client: S3Client, cfg: R2Config): Promise<boolean> {
  const dbUrl = process.env.V2_DATABASE_URL;
  if (!dbUrl) {
    console.log('[Offsite] V2_DATABASE_URL not set; skipping v2');
    return true;
  }

  const ts = new Date().toISOString().slice(0, 10);
  const key = `${cfg.prefix}v2/v2-${ts}.dump`;

  let pgEnv: Record<string, string>;
  try {
    pgEnv = parsePgEnv(dbUrl);
  } catch (e) {
    reportCritical(`V2_DATABASE_URL is unparseable: ${(e as Error).message}`);
    return false;
  }

  // Spool pg_dump to a temp file, then upload with an explicit ContentLength —
  // do NOT pipe dump.stdout straight into PutObject.
  //
  // Precise mechanism, because the obvious reading is wrong: the SDK uses
  // aws-chunked encoding for ANY Readable body regardless of ContentLength
  // (middleware-flexible-checksums, requestChecksumCalculation defaults to
  // WHEN_SUPPORTED). It then sets `x-amz-decoded-content-length` FROM the
  // content-length header. With no ContentLength that header is literally
  // `undefined`, which R2 rejects outright ("Invalid value \"undefined\" for
  // header ..." — observed in prod 2026-07-24, v2 failing every run while v1
  // succeeded). Supplying ContentLength does not avoid aws-chunked; it makes
  // the header VALID. So do not "optimise" this back to a direct pipe.
  // shipV1ToR2 uses this same file-stream + ContentLength shape, which is why
  // it has always worked. The v2 ledger dump is small (two models in
  // prisma-v2/schema.prisma), so buffering costs nothing.
  const tmpPath = path.join(os.tmpdir(), `v2-${ts}-${process.pid}.dump`);

  try {
    const result = await new Promise<{ ok: boolean; reason: string }>((resolve) => {
      const out = fs.createWriteStream(tmpPath);
      const dump = spawn(
        'pg_dump',
        // --lock-wait-timeout: pg_dump takes ACCESS SHARE locks, so anything
        // holding ACCESS EXCLUSIVE (a migration, ALTER TABLE, VACUUM FULL)
        // blocks it INDEFINITELY. Without this it never exits, this promise
        // never settles, and offsite backups stop permanently.
        ['--format=custom', '--no-owner', '--no-privileges', '--lock-wait-timeout=60000'],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...pgEnv } },
      );

      let stderrBuf = '';
      let settled = false;
      const done = (ok: boolean, reason: string) => {
        if (settled) return;
        settled = true;
        // Never leave the child or the stream behind. On a destination error
        // Node unpipes WITHOUT destroying the source, so pg_dump would block
        // forever on a full pipe buffer, holding a Postgres backend open.
        try { dump.kill('SIGKILL'); } catch { /* already gone */ }
        try { out.destroy(); } catch { /* already closed */ }
        resolve({ ok, reason });
      };

      dump.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
      dump.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          console.warn('[Offsite] pg_dump not on PATH — install postgresql in nixpacks.toml. Skipping v2 ship.');
          // Graceful degradation, deliberately NOT a CRITICAL.
          done(false, ENOENT_SENTINEL);
        } else {
          done(false, `pg_dump spawn error: ${err.message}`);
        }
      });
      out.on('error', (err) => done(false, `temp file write error: ${err.message}`));

      dump.stdout.pipe(out);

      // Only succeed once pg_dump has exited 0 AND the file is fully flushed —
      // uploading a half-written dump would produce a silently corrupt backup.
      //
      // `exited` is tracked SEPARATELY from the exit code on purpose: a child
      // killed by a signal reports `code === null`, so using null as the
      // "hasn't exited yet" marker would make this promise never settle. That
      // in turn latches `running = true` forever and silently stops BOTH v1 and
      // v2 backups until the process restarts.
      let exited = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let flushed = false;
      const maybeFinish = () => {
        if (!exited || !flushed) return;
        if (exitCode === 0) {
          done(true, 'ok');
        } else {
          const how = exitSignal ? `killed by ${exitSignal}` : `exited code ${exitCode}`;
          done(false, `pg_dump ${how}: ${stderrBuf.slice(0, 300)}`);
        }
      };
      dump.on('exit', (code, signal) => {
        exited = true;
        exitCode = code;
        exitSignal = signal;
        maybeFinish();
      });
      out.on('finish', () => { flushed = true; maybeFinish(); });
      out.on('close', () => { flushed = true; maybeFinish(); });
    });

    if (!result.ok) {
      if (result.reason === ENOENT_SENTINEL) return false;
      reportCritical(`v2 ship failed: ${result.reason}`, { key });
      return false;
    }

    // Validate the artifact before trusting it. A size check alone is too weak:
    // pg_dump exits 0 and emits a well-formed ~1KB archive containing zero
    // tables if pointed at the wrong database, which uploads and alerts nothing
    // until someone tries to restore it.
    const size = fs.statSync(tmpPath).size;
    if (size < MIN_PLAUSIBLE_DUMP_BYTES) {
      reportCritical(
        `v2 ship failed: dump is implausibly small (${size} bytes) — probably an empty or wrong database`,
        { key, size },
      );
      return false;
    }
    const magic = Buffer.alloc(5);
    const fd = fs.openSync(tmpPath, 'r');
    try { fs.readSync(fd, magic, 0, 5, 0); } finally { fs.closeSync(fd); }
    if (magic.toString('latin1') !== 'PGDMP') {
      reportCritical('v2 ship failed: dump is not a pg_dump custom-format archive (bad magic)', { key });
      return false;
    }

    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: fs.createReadStream(tmpPath),
        ContentLength: size,
        Metadata: { source: 'v2-postgres-pg_dump', shipped_at: new Date().toISOString() },
      }),
    );

    console.log(`[Offsite] v2 shipped: ${key} (${(size / 1024 / 1024).toFixed(1)} MB)`);
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
