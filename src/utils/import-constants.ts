/**
 * Import constants — re-exports broker/trade types from the canonical
 * settlement-policy module to avoid duplicate source-of-truth lists.
 */
import type { SourceBroker as _SourceBroker } from '../services/ledger/settlement-policy';

export {
  SOURCE_BROKERS,
  type SourceBroker,
  isValidSourceBroker,
  TRADE_EVENT_TYPES as TRADE_TYPES,
  type TradeEventType as TradeType,
} from '../services/ledger/settlement-policy';

/**
 * Normalize a sourceBroker value from user input.
 * Returns a valid canonical broker or 'mapped' as fallback.
 */
export { normalizeSourceBroker } from '../services/ledger/settlement-policy';

/**
 * Stable telemetry skip-reason keys. Do not rename — analytics depend on these.
 */
export const SKIP_REASONS = {
  INVALID_TICKER: 'invalid_ticker',
  INVALID_DATE: 'invalid_date',
  UNSUPPORTED_ACTION: 'unsupported_action',
  MISSING_NUMERIC: 'missing_numeric',
  EXCLUDED_BY_USER: 'excluded_by_user',
  INVALID_QTY_PRICE: 'invalid_qty_price',
} as const;

export type SkipReason = typeof SKIP_REASONS[keyof typeof SKIP_REASONS];

/**
 * Import telemetry contract.
 */
export interface ImportTelemetry {
  rowsParsed: number;
  rowsSkipped: number;
  skipReasons: Record<string, number>;
  brokerDetected: _SourceBroker | null;
  parseDurationMs: number;
}

/** Maximum rows accepted per mapped import. */
export const MAX_IMPORT_ROWS = 2000;
