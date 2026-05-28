// replay — the proof-of-correctness path. Computes balance two ways and
// asserts they match.
//
// Why this exists: the running_balance_minor_units column on each ledger
// entry is denormalized state. The trigger that populates it is correct,
// but trigger bugs or break-glass operations (ledger_admin role) could
// corrupt history without the running_balance updates. The only way to
// catch that is to compute the balance independently and compare.
//
// This is the foundation of convergent verification:
//   Method A (getBalance):  single index lookup on latest entry. O(log n).
//   Method B (replay):      sum credits - sum debits from sequence 1. O(n).
//   They MUST be equal. Any divergence is an incident.
//
// reconciliation Tier 2 runs replay() across all accounts nightly and
// alerts on any non-convergent result.
//
// SCALE NOTE: this implementation loads the entire history into Node memory
// (via findMany without take). That's fine up to ~50k entries per account
// (~5 MB at ~100 bytes/row). Beyond that — once an active creator crosses
// ~10k subscribers, or once the platform crosses ~1M total entries — this
// must be rewritten to either:
//   (a) push the sum to Postgres:
//       SELECT SUM(credit_minor_units - debit_minor_units) FROM ledger_entry
//       WHERE account_scope=$1 AND account_id=$2;
//   (b) cursor-paginate via $queryRaw with a streamed accumulator.
// Option (a) is preferable but only valid AFTER bigint-arithmetic precision
// is verified at scale (Postgres's NUMERIC handles arbitrary precision,
// BIGINT is i64 — sum of 1M entries of $10000 each is well within i64).
// TODO(scale): rewrite as Postgres-side SUM when any single account
// exceeds 50k entries.

import { getLedgerClient } from './prisma';
import { AccountScope, ReplayResult } from './types';

export async function replay(
  accountScope: AccountScope,
  accountId: string,
): Promise<ReplayResult> {
  const prisma = getLedgerClient();

  const allEntries = await prisma.ledgerEntry.findMany({
    where: { accountScope, accountId },
    orderBy: { sequenceNo: 'asc' },
    select: {
      sequenceNo: true,
      debitMinorUnits: true,
      creditMinorUnits: true,
      runningBalanceMinorUnits: true,
    },
  });

  // Method B: sum from scratch.
  let fromReplay = 0n;
  for (const entry of allEntries) {
    fromReplay += entry.creditMinorUnits - entry.debitMinorUnits;
  }

  // Method A: the cached running_balance on the latest entry.
  const fromRunningBalance =
    allEntries.length > 0
      ? allEntries[allEntries.length - 1].runningBalanceMinorUnits
      : 0n;

  const deltaMinorUnits = fromRunningBalance - fromReplay;

  return {
    accountScope,
    accountId,
    fromRunningBalance,
    fromReplay,
    deltaMinorUnits,
    isConvergent: deltaMinorUnits === 0n,
    entriesScanned: allEntries.length,
  };
}
