#!/usr/bin/env npx -y ts-node
// v1 ↔ v2 reconciliation CLI. Designed for:
//   - Daily cron during the shadow-write epoch
//   - Manual investigation when something looks off
//   - Pre-cutover verification: divergent.length === 0 → safe to cut over
//
// USAGE:
//   # All creators (default)
//   npx ts-node scripts/v1-vs-v2-reconcile.ts
//
//   # One creator (smoke test)
//   npx ts-node scripts/v1-vs-v2-reconcile.ts --creator-id <uuid>
//
//   # Write divergent results to CSV (for downstream alerting / spreadsheet)
//   npx ts-node scripts/v1-vs-v2-reconcile.ts --divergent-out drift.csv
//
// EXIT CODES:
//   Default (cron mode): always exit 0. Drift surfaces via CSV + log + stdout
//     so cron schedulers don't enter a failure-retry loop on legitimate drift.
//   --gate flag (cutover mode): exit 1 if ANY creator divergent. Use this
//     for the pre-cutover playbook ("must be 0 for 7 days before cutover").

import { writeFileSync } from 'fs';
import {
  reconcileAllCreators,
  reconcileCreator,
  type CreatorReconcileResult,
} from '../src/v2/reconciliation/v1-vs-v2';

interface CliOptions {
  creatorId: string | null;
  divergentOut: string | null;
  gate: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { creatorId: null, divergentOut: null, gate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--creator-id') opts.creatorId = argv[++i] ?? null;
    else if (a === '--divergent-out') opts.divergentOut = argv[++i] ?? null;
    else if (a === '--gate') opts.gate = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: v1-vs-v2-reconcile [--creator-id <uuid>] [--divergent-out path.csv] [--gate]\n\n' +
          '  --creator-id     reconcile one creator (smoke test)\n' +
          '  --divergent-out  write divergent creators to a CSV file\n' +
          '  --gate           exit 1 if ANY drift (use only for cutover gate;\n' +
          '                   omit for cron mode so the scheduler does not retry\n' +
          '                   on legitimate drift)',
      );
      process.exit(0);
    }
  }
  return opts;
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function printResult(r: CreatorReconcileResult, indent = '  '): void {
  const sign = r.diffCents > 0n ? '+' : '';
  console.log(
    `${indent}${r.creatorUserId}  v1=${r.v1BalanceCents}c  v2=${r.v2BalanceCents}c  ` +
      `diff=${sign}${r.diffCents}c  v1Rows=${r.v1RowCount}  v2Exists=${r.v2AccountExists}`,
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (!process.env.V2_DATABASE_URL) {
    console.error('[reconcile] ERROR: V2_DATABASE_URL is not set.');
    process.exit(2);
  }

  // Single-creator path
  if (opts.creatorId) {
    const result = await reconcileCreator(opts.creatorId);
    console.log('=== v1↔v2 reconciliation (single creator) ===');
    printResult(result, '');
    if (result.divergent) {
      console.error(`\nDIVERGENT: v1 - v2 = ${result.diffCents}c`);
      process.exit(opts.gate ? 1 : 0);
    }
    console.log('\nCLEAN.');
    process.exit(0);
  }

  // All creators
  console.log('=== v1↔v2 reconciliation (all creators) ===');
  const report = await reconcileAllCreators();
  console.log(`Started:    ${report.startedAt.toISOString()}`);
  console.log(`Finished:   ${report.finishedAt.toISOString()}`);
  console.log(`Duration:   ${report.durationMs}ms`);
  console.log(`Scanned:    ${report.totalScanned} creators`);
  console.log(`Clean:      ${report.cleanCount}`);
  console.log(`v2 missing: ${report.v2Missing.length} (no v2 account yet)`);
  console.log(`Divergent:  ${report.divergent.length}`);

  if (report.divergent.length > 0) {
    console.log('\nDivergent creators (showing first 20):');
    for (const d of report.divergent.slice(0, 20)) printResult(d);
  }

  if (opts.divergentOut && report.divergent.length > 0) {
    const lines: string[] = [
      'creatorUserId,v1BalanceCents,v2BalanceCents,diffCents,v1RowCount',
    ];
    for (const d of report.divergent) {
      lines.push(
        [
          d.creatorUserId,
          String(d.v1BalanceCents),
          String(d.v2BalanceCents),
          String(d.diffCents),
          String(d.v1RowCount),
        ]
          .map(csvEscape)
          .join(','),
      );
    }
    writeFileSync(opts.divergentOut, lines.join('\n') + '\n', 'utf8');
    console.log(`\nWrote ${report.divergent.length} divergent rows to ${opts.divergentOut}`);
  }

  // Default cron mode: exit 0 always (drift is reported via CSV + stdout +
  // log scraping). --gate mode: exit 1 if any divergence (cutover playbook).
  process.exit(opts.gate && report.divergent.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[reconcile] FATAL:', err);
  process.exit(1);
});
