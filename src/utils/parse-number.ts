/**
 * Parse a value into a number, handling common brokerage CSV formats:
 * - Currency symbols: $, £, €, ¥
 * - Thousands separators: 1,234,567.89
 * - Parenthetical negatives: (1,234.56) → -1234.56
 * - Whitespace-only or empty strings → null
 * - Non-numeric strings → null
 */
export function parseNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    let cleaned = value.trim();
    if (!cleaned) return null;
    // Handle parenthetical negatives: (1,234.56) → -1234.56
    const isNegParen = cleaned.startsWith('(') && cleaned.endsWith(')');
    if (isNegParen) cleaned = cleaned.slice(1, -1);
    // Strip currency symbols and commas
    cleaned = cleaned.replace(/[$,\u00A3\u20AC\u00A5]/g, '').trim();
    if (!cleaned) return null;
    const num = Number(cleaned);
    if (!Number.isFinite(num)) return null;
    return isNegParen ? -num : num;
  }
  return null;
}
