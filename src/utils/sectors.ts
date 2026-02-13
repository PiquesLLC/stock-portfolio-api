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
    ],
    'Internet & Streaming': [
      'NFLX', 'UBER', 'ABNB', 'DASH', 'COIN', 'SQ', 'PYPL', 'ANET',
      'RDDT', 'SNAP', 'PINS', 'TTD', 'RBLX', 'SPOT',
    ],
    'China Tech': [
      'BABA', 'BIDU', 'JD', 'PDD', 'NIO', 'XPEV', 'LI', 'BILI',
      'TME', 'TCEHY', 'KWEB',
    ],
  },
  'Finance': {
    'Banks': ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'SCHW', 'TFC', 'USB', 'PNC'],
    'Payments & Fintech': ['V', 'MA', 'AXP', 'COF', 'DFS', 'FIS', 'FISV', 'HOOD', 'SOFI'],
    'Capital Markets': ['BRK.A', 'BRK.B', 'BLK', 'SPGI', 'ICE', 'CME', 'MCO'],
    'Insurance': ['CB', 'MMC', 'AON', 'PGR', 'MET', 'AIG'],
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
    'Oil & Gas': ['XOM', 'CVX', 'COP', 'EOG', 'OXY', 'DVN', 'FANG', 'HES', 'PXD'],
    'Services & Refining': ['SLB', 'MPC', 'PSX', 'VLO', 'BKR', 'HAL'],
    'Midstream & Power': ['KMI', 'WMB', 'OKE', 'ET', 'CEG'],
  },
  'Consumer': {
    'Consumer Staples': [
      'WMT', 'PG', 'KO', 'PEP', 'COST', 'CL', 'MDLZ', 'MO', 'PM',
      'EL', 'KHC', 'GIS', 'SYY', 'HSY', 'K', 'STZ', 'KDP', 'MNST',
    ],
    'Retail': ['HD', 'LOW', 'TGT', 'ROST', 'TJX', 'NKE', 'LULU', 'ETSY', 'EBAY', 'W', 'DECK'],
    'Restaurants & Hospitality': ['MCD', 'SBUX', 'BKNG', 'MAR', 'CMG', 'DPZ', 'YUM'],
    'Auto & EV': ['TSLA', 'GM', 'F', 'RIVN', 'LCID'],
  },
  'Industrial': {
    'Aerospace & Defense': ['BA', 'LMT', 'GE', 'RTX', 'GD', 'NOC', 'LHX'],
    'Machinery & Equipment': ['CAT', 'DE', 'HON', 'MMM', 'EMR', 'ITW', 'ETN'],
    'Transport & Logistics': ['UPS', 'UNP', 'CSX', 'NSC', 'FDX', 'WM'],
  },
  'Communication': {
    'Media & Entertainment': ['DIS', 'CMCSA', 'WBD', 'PARA', 'ROKU'],
    'Telecom': ['T', 'VZ', 'TMUS'],
    'Gaming & Social': ['EA', 'TTWO', 'ATVI', 'MTCH'],
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
