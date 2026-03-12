import NodeCache from 'node-cache';
import { fetchFastQuote, fetchDailyCandles } from './market.service';
import { getHeatmapData, HeatmapResponse } from './market-heatmap.service';
import { yahooGet } from '../utils/yahoo-http';

// Cache sentiment for the rest of the trading day. First request computes it,
// all subsequent users get the cached result. Resets at 4 AM ET (pre-market open).
function secondsUntilNextReset(): number {
  const now = new Date();
  // 4 AM ET = reset time (pre-market open)
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const resetHour = 4;
  const nextReset = new Date(et);
  nextReset.setHours(resetHour, 0, 0, 0);
  if (et.getHours() >= resetHour) nextReset.setDate(nextReset.getDate() + 1);
  const diffMs = nextReset.getTime() - et.getTime();
  return Math.max(60, Math.floor(diffMs / 1000)); // at least 60s
}

const marketSentimentCache = new NodeCache({ stdTTL: 0 }); // TTL set per-key
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Signal 1: Market Volatility (VIX)
// VIX vs 50-day MA. VIX far below MA = greed, far above MA = fear.
// Calibrated to CNN: VIX at 28+ is extreme fear, 12 or below is extreme greed.
// Deviation heavily weighted — VIX spiking above MA is the strongest fear signal.
function mapVixSignal(current: number, ma50: number): number {
  const safeMa50 = ma50 > 0 ? ma50 : current;
  const pctDev = ((current - safeMa50) / safeMa50) * 100;
  // Absolute: VIX 12→100 (greed), VIX 28→0 (fear). Tighter ceiling than before.
  const absScore = current <= 12 ? 100 : current >= 28 ? 0 : Math.round(100 - ((current - 12) / 16) * 100);
  // Deviation: -20%→100 (well below MA=greed), +30%→0 (well above MA=fear)
  const devScore = pctDev <= -20 ? 100 : pctDev >= 30 ? 0 : Math.round(100 - ((pctDev + 20) / 50) * 100);
  return Math.round(clamp(devScore * 0.7 + absScore * 0.3, 0, 100));
}

// Signal 2: Market Momentum - SPY vs 125-day moving average
// Calibrated to CNN: ±5% range (tighter — SPY rarely deviates more in normal conditions)
function mapMomentumSignal(pctAboveMA: number): number {
  if (pctAboveMA <= -5) return 0;
  if (pctAboveMA >= 5) return 100;
  const normalized = ((pctAboveMA + 5) / 10) * 100;
  return Math.round(clamp(normalized, 0, 100));
}

// Signal 3: Stock Price Breadth - magnitude-weighted advancing/declining
// Uses sum of change magnitudes instead of simple count for CNN-like sensitivity.
// Center is slightly above 0.5 since normal bullish markets have mild positive breadth.
function mapBreadthSignal(ratio: number): number {
  // Ratio 0.35→0 (extreme fear), 0.65→100 (extreme greed)
  if (ratio <= 0.35) return 0;
  if (ratio >= 0.65) return 100;
  const normalized = ((ratio - 0.35) / 0.30) * 100;
  return Math.round(clamp(normalized, 0, 100));
}

// Signal 4: Stock Price Strength - net 52-week highs vs lows
// Calibrated to CNN: ±0.2 range (practical range is -0.3 to +0.3, not ±1)
function mapPriceStrengthSignal(strengthRatio: number): number {
  if (strengthRatio <= -0.2) return 0;
  if (strengthRatio >= 0.2) return 100;
  const normalized = ((strengthRatio + 0.2) / 0.4) * 100;
  return Math.round(clamp(normalized, 0, 100));
}

// Signal 5: Put/Call Options - CBOE equity put/call ratio
// Calibrated to CNN: 0.5→100 (extreme greed), 1.0→0 (extreme fear)
// Tighter range — CNN's typical actionable range is 0.6-0.9
function mapPutCallSignal(ratio: number): number {
  if (ratio >= 1.0) return 0;
  if (ratio <= 0.5) return 100;
  return Math.round(clamp(((1.0 - ratio) / 0.5) * 100, 0, 100));
}

// Signal 6: Junk Bond Demand - HYG vs LQD
// Calibrated to CNN: ±2% range (tighter for more sensitivity)
function mapJunkBondSignal(junkSpread: number): number {
  if (junkSpread <= -2) return 0;
  if (junkSpread >= 2) return 100;
  const normalized = ((junkSpread + 2) / 4) * 100;
  return Math.round(clamp(normalized, 0, 100));
}

// Signal 7: Safe Haven Demand - stocks vs treasuries
// Calibrated to CNN: ±6% range (tighter — big bond/stock divergence is rare)
function mapSafeHavenSignal(stocksBondsSpread: number): number {
  if (stocksBondsSpread <= -6) return 0;
  if (stocksBondsSpread >= 6) return 100;
  const normalized = ((stocksBondsSpread + 6) / 12) * 100;
  return Math.round(clamp(normalized, 0, 100));
}

function getLabel(score: number): MarketSentimentResponse['label'] {
  if (score <= 25) return 'Extreme Fear';
  if (score < 42) return 'Fear';
  if (score <= 58) return 'Neutral';
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

// Stock-level breadth - magnitude-weighted advancing/declining
// Sums the absolute change percentages for gainers vs all movers.
// In fearful markets, declines are larger, pulling the ratio well below 0.5.
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

// Stock price strength - net ratio of stocks near 52-week highs vs lows
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
      // Tighter 3% threshold — stocks must be within 3% of their 52-week extreme
      if (stock.price >= high * 0.97) nearHigh++;
      if (stock.price <= low * 1.03) nearLow++;
    }
  }

  if (total === 0) return 0;
  return (nearHigh - nearLow) / total;
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
  // Try Yahoo Finance CBOE equity put/call ratio
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
        const ratio = last5.reduce((s, c) => s + c, 0) / last5.length;
        console.log(`[Sentiment] Put/Call ratio from ${ticker}: ${ratio.toFixed(3)} (${closes.length} days)`);
        return ratio;
      }
    } catch (err: any) {
      console.warn(`[Sentiment] Put/Call ${ticker} failed: ${err?.message || err}`);
      continue;
    }
  }

  throw new Error('Failed to fetch put/call ratio from Yahoo');
}

// VIX-based proxy for put/call ratio when Yahoo tickers are unavailable.
// VIX and equity put/call ratio are correlated (~0.6).
// Rough mapping: VIX 12→PCR 0.55, VIX 20→PCR 0.75, VIX 30→PCR 0.95, VIX 40→PCR 1.10
function estimatePutCallFromVix(vixLevel: number): number {
  const pcr = 0.40 + (vixLevel / 50);
  console.log(`[Sentiment] Put/Call estimated from VIX ${vixLevel}: ${pcr.toFixed(3)}`);
  return pcr;
}

export async function getMarketSentiment(): Promise<MarketSentimentResponse> {
  const cached = marketSentimentCache.get<MarketSentimentResponse>(SENTIMENT_CACHE_KEY);
  if (cached) return cached;
  if (inFlightSentiment) return inFlightSentiment;

  inFlightSentiment = (async () => {
    const heatmapStart = Date.now();
    const [vixResult, heatmapResult, momentumValue, putCallResult, safeHavenResult, junkBondResult] = await Promise.all([
      getVixData().catch((e) => { console.warn('[Sentiment] VIX failed:', e?.message); return null; }),
      withTimeout(getHeatmapData('1D', 'SP500'), 20000, 'market heatmap').catch((e) => { console.warn(`[Sentiment] Heatmap failed after ${Date.now() - heatmapStart}ms:`, e?.message); return null; }),
      getSpyMomentum().catch((e) => { console.warn('[Sentiment] Momentum failed:', e?.message); return null; }),
      getPutCallRatio().catch((e) => { console.warn('[Sentiment] PutCall Yahoo failed:', e?.message); return null; }),
      getSafeHavenSpread().catch((e) => { console.warn('[Sentiment] SafeHaven failed:', e?.message); return null; }),
      getJunkBondSpread().catch((e) => { console.warn('[Sentiment] JunkBond failed:', e?.message); return null; }),
    ]);
    console.log(`[Sentiment] Data fetch complete. VIX:${vixResult ? 'ok' : 'fail'} Heatmap:${heatmapResult ? 'ok' : 'fail'} Momentum:${momentumValue != null ? 'ok' : 'fail'} PutCall:${putCallResult != null ? 'ok' : 'fail'} SafeHaven:${safeHavenResult != null ? 'ok' : 'fail'} JunkBond:${junkBondResult != null ? 'ok' : 'fail'}`);

    // Fallback: estimate put/call from VIX when Yahoo tickers are unavailable
    const effectivePutCall = putCallResult ?? (vixResult ? estimatePutCallFromVix(vixResult.current) : null);

    // Only compute heatmap-derived signals when heatmap data is available (no fake fallbacks)
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
    console.log(`[Sentiment] Signals (${signals.length}): VIX=${vixSignal} Breadth=${breadthSignal} Momentum=${momentumSignal} PriceStr=${priceStrengthSignal} PutCall=${putCallSignal} SafeHaven=${safeHavenSignal} JunkBond=${junkBondSignal} → Score=${score} (${getLabel(score)})`);

    const response: MarketSentimentResponse = {
      score,
      label: getLabel(score),
      signals: {
        vix: {
          value: round2(vixResult?.current ?? 0),
          signal: vixSignal ?? 0,
        },
        breadth: {
          value: round2(breadthRatio ?? 0),
          signal: breadthSignal ?? 0,
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
          value: round2(effectivePutCall ?? 0),
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

    marketSentimentCache.set(SENTIMENT_CACHE_KEY, response, secondsUntilNextReset());
    return response;
  })();

  try {
    return await inFlightSentiment;
  } finally {
    inFlightSentiment = null;
  }
}

// Delay pre-warm so heatmap and other caches have time to warm first
setTimeout(() => {
  void getMarketSentiment().catch(() => {
    // Best-effort startup pre-warm; failures should not affect boot.
  });
}, 15000);
