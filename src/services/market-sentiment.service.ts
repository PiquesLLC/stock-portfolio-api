import NodeCache from 'node-cache';
import { fetchFastQuote, fetchDailyCandles } from './market.service';
import { getHeatmapData } from './market-heatmap.service';
import { yahooGet } from '../utils/yahoo-http';

const marketSentimentCache = new NodeCache({ stdTTL: 60 });
const SENTIMENT_CACHE_KEY = 'market-sentiment';

interface SentimentSignal {
  value: number;
  signal: number;
}

export interface MarketSentimentResponse {
  score: number;
  label: 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed';
  signals: {
    vix: SentimentSignal;
    breadth: SentimentSignal;
    momentum: SentimentSignal;
    priceStrength: SentimentSignal;
    putCall: SentimentSignal;
    safeHaven: SentimentSignal;
    junkBond: SentimentSignal;
  };
  timestamp: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Signal 1: Market Volatility (VIX)
// VIX vs 50-day MA. VIX far below MA = greed, far above MA = fear.
function mapVixSignal(current: number, ma50: number): number {
  const safeMa50 = ma50 > 0 ? ma50 : current;
  const pctDev = ((current - safeMa50) / safeMa50) * 100;
  const absScore = current <= 12 ? 100 : current >= 35 ? 0 : Math.round(100 - ((current - 12) / 23) * 100);
  const devScore = pctDev <= -30 ? 100 : pctDev >= 50 ? 0 : Math.round(100 - ((pctDev + 30) / 80) * 100);
  return Math.round(clamp(devScore * 0.6 + absScore * 0.4, 0, 100));
}

// Signal 2: Market Momentum - SPY vs 125-day moving average
function mapMomentumSignal(pctAboveMA: number): number {
  if (pctAboveMA <= -8) return 0;
  if (pctAboveMA >= 8) return 100;
  const normalized = ((pctAboveMA + 8) / 16) * 100;
  return Math.round(clamp(normalized, 0, 100));
}

// Signal 3: Stock Price Breadth - % of S&P 500 stocks advancing
function mapBreadthSignal(ratio: number): number {
  return Math.round(clamp(ratio, 0, 1) * 100);
}

// Signal 4: Stock Price Strength - net 52-week highs vs lows
function mapPriceStrengthSignal(strengthRatio: number): number {
  const normalized = ((strengthRatio + 1) / 2) * 100;
  return Math.round(clamp(normalized, 0, 100));
}

// Signal 5: Put/Call Options - CBOE equity put/call ratio
function mapPutCallSignal(ratio: number): number {
  if (ratio >= 1.2) return 0;
  if (ratio <= 0.4) return 100;
  return Math.round(clamp(((1.2 - ratio) / 0.8) * 100, 0, 100));
}

// Signal 6: Junk Bond Demand - HYG vs LQD
function mapJunkBondSignal(junkSpread: number): number {
  if (junkSpread <= -3) return 0;
  if (junkSpread >= 3) return 100;
  const normalized = ((junkSpread + 3) / 6) * 100;
  return Math.round(clamp(normalized, 0, 100));
}

// Signal 7: Safe Haven Demand - stocks vs treasuries
function mapSafeHavenSignal(stocksBondsSpread: number): number {
  if (stocksBondsSpread <= -10) return 0;
  if (stocksBondsSpread >= 10) return 100;
  const normalized = ((stocksBondsSpread + 10) / 20) * 100;
  return Math.round(clamp(normalized, 0, 100));
}

function getLabel(score: number): MarketSentimentResponse['label'] {
  if (score <= 25) return 'Extreme Fear';
  if (score <= 45) return 'Fear';
  if (score <= 55) return 'Neutral';
  if (score <= 75) return 'Greed';
  return 'Extreme Greed';
}

// Data fetchers

async function getVixData(): Promise<{ current: number; ma50: number }> {
  const quote = await fetchFastQuote('^VIX');
  const current = quote?.currentPrice ?? 0;
  if (typeof current !== 'number' || !Number.isFinite(current) || current <= 0) {
    throw new Error('Failed to fetch VIX');
  }

  // Try Polygon first, then Yahoo for daily candles (Polygon doesn't have ^VIX)
  let closes: number[] = [];
  const polygonCandles = await fetchDailyCandles('^VIX', 80);
  if (polygonCandles.length >= 50) {
    closes = polygonCandles.slice(-50).map(c => c.close);
  } else {
    // Yahoo fallback for VIX historical data
    try {
      const now = Math.floor(Date.now() / 1000);
      const from = now - 80 * 24 * 60 * 60;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?period1=${from}&period2=${now}&interval=1d`;
      const resp = await yahooGet(url);
      const result = resp.data?.chart?.result?.[0];
      const rawCloses: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
      closes = rawCloses
        .filter((c: unknown): c is number => typeof c === 'number' && Number.isFinite(c) && c > 0)
        .slice(-50);
    } catch { /* Yahoo also failed */ }
  }

  if (closes.length < 20) {
    return { current, ma50: current };
  }

  const ma50 = closes.reduce((sum, c) => sum + c, 0) / closes.length;
  return { current, ma50 };
}

// SPY price vs 125-day moving average (returns % above/below MA)
async function getSpyMomentum(): Promise<number> {
  const candles = await fetchDailyCandles('SPY', 200);
  if (candles.length < 125) throw new Error('Not enough SPY candle data for 125-day MA');

  const last125 = candles.slice(-125);
  const ma125 = last125.reduce((sum, c) => sum + c.close, 0) / 125;

  const currentPrice = candles[candles.length - 1].close;
  return ((currentPrice - ma125) / ma125) * 100;
}

// Stock-level breadth - ratio of advancing S&P 500 stocks
async function getStockBreadth(): Promise<number> {
  const heatmap = await getHeatmapData('1D', 'SP500');
  let advancing = 0;
  let declining = 0;

  for (const sector of heatmap.sectors) {
    for (const stock of sector.stocks) {
      if (stock.changePercent > 0) advancing++;
      else if (stock.changePercent < 0) declining++;
    }
  }

  const total = advancing + declining;
  if (total === 0) return 0.5;
  return advancing / total;
}

// Stock price strength - net ratio of stocks near 52-week highs vs lows
async function getPriceStrength(): Promise<number> {
  const heatmap = await getHeatmapData('1D', 'SP500');
  let nearHigh = 0;
  let nearLow = 0;
  let total = 0;

  for (const sector of heatmap.sectors) {
    for (const stock of sector.stocks) {
      if (stock.price <= 0) continue;
      const high = stock.week52High;
      const low = stock.week52Low;
      if (high == null || low == null || high <= 0 || low <= 0) continue;

      total++;
      if (stock.price >= high * 0.95) nearHigh++;
      if (stock.price <= low * 1.05) nearLow++;
    }
  }

  if (total === 0) return 0;
  return (nearHigh - nearLow) / total;
}

// Safe haven demand - SPY vs TLT 20-day relative performance
async function getSafeHavenSpread(): Promise<number> {
  const [spyCandles, tltCandles] = await Promise.all([
    fetchDailyCandles('SPY', 25),
    fetchDailyCandles('TLT', 25),
  ]);

  if (spyCandles.length < 20 || tltCandles.length < 20) {
    throw new Error('Not enough candle data for safe haven calculation');
  }

  const spy20 = spyCandles.slice(-20);
  const tlt20 = tltCandles.slice(-20);

  const spyReturn = ((spy20[spy20.length - 1].close - spy20[0].close) / spy20[0].close) * 100;
  const tltReturn = ((tlt20[tlt20.length - 1].close - tlt20[0].close) / tlt20[0].close) * 100;

  return spyReturn - tltReturn;
}

// Junk bond demand - HYG vs LQD 20-day relative performance
async function getJunkBondSpread(): Promise<number> {
  const [hygCandles, lqdCandles] = await Promise.all([
    fetchDailyCandles('HYG', 25),
    fetchDailyCandles('LQD', 25),
  ]);

  if (hygCandles.length < 20 || lqdCandles.length < 20) {
    throw new Error('Not enough candle data for junk bond calculation');
  }

  const hyg20 = hygCandles.slice(-20);
  const lqd20 = lqdCandles.slice(-20);

  const hygReturn = ((hyg20[hyg20.length - 1].close - hyg20[0].close) / hyg20[0].close) * 100;
  const lqdReturn = ((lqd20[lqd20.length - 1].close - lqd20[0].close) / lqd20[0].close) * 100;

  return hygReturn - lqdReturn;
}

async function getPutCallRatio(): Promise<number> {
  // Polygon doesn't have CBOE indices — fetch directly from Yahoo
  for (const ticker of ['%5ECPCE', '%5EPCALL']) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const from = now - 15 * 24 * 60 * 60;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${from}&period2=${now}&interval=1d`;
      const resp = await yahooGet(url);
      const result = resp.data?.chart?.result?.[0];
      const rawCloses: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
      const closes = rawCloses
        .filter((c: unknown): c is number => typeof c === 'number' && Number.isFinite(c) && c > 0);
      if (closes.length >= 3) {
        const last5 = closes.slice(-5);
        return last5.reduce((s, c) => s + c, 0) / last5.length;
      }
    } catch { continue; }
  }

  throw new Error('Failed to fetch put/call ratio');
}

export async function getMarketSentiment(): Promise<MarketSentimentResponse> {
  const cached = marketSentimentCache.get<MarketSentimentResponse>(SENTIMENT_CACHE_KEY);
  if (cached) return cached;

  const [vixResult, breadthRatio, momentumValue, priceStrengthResult, putCallResult, safeHavenResult, junkBondResult] = await Promise.all([
    getVixData().catch(() => null),
    getStockBreadth(),
    getSpyMomentum().catch(() => null),
    getPriceStrength().catch(() => null),
    getPutCallRatio().catch(() => null),
    getSafeHavenSpread().catch(() => null),
    getJunkBondSpread().catch(() => null),
  ]);

  const signals: number[] = [];

  const vixSignal = vixResult != null ? mapVixSignal(vixResult.current, vixResult.ma50) : null;
  const breadthSignal = mapBreadthSignal(breadthRatio);
  const momentumSignal = momentumValue != null ? mapMomentumSignal(momentumValue) : null;
  const priceStrengthSignal = priceStrengthResult != null ? mapPriceStrengthSignal(priceStrengthResult) : null;
  const putCallSignal = putCallResult != null ? mapPutCallSignal(putCallResult) : null;
  const safeHavenSignal = safeHavenResult != null ? mapSafeHavenSignal(safeHavenResult) : null;
  const junkBondSignal = junkBondResult != null ? mapJunkBondSignal(junkBondResult) : null;

  if (vixSignal != null) signals.push(vixSignal);
  signals.push(breadthSignal);
  if (momentumSignal != null) signals.push(momentumSignal);
  if (priceStrengthSignal != null) signals.push(priceStrengthSignal);
  if (putCallSignal != null) signals.push(putCallSignal);
  if (safeHavenSignal != null) signals.push(safeHavenSignal);
  if (junkBondSignal != null) signals.push(junkBondSignal);

  const score = Math.round(signals.reduce((a, b) => a + b, 0) / signals.length);

  const response: MarketSentimentResponse = {
    score,
    label: getLabel(score),
    signals: {
      vix: {
        value: round2(vixResult?.current ?? 0),
        signal: vixSignal ?? 0,
      },
      breadth: {
        value: round2(breadthRatio),
        signal: breadthSignal,
      },
      momentum: {
        value: round2(momentumValue ?? 0),
        signal: momentumSignal ?? 0,
      },
      priceStrength: {
        value: round2(priceStrengthResult ?? 0),
        signal: priceStrengthSignal ?? 0,
      },
      putCall: {
        value: round2(putCallResult ?? 0),
        signal: putCallSignal ?? 0,
      },
      safeHaven: {
        value: round2(safeHavenResult ?? 0),
        signal: safeHavenSignal ?? 0,
      },
      junkBond: {
        value: round2(junkBondResult ?? 0),
        signal: junkBondSignal ?? 0,
      },
    },
    timestamp: new Date().toISOString(),
  };

  marketSentimentCache.set(SENTIMENT_CACHE_KEY, response);
  return response;
}

void getMarketSentiment().catch(() => {
  // Best-effort startup pre-warm; failures should not affect boot.
});
