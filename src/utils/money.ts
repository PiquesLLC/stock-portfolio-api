/**
 * Minor-unit (integer cents) money helpers — foundation for the Float→Int money
 * migration (see docs/CENTS-MIGRATION.md). Money AMOUNTS are stored + computed as
 * integer cents; convert to/from dollars only at the API / display boundary.
 *
 * IMPORTANT: `shares` (fractional) and per-share `price`/`averageCost` (fractional,
 * possibly sub-cent) are NOT money amounts — they stay floating point. Use these
 * helpers ONLY for money amounts: balances, transaction amounts, P/L, market value.
 */

/**
 * Dollars (float) → integer cents, rounded half-away-from-zero at the cent so that
 * positive and negative amounts round symmetrically (−0.005 → −1, +0.005 → +1).
 * Non-finite input is treated as 0 (defensive — never propagate NaN into money).
 */
export function toCents(dollars: number): number {
  if (!Number.isFinite(dollars)) return 0;
  return dollars >= 0 ? Math.round(dollars * 100) : -Math.round(-dollars * 100);
}

/** Integer cents → dollars (float). For display / API output only. */
export function fromCents(cents: number): number {
  if (!Number.isFinite(cents)) return 0;
  return cents / 100;
}

/**
 * Market value (cents) from fractional shares × per-share dollar price.
 * Centralises the one rounding decision so every snapshot/holding computes it the
 * same way. shares and pricePerShareDollars stay float; only the result is cents.
 */
export function valueToCents(shares: number, pricePerShareDollars: number): number {
  return toCents(shares * pricePerShareDollars);
}

/** Sum a list of cent amounts (integers); guards against float drift sneaking in. */
export function sumCents(values: number[]): number {
  return values.reduce((acc, v) => acc + Math.round(v), 0);
}
