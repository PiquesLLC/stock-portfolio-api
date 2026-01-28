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
  isStale?: boolean;
  staleAge?: number; // seconds since last fresh update
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
