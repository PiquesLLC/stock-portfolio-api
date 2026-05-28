// Public API of the v2 ledger.
//
// Internal consumers (billing handlers, payout saga, dispute clawback) should
// import only from this barrel. Direct imports of post-transaction.ts,
// get-balance.ts, etc. should be avoided in application code — they're
// implementation files, not the contract.
//
// ⚠️  RUNTIME PREREQUISITES (read before wiring into v1 code paths) ⚠️
// As of this writing, NO production caller imports from this module — Railway
// builds and runs without touching it. The moment any v1 service imports
// from `../v2/ledger`, the following MUST be in place on every environment
// that loads the import:
//   1. V2_DATABASE_URL set to a real, reachable Postgres connection string.
//      (Build-time placeholder won't connect at runtime.)
//   2. v2 migrations applied:
//        npm run prisma:v2:migrate:deploy
//      The v1 `start.sh` runs `prisma migrate deploy` against v1 ONLY.
//      v2 migrations are NOT auto-applied on Railway today.
//   3. v2 seed data present:
//        npm run prisma:v2:seed
//      (Idempotent — safe to re-run.)
// If you wire this import in without (1)/(2)/(3), the first call to
// getLedgerClient() will either crash on missing env or hit "Account
// stripe_clearing:platform does not exist" from the trigger.

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
