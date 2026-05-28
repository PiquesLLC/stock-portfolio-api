// Type definitions for the v2 ledger service.
//
// Currency: always ISO-4217 alpha codes (USD, EUR). The DB column is CHAR(3);
// callers should always pass uppercase. We never auto-uppercase — silent
// mutation hides bugs.
//
// Amounts: always BigInt minor units (cents for USD). The DB columns are
// BIGINT; JavaScript's Number cannot safely represent values >2^53, and
// monetary precision must NEVER use floats.

export type AccountScope =
  | 'creator'
  | 'platform_revenue'
  | 'platform_fee'
  | 'tax_withholding'
  | 'stripe_clearing';

export type LedgerEventType =
  // Forward (architecture §3.2)
  | 'EARNING_GROSS'
  | 'PLATFORM_FEE'
  | 'STRIPE_FEE_PASS'
  | 'TAX_WITHHOLDING'
  | 'PAYOUT_INITIATED'
  | 'PAYOUT_PAID'
  | 'ADJUSTMENT_CREDIT'
  | 'ADJUSTMENT_DEBIT'
  // Reversal / compensation
  | 'EARNING_REFUNDED'
  | 'PLATFORM_FEE_REFUNDED'
  | 'DISPUTE_FROZEN'
  | 'DISPUTE_LOST'
  | 'DISPUTE_WON'
  | 'RESTORE_AFTER_DISPUTE_WON'
  | 'PAYOUT_FAILED'
  | 'PAYOUT_REVERSED';

export type StripeObjectKind = 'charge' | 'transfer' | 'payout' | 'dispute' | 'refund';

export type LedgerEntryInput = {
  accountScope: AccountScope;
  accountId: string;
  eventType: LedgerEventType;
  /** Non-negative; exactly one of debit/credit must be > 0 (INV-1). */
  debitMinorUnits: bigint;
  /** Non-negative; exactly one of debit/credit must be > 0 (INV-1). */
  creditMinorUnits: bigint;
  /** ISO-4217 uppercase; must match the account's currency (DB trigger enforces). */
  currency: string;
  /**
   * Appended to eventGroupId to form the row's idempotency_key. Within one
   * postTransaction call, each entry's suffix must be unique across the
   * entries (otherwise two entries collide on (creatorUserId, idempotency_key)).
   * Typical scheme: 'creator_share' | 'platform_fee' | 'stripe_clearing' | etc.
   */
  idempotencySuffix: string;
  stripeObjectKind?: StripeObjectKind | null;
  stripeObjectId?: string | null;
  stripeEventId?: string | null;
  /**
   * For reversal/compensation entries. References a prior entry whose effect
   * this one undoes. The referenced entry must have the inverse shape
   * (debit↔credit, same magnitude, same currency, same account). Application
   * code does the shape check; postTransaction loads the referent to verify.
   */
  reversesEntryId?: string | null;
  metadata?: Record<string, unknown>;
};

export type PostTransactionInput = {
  /** UUID v4 or v7; all entries in this call share this id. */
  eventGroupId: string;
  /**
   * When this event was economically real (Stripe's event.created, not now()).
   * Used for reconciliation matching; out-of-order is acceptable.
   */
  effectiveAt: Date;
  /**
   * Actor that posted: 'webhook:invoice.paid' | 'job:payout-runner' | 'ops:<userId>'.
   * Forensics-friendly; goes into the ledger_entry.posted_by column.
   */
  postedBy: string;
  entries: LedgerEntryInput[];
};

export type PostedEntry = {
  id: string;
  accountScope: AccountScope;
  accountId: string;
  sequenceNo: bigint;
  eventType: LedgerEventType;
  debitMinorUnits: bigint;
  creditMinorUnits: bigint;
  /** Account's running balance AFTER this entry. Computed by the DB trigger. */
  runningBalanceMinorUnits: bigint;
};

export type PostTransactionResult = {
  eventGroupId: string;
  entries: PostedEntry[];
  /**
   * True iff the call was idempotent-deduped (some entry's idempotency_key
   * collided with a prior post). Caller can ignore or branch on this; the
   * returned entries are the canonical state regardless.
   */
  deduplicated: boolean;
};

export type BalanceResult = {
  accountScope: AccountScope;
  accountId: string;
  balanceMinorUnits: bigint;
  /** Null if the account doesn't exist; otherwise the account's currency. */
  currency: string | null;
  lastSequenceNo: bigint | null;
  exists: boolean;
};

export type ReplayResult = {
  accountScope: AccountScope;
  accountId: string;
  /** Balance from the latest entry's running_balance column (the cached value). */
  fromRunningBalance: bigint;
  /** Balance computed by summing all entries from sequence 1 (the proof). */
  fromReplay: bigint;
  /** fromRunningBalance - fromReplay. Should always be 0. */
  deltaMinorUnits: bigint;
  /** True iff delta is 0. False indicates trigger corruption or trigger bypass. */
  isConvergent: boolean;
  entriesScanned: number;
};

/**
 * Thrown by postTransaction for application-level invariant violations.
 * The `invariant` field identifies which INV from the architecture.
 */
export class LedgerInvariantViolation extends Error {
  constructor(
    public readonly invariant: 'INV-1' | 'INV-2' | 'INV-3' | 'INV-5',
    message: string,
  ) {
    super(message);
    this.name = 'LedgerInvariantViolation';
  }
}
