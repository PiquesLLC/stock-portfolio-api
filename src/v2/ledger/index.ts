// Public API of the v2 ledger.
//
// Internal consumers (billing handlers, payout saga, dispute clawback) should
// import only from this barrel. Direct imports of post-transaction.ts,
// get-balance.ts, etc. should be avoided in application code — they're
// implementation files, not the contract.

export { postTransaction } from './post-transaction';
export { getBalance } from './get-balance';
export { replay } from './replay';
export { getLedgerClient, disconnectLedgerClientForTesting } from './prisma';

export { LedgerInvariantViolation } from './types';
export type {
  AccountScope,
  LedgerEventType,
  StripeObjectKind,
  LedgerEntryInput,
  PostTransactionInput,
  PostTransactionResult,
  PostedEntry,
  BalanceResult,
  ReplayResult,
} from './types';
