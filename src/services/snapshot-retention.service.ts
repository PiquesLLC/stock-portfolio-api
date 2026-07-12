import prisma from '../utils/prisma';
import { alertOnCorruption } from './job-runner.service';

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
// via strftime in that exact shape so string comparison == chronological
// comparison with no same-day 'T'-vs-space edge (datetime('now') uses a
// space separator, which sorts BEFORE 'T' and would spare same-day rows).
//
// GATED OFF BY DEFAULT: deletes would fail (and alert) against a corrupt
// database. Set SNAPSHOT_RETENTION_ENABLED=true after the rebuild-and-swap.

const CHUNK = 5000;
const MAX_CHUNKS = 500;

// Cutoff in the exact stored ISO shape, e.g. strftime → '2026-06-11T04:05:06.789+00:00'
const isoCutoff = (modifier: string): string =>
  `strftime('%Y-%m-%dT%H:%M:%f+00:00','now','${modifier}')`;
const ISO_NOW = `strftime('%Y-%m-%dT%H:%M:%f+00:00','now')`;

// Exported for the real-engine integration test — statements must be pure SQL
// (no bound params) so they can be replayed against a scratch libsql database.
export const RETENTION_SQL = {
  // NOTE: "userId IS" (not "=") — userId is nullable and NULL = NULL is never
  // true, which would make legacy NULL-user snapshots immortal.
  portfolioSnapshotChunk: `DELETE FROM "PortfolioSnapshot" WHERE rowid IN (
    SELECT ps.rowid FROM "PortfolioSnapshot" ps
    WHERE ps."timestamp" < ${isoCutoff('-30 days')}
      AND ps."timestamp" <> (
        SELECT MAX(p2."timestamp") FROM "PortfolioSnapshot" p2
        WHERE p2."userId" IS ps."userId" AND date(p2."timestamp") = date(ps."timestamp")
      )
    LIMIT ${CHUNK})`,
  holdingSnapshotChunk: `DELETE FROM "HoldingSnapshot" WHERE rowid IN (
    SELECT rowid FROM "HoldingSnapshot"
    WHERE "timestamp" < ${isoCutoff('-30 days')}
    LIMIT ${CHUNK})`,
  refreshToken: `DELETE FROM "RefreshToken" WHERE "expiresAt" < ${ISO_NOW} OR "revokedAt" IS NOT NULL`,
  jobIdempotencyKey: `DELETE FROM "JobIdempotencyKey" WHERE "expiresAt" < ${ISO_NOW}`,
  backgroundJobRun: `DELETE FROM "BackgroundJobRun" WHERE "startedAt" < ${isoCutoff('-7 days')}`,
  analyticsEvent: `DELETE FROM "AnalyticsEvent" WHERE "createdAt" < ${isoCutoff('-90 days')}`,
  apiUsageLog: `DELETE FROM "ApiUsageLog" WHERE "createdAt" < ${isoCutoff('-90 days')}`,
} as const;

export function snapshotRetentionEnabled(): boolean {
  return process.env.SNAPSHOT_RETENTION_ENABLED === 'true';
}

type Exec = (sql: string) => Promise<number>;
const prismaExec: Exec = (sql) => prisma.$executeRawUnsafe(sql);

async function chunkedDelete(exec: Exec, sql: string, label: string, log: string[]): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const deleted = await exec(sql);
    total += deleted;
    if (deleted < CHUNK) break;
  }
  log.push(`${label}: deleted ${total}`);
  return total;
}

// `exec` is injectable so the integration test can run the real statements
// against a scratch libsql database instead of the prisma mock.
export async function runSnapshotRetention(exec: Exec = prismaExec): Promise<{ skipped: boolean; log: string[] }> {
  const log: string[] = [];
  if (!snapshotRetentionEnabled()) {
    return { skipped: true, log };
  }

  try {
    await chunkedDelete(exec, RETENTION_SQL.portfolioSnapshotChunk, 'PortfolioSnapshot (>30d, EOD kept)', log);
    await chunkedDelete(exec, RETENTION_SQL.holdingSnapshotChunk, 'HoldingSnapshot (>30d)', log);

    log.push(`RefreshToken: deleted ${await exec(RETENTION_SQL.refreshToken)}`);
    log.push(`JobIdempotencyKey: deleted ${await exec(RETENTION_SQL.jobIdempotencyKey)}`);
    log.push(`BackgroundJobRun (>7d): deleted ${await exec(RETENTION_SQL.backgroundJobRun)}`);
    log.push(`AnalyticsEvent (>90d): deleted ${await exec(RETENTION_SQL.analyticsEvent)}`);
    log.push(`ApiUsageLog (>90d): deleted ${await exec(RETENTION_SQL.apiUsageLog)}`);

    await exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
    log.push('WAL checkpoint: done');

    try {
      await exec(`PRAGMA incremental_vacuum`);
      log.push('incremental_vacuum: done');
    } catch (e) {
      log.push(`incremental_vacuum: skipped (${e instanceof Error ? e.message.slice(0, 80) : String(e)})`);
    }

    console.log(`[Retention] ${log.join(' | ')}`);
    return { skipped: false, log };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Retention] FAILED: ${msg} (completed: ${log.join(' | ') || 'nothing'})`);
    alertOnCorruption('snapshot-retention', msg);
    return { skipped: false, log };
  }
}

export function scheduleSnapshotRetention(): void {
  if (!snapshotRetentionEnabled()) {
    console.log('[Retention] Disabled (set SNAPSHOT_RETENTION_ENABLED=true after the DB rebuild)');
    return;
  }
  console.log('[Retention] Scheduled daily');
  setTimeout(() => { void runSnapshotRetention(); }, 2 * 60 * 1000);
  setInterval(() => { void runSnapshotRetention(); }, 24 * 60 * 60 * 1000);
}
