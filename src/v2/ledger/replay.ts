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
