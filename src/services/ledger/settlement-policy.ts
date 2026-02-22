/**
 * Settlement Policy — Ledger Replay v1
 *
 * Defines posting rules for trade events (PortfolioTrade) and ledger events
 * (LedgerEvent). The replay engine uses these to determine when cash and
 * position changes take effect.
 *
 * Convention:
 *   - 'effectiveDate' = trade/event date (when it happened)
 *   - 'settleDate'    = settlement date (T+1 for equities, same-day for cash)
 *   - 'none'          = no effect on that dimension
 */

// ─── Trade Event Types (PortfolioTrade.type) ────────────────────────

export const TRADE_EVENT_TYPES = [
  'buy',
  'sell',
  'split',
  'transfer',
  'merger',
  'cancel',
] as const;

export type TradeEventType = (typeof TRADE_EVENT_TYPES)[number];

// ─── Ledger Event Types (LedgerEvent.eventType) ────────────────────

export const LEDGER_EVENT_TYPES = [
  'DEPOSIT',
  'WITHDRAWAL',
  'CASH_DIVIDEND',
  'DIV_REINVEST',
  'INTEREST',
  'FEE',
  'MARGIN_BORROW',
  'MARGIN_REPAY',
] as const;

export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

// ─── Source Broker (LedgerEvent.sourceBroker) ───────────────────────

export const SOURCE_BROKERS = [
  'robinhood',
  'schwab',
  'mapped',
  'plaid',
  'unknown',
] as const;

export type SourceBroker = (typeof SOURCE_BROKERS)[number];

// ─── Settlement Policy ──────────────────────────────────────────────

type PostingDate = 'effectiveDate' | 'settleDate' | 'none';

export interface SettlementPolicy {
  /** When cash movement posts */
  cashPosting: PostingDate;
  /** When position (shares) change posts */
  positionPosting: PostingDate;
}

/**
 * Trade events: positions change on trade date, cash settles on T+1.
 * For splits/transfers/mergers, no cash impact.
 */
export const TRADE_SETTLEMENT_POLICY: Record<TradeEventType, SettlementPolicy> = {
  buy:      { cashPosting: 'settleDate',   positionPosting: 'effectiveDate' },
  sell:     { cashPosting: 'settleDate',   positionPosting: 'effectiveDate' },
  cancel:   { cashPosting: 'settleDate',   positionPosting: 'effectiveDate' },
  split:    { cashPosting: 'none',         positionPosting: 'effectiveDate' },
  transfer: { cashPosting: 'none',         positionPosting: 'effectiveDate' },
  merger:   { cashPosting: 'none',         positionPosting: 'effectiveDate' },
};

/**
 * Ledger events: cash-only events post on effective date.
 * DIV_REINVEST adds shares with no cash movement.
 */
export const LEDGER_SETTLEMENT_POLICY: Record<LedgerEventType, SettlementPolicy> = {
  DEPOSIT:       { cashPosting: 'effectiveDate', positionPosting: 'none' },
  WITHDRAWAL:    { cashPosting: 'effectiveDate', positionPosting: 'none' },
  CASH_DIVIDEND: { cashPosting: 'effectiveDate', positionPosting: 'none' },
  DIV_REINVEST:  { cashPosting: 'none',          positionPosting: 'effectiveDate' },
  INTEREST:      { cashPosting: 'effectiveDate', positionPosting: 'none' },
  FEE:           { cashPosting: 'effectiveDate', positionPosting: 'none' },
  MARGIN_BORROW: { cashPosting: 'effectiveDate', positionPosting: 'none' },
  MARGIN_REPAY:  { cashPosting: 'effectiveDate', positionPosting: 'none' },
};

// ─── Validation helpers ─────────────────────────────────────────────

const ledgerEventTypeSet = new Set<string>(LEDGER_EVENT_TYPES);
const sourceBrokerSet = new Set<string>(SOURCE_BROKERS);

export function isValidLedgerEventType(value: string): value is LedgerEventType {
  return ledgerEventTypeSet.has(value);
}

export function isValidSourceBroker(value: string): value is SourceBroker {
  return sourceBrokerSet.has(value);
}

/** Normalize user-provided sourceBroker; falls back to 'mapped'. */
export function normalizeSourceBroker(value: unknown): SourceBroker {
  if (typeof value !== 'string') return 'mapped';
  const normalized = value.trim().toLowerCase();
  return isValidSourceBroker(normalized) ? normalized : 'mapped';
}
