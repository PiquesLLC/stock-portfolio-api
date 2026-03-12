import { Request, Response } from 'express';
import NodeCache from 'node-cache';
import { fetchHourlyCandles, fetchIntradayCandles, fetchQuote, IntradayCandle } from '../services/market.service';

type SectorPeriod = '1D' | '1W' | '1M' | '3M' | '6M' | 'YTD' | '1Y';

interface SectorDefinition {
  ticker: string;
  name: string;
}

interface SectorPerformanceItem {
  ticker: string;
  name: string;
  changePercent: number;
  sparkline: number[];
  timestamps: string[];
  lastPrice: number;
  previousClose: number;
}

interface BenchmarkPerformance {
  ticker: 'SPY';
  changePercent: number;
  sparkline: number[];
  timestamps: string[];
}

interface SectorPerformanceResponse {
  sectors: SectorPerformanceItem[];
  benchmark: BenchmarkPerformance;
  asOf: string;
  period: SectorPeriod;
  error?: string;
}

const sectorPerformanceCache = new NodeCache({ stdTTL: 60 });

const SECTORS: SectorDefinition[] = [
  { ticker: 'XLK', name: 'Technology' },
  { ticker: 'XLF', name: 'Financials' },
  { ticker: 'XLE', name: 'Energy' },
  { ticker: 'XLV', name: 'Health Care' },
  { ticker: 'XLI', name: 'Industrials' },
  { ticker: 'XLC', name: 'Communication Services' },
  { ticker: 'XLY', name: 'Consumer Discretionary' },
  { ticker: 'XLP', name: 'Consumer Staples' },
  { ticker: 'XLB', name: 'Materials' },
  { ticker: 'XLRE', name: 'Real Estate' },
  { ticker: 'XLU', name: 'Utilities' },
  { ticker: 'GLD', name: 'Gold' },
];

const BENCHMARK_TICKER = 'SPY' as const;

function toSectorPeriod(raw: unknown): SectorPeriod {
  const upper = typeof raw === 'string' ? raw.toUpperCase() : '1D';
  const valid: SectorPeriod[] = ['1W', '1M', '3M', '6M', 'YTD', '1Y'];
  return valid.includes(upper as SectorPeriod) ? (upper as SectorPeriod) : '1D';
}

function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function cleanCandles(candles: IntradayCandle[]): IntradayCandle[] {
  return candles.filter(
    (c) =>
      !!c.time &&
      isValidNumber(c.open) &&
      isValidNumber(c.close) &&
      c.open > 0 &&
      c.close > 0
  );
}

/** Filter to weekday trading hours only (4 AM – 8 PM ET) */
function filterTradingHours(candles: IntradayCandle[]): IntradayCandle[] {
  return candles.filter((c) => {
    const d = new Date(c.time);
    const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay();
    if (day === 0 || day === 6) return false; // weekend
    const hour = et.getHours();
    return hour >= 4 && hour < 20;
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildSeries(candles: IntradayCandle[], basePrice: number): { sparkline: number[]; timestamps: string[] } {
  const sparkline: number[] = [];
  const timestamps: string[] = [];

  for (const candle of candles) {
    if (!isValidNumber(candle.close)) continue;
    const pct = ((candle.close - basePrice) / basePrice) * 100;
    if (!Number.isFinite(pct)) continue;
    sparkline.push(round2(pct));
    timestamps.push(candle.time);
  }

  return { sparkline, timestamps };
}

function getLastTimestampIso(...series: Array<{ timestamps: string[] }>): string {
  let last = 0;
  for (const entry of series) {
    const ts = entry.timestamps[entry.timestamps.length - 1];
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms > last) last = ms;
  }
  return new Date(last || Date.now()).toISOString();
}

async function fetchCandlesForPeriod(ticker: string, period: SectorPeriod): Promise<IntradayCandle[]> {
  if (period === '1D') return fetchIntradayCandles(ticker);
  return fetchHourlyCandles(ticker, period);
}

async function buildSectorItem(def: SectorDefinition, period: SectorPeriod): Promise<SectorPerformanceItem> {
  const [candles, quote] = await Promise.all([fetchCandlesForPeriod(def.ticker, period), fetchQuote(def.ticker)]);
  const filteredCandles = period !== '1D' ? filterTradingHours(cleanCandles(candles)) : cleanCandles(candles);
  if (filteredCandles.length === 0) {
    throw new Error(`No candles available for ${def.ticker}`);
  }

  const basePrice = period === '1D' ? quote.previousClose : filteredCandles[0].open;
  if (!isValidNumber(basePrice) || basePrice <= 0) {
    throw new Error(`Invalid base price for ${def.ticker}`);
  }

  const { sparkline, timestamps } = buildSeries(filteredCandles, basePrice);
  if (sparkline.length === 0 || sparkline.length !== timestamps.length) {
    throw new Error(`Invalid sparkline data for ${def.ticker}`);
  }

  const lastPrice = isValidNumber(quote.currentPrice) && quote.currentPrice > 0
    ? quote.currentPrice
    : filteredCandles[filteredCandles.length - 1].close;
  const previousClose = isValidNumber(quote.previousClose) && quote.previousClose > 0
    ? quote.previousClose
    : basePrice;
  const changePercent = round2(((lastPrice - basePrice) / basePrice) * 100);

  return {
    ticker: def.ticker,
    name: def.name,
    changePercent,
    sparkline,
    timestamps,
    lastPrice: round2(lastPrice),
    previousClose: round2(previousClose),
  };
}

async function buildBenchmark(period: SectorPeriod): Promise<BenchmarkPerformance> {
  const [candles, quote] = await Promise.all([fetchCandlesForPeriod(BENCHMARK_TICKER, period), fetchQuote(BENCHMARK_TICKER)]);
  const filteredCandles = period !== '1D' ? filterTradingHours(cleanCandles(candles)) : cleanCandles(candles);
  if (filteredCandles.length === 0) {
    throw new Error('No benchmark candles available');
  }

  const basePrice = period === '1D' ? quote.previousClose : filteredCandles[0].open;
  if (!isValidNumber(basePrice) || basePrice <= 0) {
    throw new Error('Invalid benchmark base price');
  }

  const { sparkline, timestamps } = buildSeries(filteredCandles, basePrice);
  if (sparkline.length === 0 || sparkline.length !== timestamps.length) {
    throw new Error('Invalid benchmark sparkline data');
  }

  const lastPrice = isValidNumber(quote.currentPrice) && quote.currentPrice > 0
    ? quote.currentPrice
    : filteredCandles[filteredCandles.length - 1].close;
  const changePercent = round2(((lastPrice - basePrice) / basePrice) * 100);

  return {
    ticker: BENCHMARK_TICKER,
    changePercent,
    sparkline,
    timestamps,
  };
}

function emptyBenchmark(): BenchmarkPerformance {
  return { ticker: BENCHMARK_TICKER, changePercent: 0, sparkline: [], timestamps: [] };
}

export async function getSectorPerformanceHandler(req: Request, res: Response): Promise<void> {
  const period = toSectorPeriod(req.query.period);
  const cacheKey = `sector-performance:${period}`;
  const cached = sectorPerformanceCache.get<SectorPerformanceResponse>(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  try {
    const sectorJobs = SECTORS.map((def) => buildSectorItem(def, period));
    const benchmarkJob = buildBenchmark(period);
    const [sectorSettled, benchmarkSettled] = await Promise.all([
      Promise.allSettled(sectorJobs),
      Promise.allSettled([benchmarkJob]),
    ]);

    const sectors: SectorPerformanceItem[] = [];
    for (let i = 0; i < SECTORS.length; i++) {
      const result = sectorSettled[i];
      if (result.status === 'fulfilled') {
        sectors.push(result.value);
      } else {
        console.warn(`[Sector Performance] ${SECTORS[i].ticker} failed: ${result.reason instanceof Error ? result.reason.message : 'unknown error'}`);
      }
    }

    const benchmarkResult = benchmarkSettled[0];
    const benchmark = benchmarkResult.status === 'fulfilled' ? benchmarkResult.value : emptyBenchmark();
    if (benchmarkResult.status === 'rejected') {
      console.warn(`[Sector Performance] ${BENCHMARK_TICKER} failed: ${benchmarkResult.reason instanceof Error ? benchmarkResult.reason.message : 'unknown error'}`);
    }

    sectors.sort((a, b) => b.changePercent - a.changePercent);

    const response: SectorPerformanceResponse = {
      sectors,
      benchmark,
      asOf: getLastTimestampIso(...sectors, benchmark),
      period,
    };

    if (sectors.length === 0 && benchmark.sparkline.length === 0) {
      response.error = 'Failed to fetch sector performance data';
      res.status(503).json(response);
      return;
    }

    sectorPerformanceCache.set(cacheKey, response);
    res.json(response);
  } catch (error: unknown) {
    console.error('Error fetching sector performance data:');
    res.status(503).json({
      sectors: [],
      benchmark: emptyBenchmark(),
      asOf: new Date().toISOString(),
      period,
      error: 'Failed to fetch sector performance data',
    } satisfies SectorPerformanceResponse);
  }
}
