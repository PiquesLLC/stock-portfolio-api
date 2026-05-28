// getBalance — the production read path for an account's current balance.
//
// O(log n) single index lookup on the latest entry's running_balance column.
// This is what API endpoints and dashboard queries use. For audit /
// proof-of-correctness, use replay() instead.
//
// IMPORTANT — NOT SAFE FOR PAYOUT ELIGIBILITY:
//   This function issues two non-transactional queries (account lookup +
//   latest-entry lookup) outside any transaction. Under concurrent writes,
//   the returned values can be from snapshots seconds apart. That's fine
//   for displaying balance in a dashboard; it is NOT fine for deciding
//   "may we send $X to this creator?" because a clawback could post
//   between the read and the payout decision.
//
//   When the payout saga lands, it MUST acquire a row lock on the latest
//   ledger entry (SELECT ... FOR UPDATE) inside a transaction, OR use a
//   pessimistic balance reservation pattern. Do NOT call getBalance() from
//   payout eligibility code paths.
//
// Behavior on missing account:
//   - If the account doesn't exist (no rows in `accounts`), returns
//     { exists: false, balanceMinorUnits: 0n, currency: null }.
//   - If the account exists but has no ledger entries yet, returns
//     { exists: true, balanceMinorUnits: 0n, currency: <decl>, lastSeq: null }.
//
// Callers should distinguish via the `exists` flag — getting "0" for a
// non-existent account would silently mask a referent typo.

import { getLedgerClient } from './prisma';
import { AccountScope, BalanceResult } from './types';

export async function getBalance(
  accountScope: AccountScope,
  accountId: string,
): Promise<BalanceResult> {
  const prisma = getLedgerClient();

  const account = await prisma.account.findUnique({
    where: { accountScope_accountId: { accountScope, accountId } },
    select: { currency: true },
  });

  if (!account) {
    return {
      accountScope,
      accountId,
      balanceMinorUnits: 0n,
      currency: null,
      lastSequenceNo: null,
      exists: false,
    };
  }

  // Latest entry by sequence_no — the (account_scope, account_id, sequence_no)
  // UNIQUE index makes this an O(log n) lookup.
  const latestEntry = await prisma.ledgerEntry.findFirst({
    where: { accountScope, accountId },
    orderBy: { sequenceNo: 'desc' },
    select: { sequenceNo: true, runningBalanceMinorUnits: true },
  });

  return {
    accountScope,
    accountId,
    balanceMinorUnits: latestEntry?.runningBalanceMinorUnits ?? 0n,
    // CHAR(3) values are sometimes space-padded by Postgres clients; trim
    // defensively. The seed inserts 'USD' so this is a no-op in practice.
    currency: account.currency.trim(),
    lastSequenceNo: latestEntry?.sequenceNo ?? null,
    exists: true,
  };
}
