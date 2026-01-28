/**
 * Shared sector mapping used by insights and intelligence services.
 */

export const sectorGroups: Record<string, string[]> = {
  'Tech': ['AAPL', 'MSFT', 'GOOGL', 'GOOG', 'META', 'AMZN', 'NVDA', 'AMD', 'INTC', 'TSLA', 'CRM', 'ORCL', 'ADBE', 'NFLX'],
  'Finance': ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'V', 'MA', 'AXP', 'BRK.A', 'BRK.B', 'SCHW', 'BLK'],
  'Healthcare': ['JNJ', 'UNH', 'PFE', 'ABBV', 'MRK', 'LLY', 'TMO', 'ABT', 'DHR', 'BMY', 'AMGN', 'CVS'],
  'Energy': ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO', 'OXY', 'KMI'],
  'Consumer': ['WMT', 'PG', 'KO', 'PEP', 'COST', 'HD', 'NKE', 'MCD', 'SBUX', 'TGT', 'LOW'],
  'Industrial': ['CAT', 'DE', 'BA', 'HON', 'UPS', 'LMT', 'GE', 'RTX', 'MMM', 'UNP'],
  'ETF/Index': ['SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'VOO', 'VEA', 'VWO', 'BND', 'AGG', 'VNQ', 'XLF', 'XLK', 'XLE'],
};

/**
 * Get the sector for a given ticker. Returns 'Other' if not found.
 */
export function getSector(ticker: string): string {
  const upper = ticker.toUpperCase();
  for (const [sector, tickers] of Object.entries(sectorGroups)) {
    if (tickers.includes(upper)) {
      return sector;
    }
  }
  return 'Other';
}
