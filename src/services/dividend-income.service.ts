import { ETF_REFERENCE_DATA } from './market.service';

function round(value: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export interface ForwardIncomeHolding {
  ticker: string;
  shares: number;
  currentPrice?: number | null;
  currentValue?: number | null;
}

export interface ForwardIncomePerTicker {
  ticker: string;
  /** Forward annual dividend per share (rounded). */
  annualDivPerShare: number;
  /** Forward annual income for this holding = perShare * shares (rounded). */
  annualIncome: number;
  /** Forward yield = perShare / currentPrice, % (null if no price). */
  yieldPct: number | null;
}

export interface ForwardIncomeResult {
  totalAnnualIncome: number;
  totalMonthlyIncome: number;
  /** Forward portfolio dividend yield = annual income / total market value, %.
   *  Divides by the canonical valuation (sum of currentValue), NOT a simple
   *  average of per-holding yields. Null when total value is 0. */
  portfolioYieldPct: number | null;
  byTicker: Map<string, ForwardIncomePerTicker>;
}

/**
 * Canonical FORWARD annual dividend income for a set of holdings — the single
 * definition of "annual income" shared by income-insights and dividend-growth
 * (and therefore every UI surface), so the figure can no longer disagree
 * between screens.
 *
 * Per-share source priority (one place, one order):
 *   1. ScreenerCache.annualDividend (Polygon forward annual $/share), passed in
 *      via `screenerAnnualDivByTicker` (callers already fetch this).
 *   2. ETF_REFERENCE_DATA[ticker].dividendYield × currentPrice (ETF fallback).
 *   3. 0 -> treated as a non-payer and omitted from `byTicker`.
 *
 * This is forward-looking (current holdings x current forward rate), distinct
 * from realized/trailing dividends actually received (which income-insights
 * still tracks separately for reliability/momentum).
 */
export function computeForwardAnnualIncome(
  holdings: ForwardIncomeHolding[],
  screenerAnnualDivByTicker: Map<string, number>,
): ForwardIncomeResult {
  const byTicker = new Map<string, ForwardIncomePerTicker>();
  let totalAnnualIncome = 0;
  let totalValue = 0;

  for (const h of holdings) {
    const ticker = h.ticker.toUpperCase();
    const price = h.currentPrice ?? 0;
    if (h.currentValue && h.currentValue > 0) totalValue += h.currentValue;

    let perShare = screenerAnnualDivByTicker.get(ticker) ?? 0;
    if (perShare <= 0 && price > 0) {
      const etfRef = ETF_REFERENCE_DATA[ticker];
      if (etfRef?.dividendYield && etfRef.dividendYield > 0) {
        perShare = (etfRef.dividendYield / 100) * price;
      }
    }
    if (perShare <= 0) continue; // non-dividend payer

    const annualIncome = perShare * h.shares;
    totalAnnualIncome += annualIncome;
    byTicker.set(ticker, {
      ticker,
      annualDivPerShare: round(perShare, 2),
      annualIncome: round(annualIncome, 2),
      yieldPct: price > 0 ? round((perShare / price) * 100, 2) : null,
    });
  }

  totalAnnualIncome = round(totalAnnualIncome, 2);
  return {
    totalAnnualIncome,
    totalMonthlyIncome: round(totalAnnualIncome / 12, 2),
    portfolioYieldPct: totalValue > 0 ? round((totalAnnualIncome / totalValue) * 100, 2) : null,
    byTicker,
  };
}
