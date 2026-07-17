// Shared derivation of a heatmap tile's session-aware change/price fields from a
// live quote. Used by themes-heatmap and etf-heatmap (the market heatmap has its
// own richer path with candle fallbacks). Extracted so the two services can't drift
// — the previous copies were byte-identical and only computed the extended value.

export type HeatmapQuoteSource = 'regular' | 'extended' | 'prevClose';

export interface HeatmapQuoteFields {
  /** Extended-hours-inclusive 1D change % (the default the tile shows). */
  changePercent: number;
  /** Display price — the after-hours price during PRE/POST, else the regular price. */
  price: number;
  /** Regular-session 1D change % (what the After-hours→Regular toggle flips to). */
  regularChangePercent: number;
  /** Regular-session price (regular close vs the after-hours print). */
  regularPrice: number;
  source: HeatmapQuoteSource;
}

export interface HeatmapQuoteInput {
  currentPrice: number;
  previousClose: number;
  change: number;
  changePercent: number;
  extendedPrice?: number | null;
  extendedChangePercent?: number | null;
  /** Most recent completed regular-session close (4 PM). Set by every provider that sets extendedPrice. */
  regularClose?: number | null;
}

/**
 * Derive the tile fields from a quote.
 *
 * - `changePercent`/`price`/`source` are computed exactly as the old inline blocks did
 *   (behavior-preserving): during extended hours the change is the TOTAL move from
 *   previousClose using extendedPrice (Finviz-style), and the price is the extended print.
 * - `regularChangePercent`/`regularPrice`: the regular-session move, anchored on
 *   `regularClose` (the true 4 PM close). Every provider that sets `extendedPrice`
 *   ALSO writes the extended print into `currentPrice`, so deriving the regular %
 *   from `currentPrice` (or from `quote.changePercent`, which carries the same
 *   overlay) collapses the toggle into a no-op. Quotes without `regularClose` fall
 *   back to `currentPrice` (blended — pre-existing behavior). Without an extended
 *   print, the regular move IS `changePercent`.
 */
export function deriveHeatmapQuoteFields(quote: HeatmapQuoteInput): HeatmapQuoteFields {
  // extendedChangePercent is optional: the fetchPrices Yahoo overlay writes only
  // extendedPrice + regularClose, and regularClose alone is enough to split the
  // sessions. Either signal qualifies the quote as extended.
  const hasExtended = quote.extendedPrice != null && quote.extendedPrice > 0
    && (quote.extendedChangePercent != null || (quote.regularClose ?? 0) > 0);
  const regularAnchor = (quote.regularClose ?? 0) > 0 ? quote.regularClose! : quote.currentPrice;
  const regularPrice = hasExtended ? regularAnchor : quote.currentPrice;
  const price = hasExtended ? quote.extendedPrice! : quote.currentPrice;

  let changePercent: number;
  if (hasExtended && quote.previousClose > 0) {
    changePercent = ((quote.extendedPrice! - quote.previousClose) / quote.previousClose) * 100;
  } else {
    changePercent = quote.changePercent;
  }

  const regularChangePercent = (hasExtended && quote.previousClose > 0)
    ? ((regularAnchor - quote.previousClose) / quote.previousClose) * 100
    : changePercent;

  // prevClose fallback: no real trade — price equals previousClose and change is 0.
  const isPrevCloseFallback = !hasExtended
    && quote.changePercent === 0
    && quote.change === 0
    && quote.currentPrice === quote.previousClose
    && quote.previousClose > 0;

  const source: HeatmapQuoteSource = hasExtended ? 'extended'
    : isPrevCloseFallback ? 'prevClose'
    : 'regular';

  return { changePercent, price, regularChangePercent, regularPrice, source };
}
