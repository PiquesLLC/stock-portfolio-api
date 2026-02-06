/**
 * Strategy Persona definitions for "Ask Nala AI".
 *
 * Each persona defines an investing philosophy with specific screening
 * metrics, keywords for NLP matching, and risk classification.
 */

export type StrategyId =
  | 'buffett_value'
  | 'growth'
  | 'conservative_dividend'
  | 'momentum'
  | 'quality_compounder'
  | 'small_cap_value'
  | 'contrarian'
  | 'income_reits';

export interface MetricFilter {
  metric: string;
  operator: 'lt' | 'gt' | 'between' | 'gte' | 'lte';
  value: number | [number, number];
  weight: number;
  label: string;
}

export interface StrategyPersona {
  id: StrategyId;
  name: string;
  shortDescription: string;
  philosophy: string;
  icon: string;
  keywords: string[];
  metrics: MetricFilter[];
  sectorPreferences?: string[];
  excludeETFs: boolean;
  stockCount: number;
  riskLevel: 'conservative' | 'moderate' | 'aggressive';
}

export const STRATEGY_PERSONAS: StrategyPersona[] = [
  {
    id: 'buffett_value',
    name: 'Buffett Value Investor',
    shortDescription: 'Wide moats, undervalued, consistent earnings',
    philosophy:
      'Focus on companies with durable competitive advantages trading below intrinsic value. ' +
      'Prioritize strong returns on equity, low debt, and consistent free cash flow generation. ' +
      'Patience and margin of safety are key.',
    icon: '🏛️',
    keywords: ['buffett', 'warren', 'value', 'moat', 'intrinsic', 'margin of safety', 'berkshire', 'undervalued', 'cheap'],
    metrics: [
      { metric: 'P/E', operator: 'lt', value: 20, weight: 0.8, label: 'P/E ratio below 20' },
      { metric: 'ROE', operator: 'gt', value: 15, weight: 0.9, label: 'Return on equity above 15%' },
      { metric: 'Debt-to-Equity', operator: 'lt', value: 0.5, weight: 0.7, label: 'Debt-to-equity below 0.5' },
      { metric: 'Profit Margin', operator: 'gt', value: 15, weight: 0.7, label: 'Profit margin above 15%' },
      { metric: 'FCF Yield', operator: 'gt', value: 4, weight: 0.6, label: 'Free cash flow yield above 4%' },
      { metric: 'Market Cap', operator: 'gt', value: 10, weight: 0.4, label: 'Market cap above $10B' },
    ],
    excludeETFs: true,
    stockCount: 6,
    riskLevel: 'conservative',
  },
  {
    id: 'growth',
    name: 'Growth Investor',
    shortDescription: 'Fast-growing companies with strong momentum',
    philosophy:
      'Target companies with accelerating revenue and earnings growth, even if valuations appear stretched. ' +
      'The best growth stocks compound returns through expanding markets and reinvestment. ' +
      'Focus on total addressable market and competitive positioning.',
    icon: '📈',
    keywords: ['growth', 'fast growing', 'high growth', 'disruptive', 'innovation', 'tech', 'hypergrowth', 'scaling'],
    metrics: [
      { metric: 'Revenue Growth YoY', operator: 'gt', value: 20, weight: 0.9, label: 'Revenue growth above 20% YoY' },
      { metric: 'EPS Growth', operator: 'gt', value: 15, weight: 0.8, label: 'EPS growth above 15%' },
      { metric: 'ROE', operator: 'gt', value: 12, weight: 0.5, label: 'Return on equity above 12%' },
      { metric: 'Market Cap', operator: 'gt', value: 1, weight: 0.3, label: 'Market cap above $1B' },
    ],
    excludeETFs: true,
    stockCount: 6,
    riskLevel: 'aggressive',
  },
  {
    id: 'conservative_dividend',
    name: 'Conservative Dividend',
    shortDescription: 'Stable income with low volatility',
    philosophy:
      'Prioritize reliable dividend-paying companies with sustainable payout ratios and low volatility. ' +
      'Ideal for income-focused portfolios and capital preservation. ' +
      'Look for companies with long track records of dividend growth.',
    icon: '💰',
    keywords: ['dividend', 'income', 'retirement', 'conservative', 'yield', 'passive income', 'safe', 'stable', 'defensive'],
    metrics: [
      { metric: 'Dividend Yield', operator: 'gt', value: 2.5, weight: 0.9, label: 'Dividend yield above 2.5%' },
      { metric: 'Payout Ratio', operator: 'between', value: [30, 70], weight: 0.8, label: 'Payout ratio between 30-70%' },
      { metric: 'Beta', operator: 'lt', value: 1.0, weight: 0.7, label: 'Beta below 1.0 (lower volatility)' },
      { metric: 'Debt-to-Equity', operator: 'lt', value: 1.0, weight: 0.6, label: 'Debt-to-equity below 1.0' },
      { metric: 'P/E', operator: 'lt', value: 25, weight: 0.5, label: 'P/E ratio below 25' },
    ],
    excludeETFs: true,
    stockCount: 6,
    riskLevel: 'conservative',
  },
  {
    id: 'momentum',
    name: 'Momentum Trader',
    shortDescription: 'Riding strong price trends and earnings beats',
    philosophy:
      'Follow price momentum and positive earnings surprises. ' +
      'Stocks trading above key moving averages with accelerating volume often continue trending. ' +
      'Combine technical strength with fundamental catalysts.',
    icon: '🚀',
    keywords: ['momentum', 'trending', 'hot', 'breakout', 'moving average', 'relative strength', 'outperforming', 'rally'],
    metrics: [
      { metric: '6-Month Return', operator: 'gt', value: 15, weight: 0.9, label: '6-month return above 15%' },
      { metric: 'Price vs 200d MA', operator: 'gt', value: 0, weight: 0.8, label: 'Price above 200-day moving average' },
      { metric: 'Earnings Surprise', operator: 'gt', value: 0, weight: 0.7, label: 'Positive earnings surprises last 2 quarters' },
      { metric: 'Revenue Growth YoY', operator: 'gt', value: 5, weight: 0.5, label: 'Revenue growth above 5% YoY' },
    ],
    excludeETFs: true,
    stockCount: 6,
    riskLevel: 'aggressive',
  },
  {
    id: 'quality_compounder',
    name: 'Quality Compounder',
    shortDescription: 'High-ROIC businesses that compound wealth',
    philosophy:
      'Invest in businesses that generate high returns on invested capital with sustainable competitive advantages. ' +
      'These companies reinvest profits at high rates, creating a compounding effect over time. ' +
      'Growth at a reasonable price (GARP) is the guiding principle.',
    icon: '🏰',
    keywords: ['quality', 'compounder', 'compound', 'long term', 'buy and hold', 'garp', 'roic', 'competitive advantage'],
    metrics: [
      { metric: 'ROIC', operator: 'gt', value: 15, weight: 0.9, label: 'Return on invested capital above 15%' },
      { metric: 'Revenue CAGR 3yr', operator: 'gt', value: 10, weight: 0.8, label: '3-year revenue CAGR above 10%' },
      { metric: 'Net Margin', operator: 'gt', value: 10, weight: 0.7, label: 'Net profit margin above 10%' },
      { metric: 'Debt-to-Equity', operator: 'lt', value: 1.0, weight: 0.6, label: 'Debt-to-equity below 1.0' },
      { metric: 'PEG Ratio', operator: 'lt', value: 2.0, weight: 0.7, label: 'PEG ratio below 2.0' },
      { metric: 'Market Cap', operator: 'gt', value: 5, weight: 0.3, label: 'Market cap above $5B' },
    ],
    excludeETFs: true,
    stockCount: 6,
    riskLevel: 'moderate',
  },
  {
    id: 'small_cap_value',
    name: 'Small Cap Value',
    shortDescription: 'Undervalued smaller companies with upside',
    philosophy:
      'Find overlooked small-cap companies trading below intrinsic value with solid fundamentals. ' +
      'Smaller companies are less covered by analysts, creating pricing inefficiencies. ' +
      'Focus on positive cash flow and reasonable valuations.',
    icon: '💎',
    keywords: ['small cap', 'small-cap', 'micro cap', 'undervalued', 'hidden gem', 'undiscovered', 'under the radar'],
    metrics: [
      { metric: 'Market Cap', operator: 'between', value: [0.3, 5], weight: 0.9, label: 'Market cap $300M - $5B' },
      { metric: 'P/E', operator: 'lt', value: 15, weight: 0.8, label: 'P/E ratio below 15' },
      { metric: 'P/B', operator: 'lt', value: 2.0, weight: 0.7, label: 'Price-to-book below 2.0' },
      { metric: 'FCF', operator: 'gt', value: 0, weight: 0.8, label: 'Positive free cash flow' },
      { metric: 'ROE', operator: 'gt', value: 10, weight: 0.6, label: 'Return on equity above 10%' },
    ],
    excludeETFs: true,
    stockCount: 6,
    riskLevel: 'aggressive',
  },
  {
    id: 'contrarian',
    name: 'Contrarian Play',
    shortDescription: 'Beaten-down stocks with recovery potential',
    philosophy:
      'Look for quality companies that have been oversold due to short-term sentiment or sector rotation. ' +
      'Contrarian investing requires conviction — buy when others are fearful. ' +
      'Focus on companies where fundamentals remain intact despite price declines.',
    icon: '🔄',
    keywords: ['contrarian', 'beaten down', 'turnaround', 'oversold', 'recovery', 'unloved', 'bounce back', 'dip'],
    metrics: [
      { metric: 'YTD Return', operator: 'lt', value: -20, weight: 0.9, label: 'YTD decline greater than 20%' },
      { metric: 'P/E vs Sector', operator: 'lt', value: 0, weight: 0.7, label: 'P/E below sector average' },
      { metric: 'FCF', operator: 'gt', value: 0, weight: 0.8, label: 'Positive free cash flow' },
      { metric: 'Revenue Growth YoY', operator: 'gt', value: 0, weight: 0.5, label: 'Still positive revenue' },
    ],
    excludeETFs: true,
    stockCount: 6,
    riskLevel: 'aggressive',
  },
  {
    id: 'income_reits',
    name: 'Income REITs',
    shortDescription: 'Real estate investment trusts for passive income',
    philosophy:
      'Focus on REITs with sustainable dividends, strong occupancy rates, and growing funds from operations. ' +
      'REITs offer real estate exposure with the liquidity of stocks. ' +
      'Prioritize diversified portfolios with quality tenants and long lease terms.',
    icon: '🏢',
    keywords: ['reit', 'real estate', 'rental income', 'property', 'reits', 'real estate investment'],
    sectorPreferences: ['Real Estate'],
    metrics: [
      { metric: 'Dividend Yield', operator: 'gt', value: 3, weight: 0.9, label: 'Dividend yield above 3%' },
      { metric: 'FFO Payout Ratio', operator: 'lt', value: 85, weight: 0.8, label: 'FFO payout ratio below 85%' },
      { metric: 'Market Cap', operator: 'gt', value: 2, weight: 0.5, label: 'Market cap above $2B' },
    ],
    excludeETFs: true,
    stockCount: 6,
    riskLevel: 'moderate',
  },
];

/**
 * Match a user's question to the best-fitting strategy persona.
 * Returns null if no persona matches with at least 2 keyword hits.
 */
export function matchPersona(query: string): StrategyPersona | null {
  const lower = query.toLowerCase();

  let bestPersona: StrategyPersona | null = null;
  let bestScore = 0;

  for (const persona of STRATEGY_PERSONAS) {
    let score = 0;
    for (const keyword of persona.keywords) {
      if (lower.includes(keyword)) {
        score += keyword.includes(' ') ? 2 : 1; // Multi-word keywords worth more
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestPersona = persona;
    }
  }

  return bestScore >= 2 ? bestPersona : null;
}
