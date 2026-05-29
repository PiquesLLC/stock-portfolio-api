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
//   0 — all clean (or only v2Missing entries, which is expected mid-rollout)
//   1 — at least one creator's v1 and v2 balances diverged

import { writeFileSync } from 'fs';
import {
  reconcileAllCreators,
  reconcileCreator,
  type CreatorReconcileResult,
} from '../src/v2/reconciliation/v1-vs-v2';

interface CliOptions {
  creatorId: string | null;
  divergentOut: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { creatorId: null, divergentOut: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--creator-id') opts.creatorId = argv[++i] ?? null;
    else if (a === '--divergent-out') opts.divergentOut = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: v1-vs-v2-reconcile [--creator-id <uuid>] [--divergent-out path.csv]',
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

  // Single-creator path
  if (opts.creatorId) {
    const result = await reconcileCreator(opts.creatorId);
    console.log('=== v1↔v2 reconciliation (single creator) ===');
    printResult(result, '');
    if (result.divergent) {
      console.error(`\nDIVERGENT: v1 - v2 = ${result.diffCents}c`);
      process.exit(1);
    }
    console.log('\nCLEAN.');
    process.exit(0);
  }

  // All creators
  console.log('=== v1↔v2 reconciliation (all creators) ===');
  const report = await reconcileAllCreators();
  console.log(`Started: ${report.startedAt.toISOString()}`);
  console.log(`Scanned: ${report.totalScanned} creators`);
  console.log(`Clean:   ${report.cleanCount}`);
  console.log(`v2 missing (no v2 account yet): ${report.v2Missing.length}`);
  console.log(`Divergent: ${report.divergent.length}`);

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

  process.exit(report.divergent.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[reconcile] FATAL:', err);
  process.exit(1);
});
