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
}

/**
 * Derive the tile fields from a quote.
 *
 * - `changePercent`/`price`/`source` are computed exactly as the old inline blocks did
 *   (behavior-preserving): during extended hours the change is the TOTAL move from
 *   previousClose using extendedPrice (Finviz-style), and the price is the extended print.
 * - `regularChangePercent`/`regularPrice` are NEW: the regular-session move. When an
 *   extended print is present we derive the regular % from `currentPrice` vs
 *   `previousClose` — NOT from `quote.changePercent`, which can already carry the
 *   after-hours overlay (using it would collapse the toggle). Without an extended
 *   print, the regular move IS `changePercent`.
 */
export function deriveHeatmapQuoteFields(quote: HeatmapQuoteInput): HeatmapQuoteFields {
  const hasExtended = quote.extendedChangePercent != null && quote.extendedPrice != null;
  const regularPrice = quote.currentPrice;
  const price = hasExtended ? quote.extendedPrice! : quote.currentPrice;

  let changePercent: number;
  if (hasExtended && quote.previousClose > 0) {
    changePercent = ((quote.extendedPrice! - quote.previousClose) / quote.previousClose) * 100;
  } else {
    changePercent = quote.changePercent;
  }

  const regularChangePercent = (hasExtended && quote.previousClose > 0)
    ? ((quote.currentPrice - quote.previousClose) / quote.previousClose) * 100
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
