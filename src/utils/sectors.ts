/**
 * Shared sector mapping used by insights and intelligence services.
 *
 * Coverage: common US-listed stocks and ETFs. Tickers not listed here
 * are classified as 'Other'. To keep the map useful, add any new
 * holding tickers here when they appear as 'Other' in the UI.
 */

export const sectorGroups: Record<string, string[]> = {
  'Tech': [
    // Mega-cap
    'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'META', 'AMZN', 'NVDA',
    // Semiconductors
    'AMD', 'INTC', 'TSM', 'ASML', 'AVGO', 'QCOM', 'TXN', 'MU',
    'MRVL', 'AMAT', 'LRCX', 'KLAC', 'ARM', 'SMCI', 'ON', 'MCHP',
    'ADI', 'NXPI', 'SNPS', 'CDNS',
    // Software / Cloud
    'CRM', 'ORCL', 'ADBE', 'NOW', 'SNOW', 'PLTR', 'SHOP', 'WDAY',
    'TEAM', 'ZM', 'DOCU', 'OKTA', 'HUBS', 'INTU', 'DDOG', 'MDB',
    'NET', 'ZS', 'CRWD', 'PANW', 'FTNT', 'DELL', 'HPQ',
    // Internet / Social / Streaming
    'NFLX', 'UBER', 'ABNB', 'DASH', 'COIN', 'SQ', 'PYPL', 'ANET',
    'RDDT', 'SNAP', 'PINS', 'TTD', 'RBLX', 'SPOT',
    // China tech
    'BABA', 'BIDU', 'JD', 'PDD', 'NIO', 'XPEV', 'LI', 'BILI',
    'TME', 'TCEHY', 'KWEB',
  ],
  'Finance': [
    'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'V', 'MA', 'AXP',
    'BRK.A', 'BRK.B', 'SCHW', 'BLK', 'SPGI', 'ICE', 'CME',
    'MCO', 'CB', 'MMC', 'AON', 'PGR', 'MET', 'AIG', 'TFC',
    'USB', 'PNC', 'COF', 'DFS', 'FIS', 'FISV', 'HOOD', 'SOFI',
  ],
  'Healthcare': [
    'JNJ', 'UNH', 'PFE', 'ABBV', 'MRK', 'LLY', 'TMO', 'ABT',
    'DHR', 'BMY', 'AMGN', 'CVS', 'GILD', 'ISRG', 'VRTX',
    'REGN', 'MRNA', 'BIIB', 'MDT', 'SYK', 'ZTS', 'CI', 'ELV',
    'HUM', 'HCA', 'DXCM', 'ILMN', 'IDXX', 'BSX', 'EW', 'A',
  ],
  'Energy': [
    'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO',
    'OXY', 'KMI', 'DVN', 'FANG', 'HES', 'BKR', 'WMB', 'OKE',
    'ET', 'HAL', 'PXD', 'CEG',
  ],
  'Consumer': [
    // Staples
    'WMT', 'PG', 'KO', 'PEP', 'COST', 'CL', 'MDLZ', 'MO', 'PM',
    'EL', 'KHC', 'GIS', 'SYY', 'HSY', 'K', 'STZ', 'KDP', 'MNST',
    // Discretionary
    'HD', 'NKE', 'MCD', 'SBUX', 'TGT', 'LOW', 'TSLA', 'BKNG',
    'MAR', 'CMG', 'LULU', 'ROST', 'TJX', 'GM', 'F', 'RIVN',
    'LCID', 'DPZ', 'YUM', 'ETSY', 'EBAY', 'W', 'DECK',
  ],
  'Industrial': [
    'CAT', 'DE', 'BA', 'HON', 'UPS', 'LMT', 'GE', 'RTX', 'MMM',
    'UNP', 'CSX', 'NSC', 'FDX', 'WM', 'EMR', 'ITW', 'GD', 'NOC',
    'LHX', 'ETN',
  ],
  'Communication': [
    'DIS', 'CMCSA', 'T', 'VZ', 'TMUS', 'ROKU', 'WBD', 'PARA',
    'EA', 'TTWO', 'ATVI', 'MTCH',
  ],
  'Materials': [
    'LIN', 'APD', 'SHW', 'ECL', 'NEM', 'FCX', 'DOW', 'NUE',
    'CF', 'DD', 'VMC', 'MLM',
  ],
  'Utilities': [
    'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE', 'XEL',
    'ED', 'WEC', 'ES', 'AWK',
  ],
  'Real Estate': [
    'AMT', 'PLD', 'CCI', 'EQIX', 'SPG', 'O', 'PSA', 'DLR',
    'WELL', 'AVB', 'EQR', 'VTR',
  ],
  'ETF/Index': [
    // Broad market
    'SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'VOO', 'SCHD',
    // International
    'VEA', 'VWO', 'EEM', 'EFA', 'INDA', 'FXI', 'IEMG',
    // Sector ETFs
    'XLF', 'XLK', 'XLE', 'XLV', 'XLI', 'XLP', 'XLY', 'XLU',
    'XLC', 'XLRE', 'XLB',
    // Thematic / Specialty
    'ARKK', 'ARKG', 'ARKW', 'ARKF',
    'VGT', 'SOXX', 'SMH', 'XBI', 'IBB', 'NLR',
    'GLD', 'SLV', 'GDX', 'USO', 'TAN', 'ICLN', 'LIT', 'BOTZ',
    // Fixed income
    'BND', 'AGG', 'TLT', 'HYG', 'LQD', 'VCSH', 'VCIT',
    // Leveraged (display only)
    'TQQQ', 'SQQQ', 'SPXL', 'UPRO', 'SOXL', 'SOXS',
    // Real estate ETF
    'VNQ', 'XLRE',
  ],
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
