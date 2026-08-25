/**
 * Canonical Apple product -> Nala plan mapping.
 *
 * Centralized here so the reconciler and any future Apple code share one table.
 * `apple-iap.service.ts` still carries a private copy of the same map; it is not
 * touched by this PR (scope), so converging it onto this module is a follow-up.
 * The two tables are identical today — if they ever diverge, THIS one is
 * authoritative for snapshot normalization.
 *
 * IMPORTANT DIFFERENCE FROM THE LEGACY COPY: an unknown product is an ERROR
 * here, not 'free'. Mapping an unrecognised product to the free tier would let a
 * paid subscription be normalized into a snapshot that says the customer has
 * nothing — silently, and with Apple reporting the subscription as active.
 */

export class UnknownAppleProductError extends Error {
  constructor(readonly productId: string) {
    super(`unknown Apple product id: ${productId}`);
    this.name = 'UnknownAppleProductError';
  }
}

export const APPLE_PRODUCT_PLAN: Readonly<Record<string, string>> = Object.freeze({
  nala_pro_monthly: 'pro',
  nala_pro_yearly: 'pro',
  nala_premium_monthly: 'premium',
  nala_premium_yearly: 'premium',
  nala_elite_monthly: 'elite',
  nala_elite_yearly: 'elite',
});

/** Throws UnknownAppleProductError rather than defaulting. */
export function planForAppleProduct(productId: string): string {
  const plan = APPLE_PRODUCT_PLAN[productId];
  if (!plan) throw new UnknownAppleProductError(productId);
  return plan;
}
