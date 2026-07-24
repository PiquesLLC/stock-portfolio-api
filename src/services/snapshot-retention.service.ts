import * as Sentry from '@sentry/node';
import prisma from '../utils/prisma';
import { alertOnCorruption } from './job-runner.service';
import { scheduleDailyAtUTC } from '../utils/daily-schedule';

// Nightly snapshot retention — the permanent fix for the unbounded growth
// behind the 2026-07 disk incident (60s snapshots accumulated for months,
// the daily backup doubled the cost, the volume filled, backups jammed).
//
// Policy (matches the manually-approved 2026-07-11 cleanup):
// - PortfolioSnapshot: keep 30 days of full intraday granularity; for older
//   days keep ONE end-of-day row per (user, day) — the per-day MAX(timestamp)
//   row is all the chart/TWR/risk engines read for long windows.
// - HoldingSnapshot: keep 30 days (nothing reads older intraday rows;
//   matches the existing /admin/cleanup-db semantics).
// - Plus routine hygiene: expired tokens/idempotency keys, old job runs,
//   old analytics/API logs. WAL checkpoint + incremental_vacuum at the end
//   (full VACUUM is deliberately NOT run here — it needs ~1× DB size free).
//
// STORAGE FORMAT (ground-truthed on prod 2026-07-11): every DateTime column
// is TEXT ISO-8601 like '2026-07-11T23:13:38.075+00:00'. Cutoffs are emitted
// as frozen literals in that exact shape so string comparison ==
// chronological comparison with no same-day 'T'-vs-space edge.
//
// WRITE-LOCK DISCIPLINE (added 2026-07-15 after the overnight brownout storm):
// the original PortfolioSnapshot chunk ran a correlated MAX-per-(user,day)
// subquery for EVERY candidate row, per 5000-row chunk, up to 500 chunks —
// each chunk held SQLite's single write lock for the whole evaluation, which
// serialized P1008 write-timeout storms for hours (2026-07-15 ~06:40→~15:00
// UTC). The fix is the same shape that rescued the 2026-07-12 rebuild:
// materialize the keeper set ONCE into an indexed scratch table, anti-join
// against it in SMALL chunks, and yield between chunks so user writes
// interleave. A wall-clock cap stops a huge backlog cleanly (it resumes on
// the next nightly run).
//
// GATED OFF BY DEFAULT: deletes would fail (and alert) against a corrupt
// database. Set SNAPSHOT_RETENTION_ENABLED=true after the rebuild-and-swap.

const CHUNK = 1000;
const MAX_CHUNKS = 500;
const CHUNK_YIELD_MS = 300;
const MAX_RUN_MS = 20 * 60 * 1000;

const KEEPER_TABLE = '"_retention_ps_keeper"';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Frozen ISO literal in the exact stored TEXT shape:
// '2026-07-15T18:05:06.789+00:00'
const isoLiteral = (d: Date): string => d.toISOString().replace('Z', '+00:00');
const daysAgo = (now: Date, days: number): string =>
  isoLiteral(new Date(now.getTime() - days * 86400000));

export interface RetentionSql {
  psKeeperDrop: string;
  psKeeperCreate: string;
  psKeeperIndex: string;
  portfolioSnapshotChunk: string;
  holdingSnapshotChunk: string;
  refreshToken: string;
  jobIdempotencyKey: string;
  backgroundJobRun: string;
  analyticsEvent: string;
  apiUsageLog: string;
}

// Statements are pure SQL (no bound params) so the integration test can
// replay them against a scratch libsql database. Cutoffs are frozen at build
// time: the old per-chunk strftime('now') let the 30-day boundary creep
// forward DURING a long run, so a (user, day) that crossed the boundary
// mid-run could lose its EOD keeper.
export function buildRetentionSql(now: Date = new Date()): RetentionSql {
  const cut30 = `'${daysAgo(now, 30)}'`;
  const cut7 = `'${daysAgo(now, 7)}'`;
  const cut90 = `'${daysAgo(now, 90)}'`;
  const nowLit = `'${isoLiteral(now)}'`;

  return {
    psKeeperDrop: `DROP TABLE IF EXISTS ${KEEPER_TABLE}`,
    // NOTE: "GROUP BY userId" keeps the NULL-user group — legacy NULL-user
    // snapshots get their own per-day keeper (NULL = NULL is never true, so
    // the probe below uses IS).
    psKeeperCreate: `CREATE TABLE ${KEEPER_TABLE} AS
      SELECT ps."userId" AS uid, date(ps."timestamp") AS d, MAX(ps."timestamp") AS keep_ts
      FROM "PortfolioSnapshot" ps
      WHERE ps."timestamp" < ${cut30}
      GROUP BY ps."userId", date(ps."timestamp")`,
    psKeeperIndex: `CREATE INDEX "_retention_ps_keeper_idx" ON ${KEEPER_TABLE}(keep_ts, d)`,
    portfolioSnapshotChunk: `DELETE FROM "PortfolioSnapshot" WHERE rowid IN (
      SELECT ps.rowid FROM "PortfolioSnapshot" ps
      WHERE ps."timestamp" < ${cut30}
        AND NOT EXISTS (
          SELECT 1 FROM ${KEEPER_TABLE} k
          WHERE k.keep_ts = ps."timestamp"
            AND k.d = date(ps."timestamp")
            AND k.uid IS ps."userId"
        )
      LIMIT ${CHUNK})`,
    holdingSnapshotChunk: `DELETE FROM "HoldingSnapshot" WHERE rowid IN (
      SELECT rowid FROM "HoldingSnapshot"
      WHERE "timestamp" < ${cut30}
      LIMIT ${CHUNK})`,
    refreshToken: `DELETE FROM "RefreshToken" WHERE "expiresAt" < ${nowLit} OR "revokedAt" IS NOT NULL`,
    jobIdempotencyKey: `DELETE FROM "JobIdempotencyKey" WHERE "expiresAt" < ${nowLit}`,
    backgroundJobRun: `DELETE FROM "BackgroundJobRun" WHERE "startedAt" < ${cut7}`,
    analyticsEvent: `DELETE FROM "AnalyticsEvent" WHERE "createdAt" < ${cut90}`,
    apiUsageLog: `DELETE FROM "ApiUsageLog" WHERE "createdAt" < ${cut90}`,
  };
}

export function snapshotRetentionEnabled(): boolean {
  return process.env.SNAPSHOT_RETENTION_ENABLED === 'true';
}

type Exec = (sql: string) => Promise<number>;
const prismaExec: Exec = (sql) => prisma.$executeRawUnsafe(sql);

async function chunkedDelete(
  exec: Exec,
  sql: string,
  label: string,
  log: string[],
  deadline: number,
): Promise<number> {
  let total = 0;
  let capNote = '';
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const deleted = await exec(sql);
    total += deleted;
    if (deleted < CHUNK) break;
    if (i === MAX_CHUNKS - 1) {
      capNote = ' (chunk-capped, resumes next run)';
      break;
    }
    if (Date.now() > deadline) {
      capNote = ' (time-capped, resumes next run)';
      break;
    }
    // Release the write lock between chunks so user/job writes interleave
    // instead of stacking up into P1008 timeouts.
    await sleep(CHUNK_YIELD_MS);
  }
  log.push(`${label}: deleted ${total}${capNote}`);
  return total;
}

// The keeper table has a fixed name and the run pre-drops it, so two
// overlapping runs would corrupt each other's anti-join (run B's pre-drop
// empties run A's keeper set → run A would delete EOD keepers). Only the
// once-daily scheduler calls this today; the guard protects any future
// manual/admin trigger.
let retentionRunning = false;

// `exec` is injectable so the integration test can run the real statements
// against a scratch libsql database instead of the prisma mock.
export async function runSnapshotRetention(exec: Exec = prismaExec): Promise<{ skipped: boolean; log: string[] }> {
  const log: string[] = [];
  if (!snapshotRetentionEnabled()) {
    return { skipped: true, log };
  }
  if (retentionRunning) {
    log.push('another retention run is in progress — skipped');
    console.warn('[Retention] Skipped: another run is in progress');
    return { skipped: true, log };
  }
  retentionRunning = true;
  try {
    return await runSnapshotRetentionLocked(exec, log);
  } finally {
    retentionRunning = false;
  }
}

async function runSnapshotRetentionLocked(exec: Exec, log: string[]): Promise<{ skipped: boolean; log: string[] }> {
  const startedAt = Date.now();
  const deadline = startedAt + MAX_RUN_MS;
  const sql = buildRetentionSql(new Date(startedAt));

  try {
    // Keeper set materialized ONCE (one indexed pass) instead of a correlated
    // subquery per candidate row per chunk. A real table (not TEMP) so it
    // survives connection pooling; dropped before AND after so a crashed run
    // never leaves a stale keeper set behind.
    await exec(sql.psKeeperDrop);
    await exec(sql.psKeeperCreate);
    await exec(sql.psKeeperIndex);
    log.push(`keeper set built in ${Date.now() - startedAt}ms`);

    await chunkedDelete(exec, sql.portfolioSnapshotChunk, 'PortfolioSnapshot (>30d, EOD kept)', log, deadline);
    await exec(sql.psKeeperDrop);

    await chunkedDelete(exec, sql.holdingSnapshotChunk, 'HoldingSnapshot (>30d)', log, deadline);

    log.push(`RefreshToken: deleted ${await exec(sql.refreshToken)}`);
    log.push(`JobIdempotencyKey: deleted ${await exec(sql.jobIdempotencyKey)}`);
    log.push(`BackgroundJobRun (>7d): deleted ${await exec(sql.backgroundJobRun)}`);
    log.push(`AnalyticsEvent (>90d): deleted ${await exec(sql.analyticsEvent)}`);
    log.push(`ApiUsageLog (>90d): deleted ${await exec(sql.apiUsageLog)}`);

    try {
      await exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
      log.push('WAL checkpoint: done');
    } catch (e) {
      // Deletes are already committed at this point — a hard checkpoint error
      // must not turn the whole run into a misleading [Retention] FAILED.
      log.push(`WAL checkpoint: skipped (${e instanceof Error ? e.message.slice(0, 80) : String(e)})`);
    }

    try {
      await exec(`PRAGMA incremental_vacuum`);
      log.push('incremental_vacuum: done');
    } catch (e) {
      log.push(`incremental_vacuum: skipped (${e instanceof Error ? e.message.slice(0, 80) : String(e)})`);
    }

    log.push(`total ${Date.now() - startedAt}ms`);
    console.log(`[Retention] ${log.join(' | ')}`);
    // A time/chunk cap means the run did NOT fully drain — surface it (warning)
    // so a chronically-capped retention (unbounded growth creeping back) is seen.
    if (log.some((l) => l.includes('capped'))) {
      try {
        Sentry.captureMessage('[Retention] run hit a time/chunk cap — did not fully drain', {
          level: 'warning',
          tags: { component: 'snapshot-retention' },
          extra: { log },
        });
      } catch { /* Sentry not initialised */ }
    }
    return { skipped: false, log };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Retention] FAILED: ${msg} (completed: ${log.join(' | ') || 'nothing'})`);
    // alertOnCorruption only escalates the SQLITE_CORRUPT sub-case; alert on ANY
    // retention failure so a generic failure isn't silent (it was console-only).
    alertOnCorruption('snapshot-retention', msg);
    try {
      Sentry.captureMessage('[Retention] run FAILED', {
        level: 'error',
        tags: { component: 'snapshot-retention' },
        extra: { error: msg, completed: log },
      });
    } catch { /* Sentry not initialised */ }
    try {
      await exec(sql.psKeeperDrop);
    } catch {
      // scratch cleanup is best-effort; next run drops it first anyway
    }
    return { skipped: false, log };
  }
}

export function scheduleSnapshotRetention(): void {
  if (!snapshotRetentionEnabled()) {
    console.log('[Retention] Disabled (set SNAPSHOT_RETENTION_ENABLED=true after the DB rebuild)');
    return;
  }
  // Fixed off-peak hour (02:40 ET), 30min before the 07:10 UTC backup so the
  // two never overlap. Was boot-anchored (2min after start + every 24h),
  // which put its mass DELETEs + TRUNCATE checkpoint in the same minute as
  // the backup copy and the daily job fleet — the 2026-07-14 outage stack.
  scheduleDailyAtUTC(6, 40, () => { void runSnapshotRetention(); }, 'snapshot-retention');
}
