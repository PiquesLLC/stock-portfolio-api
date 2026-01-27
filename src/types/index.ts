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

export interface Settings {
  id: string;
  cashBalance: number;
  updatedAt: Date;
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
  isStale?: boolean;  // true if this is cached data after a fetch failure
}

export interface HoldingWithQuote extends Holding {
  currentPrice: number;
  currentValue: number;
  totalCost: number;
  profitLoss: number;
  profitLossPercent: number;
  dayChange: number;
  dayChangePercent: number;
  priceUnavailable?: boolean;  // true if no price data available at all
  priceIsStale?: boolean;      // true if using cached/old price data
}

export interface Portfolio {
  holdings: HoldingWithQuote[];
  cashBalance: number;
  totalValue: number;
  totalCost: number;
  totalPL: number;
  totalPLPercent: number;
  dayChange: number;
  dayChangePercent: number;
  quotesStale?: boolean;           // true if any quotes are stale
  quotesUnavailableCount?: number; // count of holdings with no price data
}

export interface ProjectionMetrics {
  velocity: number;
  acceleration: number;
  volatility: number;
  drawdown: number;
}

export interface Projection {
  horizon: '6mo' | '1yr' | '5yr' | '10yr';
  base: number;
  bull: number;
  bear: number;
  confidence: number;
}

export interface ProjectionResponse {
  currentValue: number;
  projections: Projection[];
  snapshotCount: number;
  method: 'momentum' | 'insufficient_data';
  metrics: ProjectionMetrics | null;
  message?: string;
}

export interface FinnhubQuote {
  c: number;  // Current price
  d: number;  // Change
  dp: number; // Percent change
  h: number;  // High price of the day
  l: number;  // Low price of the day
  o: number;  // Open price of the day
  pc: number; // Previous close price
  t: number;  // Timestamp
}
