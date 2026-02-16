/**
 * Parse OCC-format option symbols into structured data.
 *
 * OCC format: {UNDERLYING}{YYMMDD}{C|P}{STRIKE×1000, 8 digits}
 * Example: AAPL260320C00230000 → AAPL, 2026-03-20, call, $230.00
 */

export interface ParsedOption {
  underlying: string;
  expiry: string;      // ISO date: "2026-03-20"
  type: 'call' | 'put';
  strike: number;      // e.g., 230.00
}

// OCC symbol: 1-6 letter underlying + 6-digit date + C/P + 8-digit strike
const OCC_RE = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/;

export function parseOccSymbol(symbol: string): ParsedOption | null {
  const clean = symbol.trim().toUpperCase();
  const match = clean.match(OCC_RE);
  if (!match) return null;

  const [, underlying, dateStr, typeChar, strikeStr] = match;

  // Parse YYMMDD
  const yy = parseInt(dateStr.slice(0, 2), 10);
  const mm = parseInt(dateStr.slice(2, 4), 10);
  const dd = parseInt(dateStr.slice(4, 6), 10);

  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  const year = 2000 + yy;
  const expiry = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;

  // Strike: last 3 digits are decimals → divide by 1000
  const strike = parseInt(strikeStr, 10) / 1000;
  if (strike <= 0 || !Number.isFinite(strike)) return null;

  return {
    underlying,
    expiry,
    type: typeChar === 'C' ? 'call' : 'put',
    strike,
  };
}

/**
 * Check if an option contract has expired (expiry date is before today).
 */
export function isExpired(expiry: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiryDate = new Date(expiry + 'T00:00:00');
  return expiryDate < today;
}

/**
 * Days until expiration. Returns negative if expired.
 */
export function daysToExpiry(expiry: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiryDate = new Date(expiry + 'T00:00:00');
  return Math.round((expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Format an option for display: "AAPL $230 Call 3/20/26"
 */
export function formatOptionDisplay(parsed: ParsedOption): string {
  const [year, month, day] = parsed.expiry.split('-');
  const shortYear = year.slice(2);
  const typeLabel = parsed.type === 'call' ? 'Call' : 'Put';
  return `${parsed.underlying} $${parsed.strike} ${typeLabel} ${parseInt(month)}/${parseInt(day)}/${shortYear}`;
}
