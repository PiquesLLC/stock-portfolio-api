export interface Holding {
  id: string;
  ticker: string;
  shares: number;
  averageCost: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface HoldingInput {
  ticker: string;
  shares: number;
  averageCost: number;
}

export interface PortfolioSnapshot {
  id: string;
  timestamp: Date;
  totalValue: number;
  cashBalance: number;
  dailyPL: number;
  dailyPLPercent: number;
  totalPL: number;
  totalPLPercent: number;
}

export type BaselineType = 'fresh_start' | 'existing_portfolio';

export interface Settings {
  id: string;
  cashBalance: number;
  marginDebt: number;
  updatedAt: Date;

  // Baseline tracking
  trackingStartDate: Date | null;
  baselineTotalValue: number | null;
  baselineCashBalance: number | null;
  baselineType: string | null; // 'fresh_start' | 'existing_portfolio'

  // Broker lifetime stats (user-provided)
  brokerLifetimeDeposits: number | null;
  brokerLifetimeWithdrawals: number | null;
  brokerLifetimeValue: number | null;
  brokerLifetimeAsOf: Date | null;
}

export interface SettingsUpdateInput {
  cashBalance?: number;
  marginDebt?: number;
}

export interface BaselineInput {
  type: BaselineType;
  // For existing_portfolio, current holdings/cash will be used
  // For fresh_start, baseline is set to 0 (or current if they add holdings first)
}

export interface BrokerLifetimeInput {
  deposits: number;
  withdrawals: number;
  currentValue: number;
}

export interface PerformanceSummary {
  // Since Tracking Start (snapshot-based)
  sinceTracking: {
    hasBaseline: boolean;
    startDate: string | null;
    startingValue: number | null;
    currentValue: number;
    absoluteReturn: number | null;
    percentReturn: number | null;
    snapshotCount: number;
  };

  // Current Holdings P/L (unrealized, from holdings)
  holdingsPL: {
    totalCost: number;
    currentValue: number;
    unrealizedPL: number;
    unrealizedPLPercent: number;
  };

  // Broker Lifetime (optional, user-provided)
  brokerLifetime: {
    hasData: boolean;
    deposits: number | null;
    withdrawals: number | null;
    currentValue: number | null;
    netContributions: number | null;
    absoluteReturn: number | null;
    percentReturn: number | null;
    asOf: string | null;
  } | null;
}

export type MarketSession = 'PRE' | 'REG' | 'POST' | 'CLOSED';

export interface Quote {
  ticker: string;
  currentPrice: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  timestamp: number;
  updatedAt?: number; // timestamp of the quote data
  isStale?: boolean;
  isRepricing?: boolean; // true if quote is being repriced (age > threshold or missing)
  quoteAgeSeconds?: number; // seconds since last update
  staleAge?: number; // seconds since last fresh update (legacy)
  session?: MarketSession; // current market session
}

export interface HoldingWithQuote extends Holding {
  currentPrice: number;
  currentValue: number;
  totalCost: number;
  profitLoss: number;
  profitLossPercent: number;
  dayChange: number;
  dayChangePercent: number;
  priceUnavailable?: boolean;
  priceIsStale?: boolean;
  isRepricing?: boolean;
  quoteAgeSeconds?: number;
  session?: MarketSession;
}

export interface QuotesMeta {
  anyRepricing: boolean;
  quoteTimestamp: number;
  provider: string;
  staleCount?: number;
  failedTickers?: string[];
}

export interface Portfolio {
  holdings: HoldingWithQuote[];
  cashBalance: number;
  marginDebt: number;
  holdingsValue: number;    // sum of all holdings market values
  totalAssets: number;      // holdingsValue + cashBalance (NO marginDebt - for tracking)
  netEquity: number;        // totalAssets - marginDebt (for display only)
  totalValue: number;       // same as totalAssets for snapshot compatibility
  totalCost: number;
  totalPL: number;
  totalPLPercent: number;
  dayChange: number;
  dayChangePercent: number;
  quotesStale?: boolean;
  quotesUnavailableCount?: number;
  quotesMeta?: QuotesMeta;
  session?: MarketSession;  // current market session
  paceProjection?: PaceProjection; // MTD-based pace projections
}

// Dividend types
export interface DividendEvent {
  id: string;
  ticker: string;
  amount: number;
  date: Date;
  createdAt: Date;
}

export interface DividendInput {
  ticker: string;
  amount: number;
  date: string; // ISO date string
}

// New Projection types
export type ProjectionMode = 'sp500' | 'realized';
export type LookbackPeriod = '1d' | '1w' | '1m' | '6m' | '1y' | 'max';
export type HorizonPeriod = '6m' | '1y' | '5y' | '10y';

export interface ProjectionHorizons {
  '6m': { base: number };
  '1y': { base: number };
  '5y': { base: number };
  '10y': { base: number };
}

export interface SP500ProjectionResponse {
  mode: 'sp500';
  asOf: string;
  currentValue: number;
  assumptions: {
    annualReturn: number;
    compounding: 'monthly';
  };
  horizons: ProjectionHorizons;
}

export interface RealizedMetrics {
  cagr: number | null;
  volatility: number | null;
  maxDrawdown: number | null;
  sharpe: number | null;
}

export interface RealizedProjectionResponse {
  mode: 'realized';
  lookback: LookbackPeriod;
  lookbackUsed: LookbackPeriod; // actual lookback used if requested wasn't available
  asOf: string;
  currentValue: number;
  realized: RealizedMetrics;
  horizons: ProjectionHorizons;
  notes: string[];
  snapshotCount: number;
  dataStartDate: string | null;
  dataEndDate: string | null;
}

export type ProjectionResponse = SP500ProjectionResponse | RealizedProjectionResponse;

export interface MetricsResponse {
  lookback: LookbackPeriod;
  lookbackUsed: LookbackPeriod;
  asOf: string;
  currentValue: number;
  metrics: RealizedMetrics;
  notes: string[];
  snapshotCount: number;
  dataStartDate: string | null;
  dataEndDate: string | null;
}

// Pace Projection types (MTD-based simple linear projections)
export interface PaceProjection {
  hasData: boolean;
  mtdReturnPct: number | null;        // Month-to-date return percentage
  paceMonthlyPct: number | null;      // Same as MTD (the month's current performance)
  paceAnnualPct: number | null;       // Monthly * 12
  horizonPct: {
    '1y': number | null;
    '2y': number | null;
    '5y': number | null;
    '10y': number | null;
  };
  horizonValue: {
    '1y': number | null;
    '2y': number | null;
    '5y': number | null;
    '10y': number | null;
  };
  baselineMonthDate: string | null;   // ISO date of baseline snapshot
  baselineMonthAssets: number | null; // Asset value at start of month
  currentAssets: number;              // Current total assets
  daysIntoMonth: number;              // Days elapsed in current month
  note: string | null;                // Any warning or info message
}

// Finnhub types
export interface FinnhubQuote {
  c: number;
  d: number;
  dp: number;
  h: number;
  l: number;
  o: number;
  pc: number;
  t: number;
}

// Insights types
export interface HealthScore {
  overall: number; // 0-100
  breakdown: {
    concentration: number;  // 0-25
    volatility: number;     // 0-25
    drawdown: number;       // 0-25
    diversification: number; // 0-25
    margin: number;         // penalty points
  };
  reasons: string[];       // top 3 reasons
  quickFixes: string[];    // top 2 actionable tips
  partial: boolean;
}

export interface Attribution {
  window: '1d' | '5d' | '1m';
  topContributors: {
    ticker: string;
    contributionDollar: number;
    contributionPct: number;
  }[];
  topDetractors: {
    ticker: string;
    contributionDollar: number;
    contributionPct: number;
  }[];
  partial: boolean;
}

export interface LeakDetectorResult {
  correlationClusters: {
    tickers: string[];
    avgCorrelation: number;
  }[];
  summaries: string[];
  heatmapData: {
    tickers: string[];
    matrix: number[][];
  } | null;
  partial: boolean;
}

export interface RiskForecast {
  expectedAnnualVol: number | null;
  maxDrawdown1y: number | null;
  monteCarloBands: {
    p10: number;  // 10th percentile (pessimistic)
    p50: number;  // 50th percentile (base)
    p90: number;  // 90th percentile (optimistic)
  } | null;
  partial: boolean;
}

// Goal types
export interface Goal {
  id: string;
  name: string;
  targetValue: number;
  monthlyContribution: number;
  deadline: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoalInput {
  name: string;
  targetValue: number;
  monthlyContribution?: number;
  deadline?: string | null;
}

export interface TimeToGoalRange {
  optimistic: number | null;  // months (10th percentile pace)
  base: number | null;        // months (50th percentile pace)
  pessimistic: number | null; // months (90th percentile pace)
}

export interface GoalWithProgress extends Goal {
  currentProgress: number;              // 0-100
  currentPortfolioValue: number;
  timeToGoal: TimeToGoalRange;          // months to reach goal
  projectedDate: {
    optimistic: string | null;
    base: string | null;
    pessimistic: string | null;
  };
}

// Symbol search types
export interface SymbolSearchResult {
  symbol: string;
  description: string;
  type: string;
  primaryExchange: string;
  popularityScore: number;  // Combined ranking score (higher = more relevant)
  marketCapB?: number;      // Market cap in billions USD, if available
  avgVolume?: number;       // Average daily volume, if available
  isPopular?: boolean;      // True if this is a well-known popular ticker
  isHeld?: boolean;         // True if user currently holds this ticker
}

export interface SymbolSearchResponse {
  results: SymbolSearchResult[];
  meta: {
    query: string;
    count: number;
    partial: boolean;
    cached: boolean;
    advPending: string[];   // Tickers whose ADV is being fetched async
  };
}
