import axios from 'axios';
import NodeCache from 'node-cache';
import { fetchFastQuote, fetchDailyCandles } from './market.service';
import { getHeatmapData, HeatmapResponse } from './market-heatmap.service';
import { yahooGet } from '../utils/yahoo-http';

// Cache sentiment until 4 AM ET (pre-market open).
function secondsUntilNextReset(): number {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const resetHour = 4;
  const nextReset = new Date(et);
  nextReset.setHours(resetHour, 0, 0, 0);
  if (et.getHours() >= resetHour) nextReset.setDate(nextReset.getDate() + 1);
  const diffMs = nextReset.getTime() - et.getTime();
  return Math.max(60, Math.floor(diffMs / 1000));
}

const marketSentimentCache = new NodeCache({ stdTTL: 0 });
const SENTIMENT_CACHE_KEY = 'market-sentiment';
let inFlightSentiment: Promise<MarketSentimentResponse> | null = null;

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

// ──────────────────────────────────────────────────────────
// CNN Fear & Greed Index — primary source
// ──────────────────────────────────────────────────────────

interface CnnFearGreedData {
  fear_and_greed: {
    score: number;
    rating: string;
    timestamp: string;
    previous_close: number;
    previous_1_week: number;
    previous_1_month: number;
    previous_1_year: number;
  };
}

function cnnRatingToLabel(rating: string): MarketSentimentResponse['label'] {
  const r = rating.toLowerCase();
  if (r.includes('extreme fear')) return 'Extreme Fear';
  if (r.includes('extreme greed')) return 'Extreme Greed';
  if (r.includes('fear')) return 'Fear';
  if (r.includes('greed')) return 'Greed';
  return 'Neutral';
}

async function fetchCnnFearGreed(): Promise<MarketSentimentResponse> {
  const resp = await axios.get<CnnFearGreedData>(
    'https://production.dataviz.cnn.io/index/fearandgreed/graphdata',
    {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.cnn.com/markets/fear-and-greed',
      },
    },
  );

  const fg = resp.data?.fear_and_greed;
  if (!fg || typeof fg.score !== 'number' || !Number.isFinite(fg.score)) {
    throw new Error('Invalid CNN Fear & Greed response');
  }

  const score = Math.round(fg.score);
  const prevClose = Math.round(fg.previous_close ?? score);

  // Map CNN score to individual signal slots so the UI gauge still renders properly.
  // CNN doesn't break out individual signals, so we set all signals to the overall score.
  const signalValue: SentimentSignal = { value: score, signal: score };

  return {
    score,
    label: cnnRatingToLabel(fg.rating),
    signals: {
      vix: signalValue,
      breadth: signalValue,
      momentum: signalValue,
      priceStrength: signalValue,
      putCall: signalValue,
      safeHaven: { value: prevClose, signal: prevClose },
      junkBond: signalValue,
    },
    timestamp: fg.timestamp || new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────
// Computed fallback (original 7-signal model)
// ──────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function mapVixSignal(current: number, ma50: number): number {
  const safeMa50 = ma50 > 0 ? ma50 : current;
  const pctDev = ((current - safeMa50) / safeMa50) * 100;
  const absScore = current <= 12 ? 100 : current >= 28 ? 0 : Math.round(100 - ((current - 12) / 16) * 100);
  const devScore = pctDev <= -20 ? 100 : pctDev >= 30 ? 0 : Math.round(100 - ((pctDev + 20) / 50) * 100);
  return Math.round(clamp(devScore * 0.7 + absScore * 0.3, 0, 100));
}

function mapMomentumSignal(pctAboveMA: number): number {
  if (pctAboveMA <= -5) return 0;
  if (pctAboveMA >= 5) return 100;
  return Math.round(clamp(((pctAboveMA + 5) / 10) * 100, 0, 100));
}

function mapBreadthSignal(ratio: number): number {
  if (ratio <= 0.35) return 0;
  if (ratio >= 0.65) return 100;
  return Math.round(clamp(((ratio - 0.35) / 0.30) * 100, 0, 100));
}

function mapPriceStrengthSignal(strengthRatio: number): number {
  if (strengthRatio <= -0.2) return 0;
  if (strengthRatio >= 0.2) return 100;
  return Math.round(clamp(((strengthRatio + 0.2) / 0.4) * 100, 0, 100));
}

function mapPutCallSignal(ratio: number): number {
  if (ratio >= 1.0) return 0;
  if (ratio <= 0.5) return 100;
  return Math.round(clamp(((1.0 - ratio) / 0.5) * 100, 0, 100));
}

function mapJunkBondSignal(junkSpread: number): number {
  if (junkSpread <= -2) return 0;
  if (junkSpread >= 2) return 100;
  return Math.round(clamp(((junkSpread + 2) / 4) * 100, 0, 100));
}

function mapSafeHavenSignal(stocksBondsSpread: number): number {
  if (stocksBondsSpread <= -6) return 0;
  if (stocksBondsSpread >= 6) return 100;
  return Math.round(clamp(((stocksBondsSpread + 6) / 12) * 100, 0, 100));
}

function getLabel(score: number): MarketSentimentResponse['label'] {
  if (score <= 25) return 'Extreme Fear';
  if (score < 42) return 'Fear';
  if (score <= 58) return 'Neutral';
  if (score <= 75) return 'Greed';
  return 'Extreme Greed';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function getVixData(): Promise<{ current: number; ma50: number }> {
  const quote = await fetchFastQuote('^VIX');
  const current = quote?.currentPrice ?? 0;
  if (typeof current !== 'number' || !Number.isFinite(current) || current <= 0) {
    throw new Error('Failed to fetch VIX');
  }

  let closes: number[] = [];
  const polygonCandles = await fetchDailyCandles('^VIX', 80);
  if (polygonCandles.length >= 50) {
    closes = polygonCandles.slice(-50).map(c => c.close);
  } else {
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

  if (closes.length < 20) return { current, ma50: current };
  const ma50 = closes.reduce((sum, c) => sum + c, 0) / closes.length;
  return { current, ma50 };
}

async function getSpyMomentum(): Promise<number> {
  const candles = await fetchDailyCandles('SPY', 200);
  if (candles.length < 125) throw new Error('Not enough SPY candle data for 125-day MA');
  const last125 = candles.slice(-125);
  const ma125 = last125.reduce((sum, c) => sum + c.close, 0) / 125;
  const currentPrice = candles[candles.length - 1].close;
  return ((currentPrice - ma125) / ma125) * 100;
}

function getStockBreadth(heatmap: HeatmapResponse): number {
  let posSum = 0;
  let negSum = 0;
  for (const sector of heatmap.sectors) {
    for (const stock of sector.stocks) {
      if (stock.changePercent > 0) posSum += stock.changePercent;
      else if (stock.changePercent < 0) negSum += Math.abs(stock.changePercent);
    }
  }
  const total = posSum + negSum;
  if (total === 0) return 0.5;
  return posSum / total;
}

function getPriceStrength(heatmap: HeatmapResponse): number {
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
      if (stock.price >= high * 0.97) nearHigh++;
      if (stock.price <= low * 1.03) nearLow++;
    }
  }
  if (total === 0) return 0;
  return (nearHigh - nearLow) / total;
}

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
  for (const ticker of ['%5ECPCE', '%5EPCALL', '%5EPCR']) {
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
    } catch {
      continue;
    }
  }
  throw new Error('Failed to fetch put/call ratio from Yahoo');
}

function estimatePutCallFromVix(vixLevel: number): number {
  return 0.40 + (vixLevel / 50);
}

async function computeFallbackSentiment(): Promise<MarketSentimentResponse> {
  const heatmapStart = Date.now();
  const [vixResult, heatmapResult, momentumValue, putCallResult, safeHavenResult, junkBondResult] = await Promise.all([
    getVixData().catch(() => null),
    withTimeout(getHeatmapData('1D', 'SP500'), 20000, 'market heatmap').catch(() => null),
    getSpyMomentum().catch(() => null),
    getPutCallRatio().catch(() => null),
    getSafeHavenSpread().catch(() => null),
    getJunkBondSpread().catch(() => null),
  ]);
  console.log(`[Sentiment] Fallback data fetch ${Date.now() - heatmapStart}ms. VIX:${vixResult ? 'ok' : 'fail'} Heatmap:${heatmapResult ? 'ok' : 'fail'} Momentum:${momentumValue != null ? 'ok' : 'fail'} PutCall:${putCallResult != null ? 'ok' : 'fail'} SafeHaven:${safeHavenResult != null ? 'ok' : 'fail'} JunkBond:${junkBondResult != null ? 'ok' : 'fail'}`);

  const effectivePutCall = putCallResult ?? (vixResult ? estimatePutCallFromVix(vixResult.current) : null);
  const breadthRatio = heatmapResult ? getStockBreadth(heatmapResult) : null;
  const priceStrengthResult = heatmapResult ? getPriceStrength(heatmapResult) : null;
  const signals: number[] = [];

  const vixSignal = vixResult != null ? mapVixSignal(vixResult.current, vixResult.ma50) : null;
  const breadthSignal = breadthRatio != null ? mapBreadthSignal(breadthRatio) : null;
  const momentumSignal = momentumValue != null ? mapMomentumSignal(momentumValue) : null;
  const priceStrengthSignal = priceStrengthResult != null ? mapPriceStrengthSignal(priceStrengthResult) : null;
  const putCallSignal = effectivePutCall != null ? mapPutCallSignal(effectivePutCall) : null;
  const safeHavenSignal = safeHavenResult != null ? mapSafeHavenSignal(safeHavenResult) : null;
  const junkBondSignal = junkBondResult != null ? mapJunkBondSignal(junkBondResult) : null;

  if (vixSignal != null) signals.push(vixSignal);
  if (breadthSignal != null) signals.push(breadthSignal);
  if (momentumSignal != null) signals.push(momentumSignal);
  if (priceStrengthSignal != null) signals.push(priceStrengthSignal);
  if (putCallSignal != null) signals.push(putCallSignal);
  if (safeHavenSignal != null) signals.push(safeHavenSignal);
  if (junkBondSignal != null) signals.push(junkBondSignal);

  const score = Math.round(signals.reduce((a, b) => a + b, 0) / signals.length);
  console.log(`[Sentiment] Fallback signals (${signals.length}): VIX=${vixSignal} Breadth=${breadthSignal} Momentum=${momentumSignal} PriceStr=${priceStrengthSignal} PutCall=${putCallSignal} SafeHaven=${safeHavenSignal} JunkBond=${junkBondSignal} → Score=${score} (${getLabel(score)})`);

  return {
    score,
    label: getLabel(score),
    signals: {
      vix: { value: round2(vixResult?.current ?? 0), signal: vixSignal ?? 0 },
      breadth: { value: round2(breadthRatio ?? 0), signal: breadthSignal ?? 0 },
      momentum: { value: round2(momentumValue ?? 0), signal: momentumSignal ?? 0 },
      priceStrength: { value: round2(priceStrengthResult ?? 0), signal: priceStrengthSignal ?? 0 },
      putCall: { value: round2(effectivePutCall ?? 0), signal: putCallSignal ?? 0 },
      safeHaven: { value: round2(safeHavenResult ?? 0), signal: safeHavenSignal ?? 0 },
      junkBond: { value: round2(junkBondResult ?? 0), signal: junkBondSignal ?? 0 },
    },
    timestamp: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────
// Public API — CNN primary, computed fallback
// ──────────────────────────────────────────────────────────

export async function getMarketSentiment(): Promise<MarketSentimentResponse> {
  const cached = marketSentimentCache.get<MarketSentimentResponse>(SENTIMENT_CACHE_KEY);
  if (cached) return cached;
  if (inFlightSentiment) return inFlightSentiment;

  inFlightSentiment = (async () => {
    // Try CNN first
    try {
      const cnn = await fetchCnnFearGreed();
      console.log(`[Sentiment] CNN Fear & Greed: score=${cnn.score} label=${cnn.label}`);
      marketSentimentCache.set(SENTIMENT_CACHE_KEY, cnn, secondsUntilNextReset());
      return cnn;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Sentiment] CNN Fear & Greed failed (${msg}), falling back to computed index`);
    }

    // Fallback to computed index
    const fallback = await computeFallbackSentiment();
    marketSentimentCache.set(SENTIMENT_CACHE_KEY, fallback, secondsUntilNextReset());
    return fallback;
  })();

  try {
    return await inFlightSentiment;
  } finally {
    inFlightSentiment = null;
  }
}

// Pre-warm on startup (delayed so other caches warm first)
setTimeout(() => {
  void getMarketSentiment().catch(() => {});
}, 15000);
