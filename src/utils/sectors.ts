/**
 * Shared sector mapping used by insights and intelligence services.
 *
 * Coverage: common US-listed stocks and ETFs. Tickers not listed here
 * are classified as 'Other'. To keep the map useful, add any new
 * holding tickers here when they appear as 'Other' in the UI.
 */

/**
 * Sub-sector grouping for heatmap treemap (Finviz-style).
 * Structure: sector → sub-sector → tickers[]
 * The flat `sectorGroups` is derived from this for backward compatibility.
 */
export const subSectorGroups: Record<string, Record<string, string[]>> = {
  'Tech': {
    'Mega-Cap Tech': ['AAPL', 'MSFT', 'GOOGL', 'META', 'AMZN', 'NVDA'],
    'Semiconductors': [
      'AMD', 'INTC', 'TSM', 'ASML', 'AVGO', 'QCOM', 'TXN', 'MU',
      'MRVL', 'AMAT', 'LRCX', 'KLAC', 'ARM', 'SMCI', 'ON', 'MCHP',
      'ADI', 'NXPI', 'SNPS', 'CDNS',
    ],
    'Software & Cloud': [
      'CRM', 'ORCL', 'ADBE', 'NOW', 'SNOW', 'PLTR', 'SHOP', 'WDAY',
      'TEAM', 'ZM', 'DOCU', 'OKTA', 'HUBS', 'INTU', 'DDOG', 'MDB',
      'NET', 'ZS', 'CRWD', 'PANW', 'FTNT', 'DELL', 'HPQ',
      'CSCO', 'IBM', 'ADSK', 'ADP', 'PAYX', 'CTSH', 'CDW',
    ],
    'Internet & Streaming': [
      'NFLX', 'UBER', 'ABNB', 'DASH', 'COIN', 'XYZ', 'PYPL', 'ANET',
      'RDDT', 'SNAP', 'PINS', 'TTD', 'RBLX', 'SPOT',
    ],
    'China Tech': [
      'BABA', 'BIDU', 'JD', 'PDD', 'NIO', 'XPEV', 'LI', 'BILI',
      'TME', 'TCEHY', 'KWEB',
    ],
  },
  'Finance': {
    'Banks': ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'SCHW', 'TFC', 'USB', 'PNC'],
    'Payments & Fintech': ['V', 'MA', 'AXP', 'COF', 'FIS', 'FISV', 'HOOD', 'SOFI'],
    'Capital Markets': ['BRK.A', 'BRK.B', 'BLK', 'SPGI', 'ICE', 'CME', 'MCO'],
    'Insurance': ['CB', 'MMC', 'AON', 'PGR', 'MET', 'AIG', 'TRV'],
  },
  'Healthcare': {
    'Pharmaceuticals': ['JNJ', 'PFE', 'ABBV', 'MRK', 'LLY', 'BMY', 'AMGN'],
    'Biotech': ['GILD', 'VRTX', 'REGN', 'MRNA', 'BIIB'],
    'Med Devices & Diagnostics': [
      'TMO', 'ABT', 'DHR', 'ISRG', 'MDT', 'SYK', 'ZTS',
      'DXCM', 'ILMN', 'IDXX', 'BSX', 'EW', 'A',
    ],
    'Health Insurance': ['UNH', 'CVS', 'CI', 'ELV', 'HUM', 'HCA'],
  },
  'Energy': {
    'Oil & Gas': ['XOM', 'CVX', 'COP', 'EOG', 'OXY', 'DVN', 'FANG'],
    'Services & Refining': ['SLB', 'MPC', 'PSX', 'VLO', 'BKR', 'HAL'],
    'Midstream & Power': ['KMI', 'WMB', 'OKE', 'ET', 'CEG'],
  },
  'Consumer': {
    'Consumer Staples': [
      'WMT', 'PG', 'KO', 'PEP', 'COST', 'CL', 'MDLZ', 'MO', 'PM',
      'EL', 'KHC', 'GIS', 'SYY', 'HSY', 'KLG', 'STZ', 'KDP', 'MNST',
    ],
    'Retail': ['HD', 'LOW', 'TGT', 'ROST', 'TJX', 'NKE', 'LULU', 'ETSY', 'EBAY', 'W', 'DECK', 'ORLY', 'DLTR', 'CPRT'],
    'Restaurants & Hospitality': ['MCD', 'SBUX', 'BKNG', 'MAR', 'CMG', 'DPZ', 'YUM'],
    'Auto & EV': ['TSLA', 'GM', 'F', 'RIVN', 'LCID'],
  },
  'Industrial': {
    'Aerospace & Defense': ['BA', 'LMT', 'GE', 'RTX', 'GD', 'NOC', 'LHX'],
    'Machinery & Equipment': ['CAT', 'DE', 'HON', 'MMM', 'EMR', 'ITW', 'ETN', 'PCAR', 'CTAS', 'FAST'],
    'Transport & Logistics': ['UPS', 'UNP', 'CSX', 'NSC', 'FDX', 'WM', 'ODFL'],
  },
  'Communication': {
    'Media & Entertainment': ['DIS', 'CMCSA', 'WBD', 'ROKU'],
    'Telecom': ['T', 'VZ', 'TMUS'],
    'Gaming & Social': ['EA', 'TTWO', 'MTCH'],
  },
  'Materials': {
    'Chemicals': ['LIN', 'APD', 'SHW', 'ECL', 'DOW', 'DD', 'CF'],
    'Mining & Construction': ['NEM', 'FCX', 'NUE', 'VMC', 'MLM'],
  },
  'Utilities': {
    'Electric Utilities': ['NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE', 'XEL', 'ED', 'WEC', 'ES'],
    'Water Utilities': ['AWK'],
  },
  'Real Estate': {
    'REITs': [
      'AMT', 'PLD', 'CCI', 'EQIX', 'SPG', 'O', 'PSA', 'DLR',
      'WELL', 'AVB', 'EQR', 'VTR',
    ],
  },
};

// Derive flat sectorGroups from subSectorGroups for backward compatibility
export const sectorGroups: Record<string, string[]> = (() => {
  const flat: Record<string, string[]> = {};
  for (const [sector, subs] of Object.entries(subSectorGroups)) {
    flat[sector] = Object.values(subs).flat();
  }
  // Add ETF/Index separately (no sub-sectors needed for heatmap)
  flat['ETF/Index'] = [
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
  ];
  return flat;
})();

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

// ── Index Membership ──────────────────────────────────────────────
// These sets define which tickers belong to each major index.
// Used by the heatmap to filter stocks when an index is selected.

export type MarketIndex = 'SP500' | 'DOW30' | 'NASDAQ100';

/** DOW Jones Industrial Average — 30 components (post-Nov 2024) */
export const DOW_30 = new Set([
  'AAPL', 'AMGN', 'AMZN', 'AXP', 'BA', 'CAT', 'CRM', 'CSCO', 'CVX', 'DIS',
  'GS', 'HD', 'HON', 'IBM', 'JNJ', 'JPM', 'KO', 'MCD', 'MMM', 'MRK',
  'MSFT', 'NKE', 'NVDA', 'PG', 'SHW', 'TRV', 'UNH', 'V', 'VZ', 'WMT',
]);

/** NASDAQ-100 — top 100 non-financial NASDAQ-listed companies */
export const NASDAQ_100 = new Set([
  // Mega-cap
  'AAPL', 'MSFT', 'AMZN', 'NVDA', 'GOOGL', 'META', 'TSLA', 'AVGO', 'COST', 'NFLX',
  // Semiconductors
  'AMD', 'INTC', 'QCOM', 'TXN', 'MU', 'MRVL', 'AMAT', 'LRCX', 'KLAC', 'ARM',
  'ON', 'MCHP', 'ADI', 'NXPI', 'SNPS', 'CDNS', 'ASML',
  // Software & Cloud
  'CRM', 'ADBE', 'INTU', 'PANW', 'CRWD', 'FTNT', 'WDAY', 'TEAM', 'DDOG',
  'ZS', 'CSCO', 'ADSK', 'ADP', 'PAYX', 'CTSH', 'CDW',
  // Internet & Streaming
  'ABNB', 'DASH', 'PYPL', 'TTD', 'SPOT',
  // Healthcare
  'AMGN', 'GILD', 'VRTX', 'REGN', 'MRNA', 'BIIB', 'ISRG', 'DXCM', 'IDXX', 'ILMN',
  // Consumer
  'PEP', 'COST', 'MDLZ', 'MNST', 'KDP', 'KHC',
  'LULU', 'ROST', 'ORLY', 'DLTR', 'CPRT',
  'SBUX', 'BKNG', 'MAR', 'CMCSA',
  // Industrial
  'HON', 'CSX', 'ODFL', 'PCAR', 'CTAS', 'FAST',
  // Energy
  'CEG', 'FANG', 'BKR',
  // Communication
  'EA', 'TTWO', 'TMUS', 'CMCSA',
  // Utilities
  'AEP', 'EXC', 'XEL',
  // Materials
  'LIN',
]);

/** S&P 500 — use all stocks in subSectorGroups (curated major constituents) */
export const SP_500 = new Set(
  Object.values(subSectorGroups).flatMap(subs => Object.values(subs).flat()),
);

export const INDEX_SETS: Record<MarketIndex, Set<string>> = {
  SP500: SP_500,
  DOW30: DOW_30,
  NASDAQ100: NASDAQ_100,
};
