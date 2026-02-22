/**
 * Canonical broker identifiers for sourceBroker field.
 * Enforced at application level (SQLite doesn't support DB enums).
 */
export const SOURCE_BROKERS = ['robinhood', 'schwab', 'mapped'] as const;
export type SourceBroker = typeof SOURCE_BROKERS[number];

export function isValidSourceBroker(value: unknown): value is SourceBroker {
  return typeof value === 'string' && (SOURCE_BROKERS as readonly string[]).includes(value);
}

/**
 * Canonical trade types accepted by the replay engine.
 * Anything not in this set is skipped with 'unsupported_action' telemetry.
 */
export const TRADE_TYPES = ['buy', 'sell', 'split', 'transfer', 'merger', 'cancel'] as const;
export type TradeType = typeof TRADE_TYPES[number];

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
  brokerDetected: string | null;
  parseDurationMs: number;
}

/** Maximum rows accepted per mapped import. */
export const MAX_IMPORT_ROWS = 2000;
