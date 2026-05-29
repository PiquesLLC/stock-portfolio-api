#!/usr/bin/env npx -y ts-node
// MIG-1: backfill v1 CreatorWalletLedger → v2 double-entry ledger.
//
// USAGE:
//   # Dry-run (default): scan, bucket, report counts — no DB writes to v2.
//   npx ts-node scripts/mig-1-backfill.ts
//
//   # Apply: actually post to v2. Requires NALA_ALLOW_MIGRATION_BACKFILL=true.
//   NALA_ALLOW_MIGRATION_BACKFILL=true npx ts-node scripts/mig-1-backfill.ts --apply
//
//   # Single-creator mode (smoke test before full-fleet).
//   npx ts-node scripts/mig-1-backfill.ts --creator-id <uuid>
//
// Idempotent: each group's v2 eventGroupId is a deterministic UUID from
// the v1 key, so postTransaction's idempotency dedup means re-runs are
// safe. Run as many times as you want.

import v1Prisma from '../src/utils/prisma';
import { postTransaction } from '../src/v2/ledger';
import {
  bucketV1Rows,
  mapV1GroupToV2Event,
  type V1LedgerRow,
} from '../src/v2/migration/v1-to-v2-mapper';

interface CliOptions {
  apply: boolean;
  creatorId: string | null;
  limit: number | null;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { apply: false, creatorId: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--creator-id') opts.creatorId = argv[++i] ?? null;
    else if (a === '--limit') opts.limit = parseInt(argv[++i] ?? '0', 10) || null;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: mig-1-backfill [--apply] [--creator-id <uuid>] [--limit N]\n\n' +
          '  --apply         actually write to v2 (default: dry-run)\n' +
          '  --creator-id    only backfill this one creator (smoke test)\n' +
          '  --limit         cap the number of v1 rows scanned (debug)',
      );
      process.exit(0);
    }
  }
  return opts;
}

interface BackfillStats {
  v1RowsScanned: number;
  groupsBucketed: number;
  unbucketed: number;
  mapped: number;
  deferred: Map<string, number>;
  malformed: Map<string, number>;
  v2Posted: number;
  v2Deduplicated: number;
  v2Errors: Array<{ groupKey: string; error: string }>;
}

function newStats(): BackfillStats {
  return {
    v1RowsScanned: 0,
    groupsBucketed: 0,
    unbucketed: 0,
    mapped: 0,
    deferred: new Map(),
    malformed: new Map(),
    v2Posted: 0,
    v2Deduplicated: 0,
    v2Errors: [],
  };
}

async function readV1Rows(opts: CliOptions): Promise<V1LedgerRow[]> {
  const where: Record<string, unknown> = {};
  if (opts.creatorId) where.creatorUserId = opts.creatorId;
  const findArgs: Record<string, unknown> = {
    where,
    orderBy: { createdAt: 'asc' },
  };
  if (opts.limit) findArgs.take = opts.limit;
  const rows = await (v1Prisma as unknown as {
    creatorWalletLedger: { findMany: (args: unknown) => Promise<V1LedgerRow[]> };
  }).creatorWalletLedger.findMany(findArgs);
  return rows;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const stats = newStats();
  const mode = opts.apply ? 'APPLY' : 'DRY-RUN';

  console.log(`[mig-1] ${mode} — scoped=${opts.creatorId ?? 'all-creators'} limit=${opts.limit ?? 'none'}`);

  if (opts.apply && process.env.NALA_ALLOW_MIGRATION_BACKFILL !== 'true') {
    console.error(
      '[mig-1] ERROR: --apply requires NALA_ALLOW_MIGRATION_BACKFILL=true in the env. ' +
        'Refusing to run to prevent accidental production backfills.',
    );
    process.exit(2);
  }
  if (opts.apply && !process.env.V2_DATABASE_URL) {
    console.error('[mig-1] ERROR: --apply requires V2_DATABASE_URL to be set.');
    process.exit(2);
  }

  // 1. READ
  const v1Rows = await readV1Rows(opts);
  stats.v1RowsScanned = v1Rows.length;
  console.log(`[mig-1] read ${v1Rows.length} v1 rows`);

  // 2. BUCKET
  const { groups, unbucketed } = bucketV1Rows(v1Rows);
  stats.groupsBucketed = groups.size;
  stats.unbucketed = unbucketed.length;
  console.log(`[mig-1] bucketed into ${groups.size} groups; ${unbucketed.length} unbucketed`);

  // 3. MAP + (optionally) WRITE
  for (const [groupKey, rows] of groups.entries()) {
    const outcome = mapV1GroupToV2Event(groupKey, rows);
    if (outcome.kind === 'deferred') {
      stats.deferred.set(outcome.reason, (stats.deferred.get(outcome.reason) ?? 0) + 1);
      continue;
    }
    if (outcome.kind === 'malformed') {
      stats.malformed.set(outcome.reason, (stats.malformed.get(outcome.reason) ?? 0) + 1);
      console.warn(`[mig-1] MALFORMED ${groupKey}: ${outcome.reason}`);
      continue;
    }
    stats.mapped += 1;

    if (!opts.apply) {
      continue;
    }

    // APPLY path
    try {
      const result = await postTransaction(outcome.event);
      if (result.deduplicated) {
        stats.v2Deduplicated += 1;
      } else {
        stats.v2Posted += 1;
      }
    } catch (err) {
      stats.v2Errors.push({ groupKey, error: (err as Error).message });
      console.error(`[mig-1] POST FAILED for ${groupKey}: ${(err as Error).message}`);
    }
  }

  // 4. REPORT
  console.log('\n=== MIG-1 SUMMARY ===');
  console.log(`Mode: ${mode}`);
  console.log(`v1 rows scanned:        ${stats.v1RowsScanned}`);
  console.log(`Groups bucketed:        ${stats.groupsBucketed}`);
  console.log(`Unbucketed (review):    ${stats.unbucketed}`);
  console.log(`Mapped (translatable):  ${stats.mapped}`);
  console.log(`Deferred shapes:        ${[...stats.deferred.values()].reduce((a, b) => a + b, 0)}`);
  for (const [reason, count] of stats.deferred.entries()) {
    console.log(`  ${count} × ${reason}`);
  }
  console.log(`Malformed:              ${[...stats.malformed.values()].reduce((a, b) => a + b, 0)}`);
  for (const [reason, count] of stats.malformed.entries()) {
    console.log(`  ${count} × ${reason}`);
  }
  if (opts.apply) {
    console.log(`v2 newly posted:        ${stats.v2Posted}`);
    console.log(`v2 dedup-skipped:       ${stats.v2Deduplicated}`);
    console.log(`v2 errors:              ${stats.v2Errors.length}`);
    for (const e of stats.v2Errors.slice(0, 10)) {
      console.log(`  ${e.groupKey}: ${e.error.slice(0, 200)}`);
    }
  }

  process.exit(stats.v2Errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[mig-1] FATAL:', err);
  process.exit(1);
});
