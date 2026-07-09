/**
 * Per-stock Risk Temperature — the canonical server-side home of the nine
 * risk metrics + composite previously computed CLIENT-side in the UI's
 * WarningPanel.tsx. One definition site-wide: the stock detail panel, and any
 * future consumer (screener columns, alerts, AI), read the same numbers.
 *
 * Math is a verbatim port of the client engine (thresholds, weights, and
 * display strings preserved) driven by full-history daily candles
 * (fetchCandles MAX/1D — itself 1h-cached). Descriptive analytics only.
 */
import NodeCache from 'node-cache';
import { fetchCandles } from './market.service';

export interface RiskMetricResult {
  value: string;
  context: string;
  percentile?: number;
  level: 'low' | 'elevated' | 'high';
  detail?: string;
  explanation?: string;
}

export interface RiskTemperatureMetrics {
  temperature: RiskMetricResult | null;
  trend: RiskMetricResult | null;
  trendBreak: RiskMetricResult | null;
  volatility: RiskMetricResult | null;
  euphoria: RiskMetricResult | null;
  crash: RiskMetricResult | null;
  drawdown: RiskMetricResult | null;
  correction: RiskMetricResult | null;
  gap: RiskMetricResult | null;
  distribution: RiskMetricResult | null;
}

export interface RiskTemperatureResponse {
  ticker: string;
  available: boolean; // false when < 200 daily candles of history
  asOf: string | null; // date of the newest candle used
  days: number;
  metrics: RiskTemperatureMetrics | null;
}

// Assembled responses are cheap to serve but ~1M ops to compute over MAX
// history; 30min TTL keeps p99 flat (underlying candles cache for 1h anyway).
const riskTempCache = new NodeCache({ stdTTL: 1800 });

/* ─── Pure math utilities (ported verbatim) ─── */

function dailyReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] === 0) continue; // skip zero-close to avoid Infinity
    r.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return r;
}

function movingAverage(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function percentileRank(value: number, history: number[]): number {
  if (history.length === 0) return 50;
  let below = 0;
  let equal = 0;
  for (const v of history) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  // Mid-rank: count below + half of equal for tie-breaking
  return ((below + equal * 0.5) / history.length) * 100;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function calculateRSI(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/* ─── Metric engines (ported verbatim from WarningPanel.tsx) ─── */

function computeCorrectionClocks(closes: number[]): RiskMetricResult | null {
  if (closes.length < 365) return null;
  try {
    const thresholds = [0.10, 0.20, 0.30];
    const today = closes.length - 1;
    const years = (closes.length / 252).toFixed(1);

    // Pass 1: walk forward, track completed corrections (drawdown crossed T%,
    // then price made a new high — record the new-high index).
    const completedDates: number[][] = [[], [], []];
    let peak = closes[0];
    const inCorrection = [false, false, false];

    for (let i = 0; i < closes.length; i++) {
      if (closes[i] >= peak) {
        peak = closes[i];
        for (let t = 0; t < 3; t++) {
          if (inCorrection[t]) {
            completedDates[t].push(i);
            inCorrection[t] = false;
          }
        }
      }
      const dd = (peak - closes[i]) / peak;
      for (let t = 0; t < 3; t++) {
        if (dd >= thresholds[t] && !inCorrection[t]) {
          inCorrection[t] = true;
        }
      }
    }

    // Pass 2: current state from the LAST peak
    let lastPeakIdx = today;
    for (let i = today; i >= 0; i--) {
      if (closes[i] >= peak) { lastPeakIdx = i; break; }
    }

    const currentPrice = closes[today];
    const currentDD = (peak - currentPrice) / peak;

    let highestActiveThreshold = -1;
    for (let t = 2; t >= 0; t--) {
      if (currentDD >= thresholds[t]) { highestActiveThreshold = t; break; }
    }

    let correctionStartDay = 0;
    if (highestActiveThreshold >= 0) {
      let runPeak = closes[lastPeakIdx];
      for (let i = lastPeakIdx + 1; i <= today; i++) {
        if (closes[i] >= runPeak) runPeak = closes[i];
        const dd = (runPeak - closes[i]) / runPeak;
        if (dd >= thresholds[highestActiveThreshold]) {
          correctionStartDay = i;
          break;
        }
      }
    }

    let medianSpacing10 = '—';
    if (completedDates[0].length >= 2) {
      const spacings: number[] = [];
      for (let i = 1; i < completedDates[0].length; i++) {
        spacings.push(completedDates[0][i] - completedDates[0][i - 1]);
      }
      spacings.sort((a, b) => a - b);
      medianSpacing10 = `${spacings[Math.floor(spacings.length / 2)]}d median`;
    }

    if (highestActiveThreshold >= 0) {
      const pct = Math.round(thresholds[highestActiveThreshold] * 100);
      const daysSinceStart = today - correctionStartDay;
      const ddPct = (currentDD * 100).toFixed(1);
      const daysSincePeak = today - lastPeakIdx;

      const level: RiskMetricResult['level'] = highestActiveThreshold >= 1 ? 'high' : 'elevated';
      const explanation = `Currently −${ddPct}% from peak (${daysSincePeak}d ago). ${pct}% threshold first crossed ${daysSinceStart}d ago.`;

      return {
        value: `${pct}% IN PROGRESS`,
        context: `−${ddPct}% from peak · ${daysSinceStart}d since correction began`,
        level,
        explanation,
        detail: `Correction = peak-to-trough decline ≥ ${pct}%. Currently in progress — no new high since peak. Based on ${years} years of data. Descriptive only — not predictive.`,
      };
    }

    const ddPct = (currentDD * 100).toFixed(1);
    const daysSincePeak = today - lastPeakIdx;

    const lastCompleted10 = completedDates[0].length > 0 ? completedDates[0][completedDates[0].length - 1] : null;
    const ds10 = lastCompleted10 !== null ? today - lastCompleted10 : 9999;

    const counts = thresholds.map((t, i) => `${completedDates[i].length}×${Math.round(t * 100)}%`);

    const level: RiskMetricResult['level'] = ds10 > 500 ? 'elevated' : 'low';

    const peakNote = daysSincePeak === 0 ? 'At peak' : `−${ddPct}% from peak (${daysSincePeak}d ago)`;
    const resolved10Note = ds10 < 9999 ? `Last 10%+ correction resolved ${ds10}d ago` : 'No 10%+ correction detected';
    const explanation = `${peakNote}. ${resolved10Note}. Historical: ${counts.join(', ')} corrections in ${years}yr.`;

    return {
      value: daysSincePeak === 0 ? 'At Peak' : `−${ddPct}%`,
      context: ds10 < 9999 ? `${resolved10Note} · ${medianSpacing10}` : `No correction on record · ${years}yr data`,
      level,
      explanation,
      detail: `Correction = peak-to-trough decline ≥ threshold. Completed = new high made after the drawdown. If currently in a drawdown < 10%, the current distance from peak is shown. Based on ${years} years of data. Descriptive only — not predictive.`,
    };
  } catch { return null; }
}

function computeTrendDistance(closes: number[]): RiskMetricResult | null {
  if (closes.length < 400) return null;
  try {
    const current = closes[closes.length - 1];
    const ma200 = movingAverage(closes, 200)!;
    const ma400 = movingAverage(closes, 400)!;
    const distMA200 = ((current - ma200) / ma200) * 100;
    const distMA400 = ((current - ma400) / ma400) * 100;

    const historical: number[] = [];
    for (let i = 200; i < closes.length; i++) {
      let s = 0;
      for (let j = i - 200; j < i; j++) s += closes[j];
      const h = s / 200;
      historical.push(((closes[i] - h) / h) * 100);
    }
    const pctl = percentileRank(distMA200, historical);

    const sign200 = distMA200 >= 0 ? '+' : '';
    const sign400 = distMA400 >= 0 ? '+' : '';

    const level: RiskMetricResult['level'] = pctl > 85 ? 'high' : pctl > 65 ? 'elevated' : 'low';
    const explanation = level === 'low'
      ? 'Price within typical range of long-term trend.'
      : level === 'elevated'
        ? `Price ${sign200}${distMA200.toFixed(1)}% from MA200 — more extended than ${pctl.toFixed(0)}% of historical readings.`
        : `Price significantly extended above long-term trend at ${pctl.toFixed(0)}th percentile.`;

    return {
      value: `${sign200}${distMA200.toFixed(1)}%`,
      context: `vs MA200 (${pctl.toFixed(0)}th pctl) · ${sign400}${distMA400.toFixed(1)}% vs MA400`,
      percentile: pctl,
      level,
      explanation,
      detail: `Current price vs 200-day and 400-day moving averages. Percentile based on ${(closes.length / 252).toFixed(1)} years. Higher = more extended. Not financial advice.`,
    };
  } catch { return null; }
}

function computeTrendBreak(closes: number[]): RiskMetricResult | null {
  if (closes.length < 200) return null;
  try {
    const current = closes[closes.length - 1];
    const ma50 = movingAverage(closes, 50)!;
    const ma100 = movingAverage(closes, 100)!;
    const ma200 = movingAverage(closes, 200)!;

    const belowMA50 = current < ma50;
    const belowMA100 = current < ma100;
    const belowMA200 = current < ma200;

    let daysBelow200 = 0;
    for (let i = closes.length - 1; i >= 200; i--) {
      let s = 0;
      for (let j = i - 200; j < i; j++) s += closes[j];
      if (closes[i] < s / 200) daysBelow200++;
      else break;
    }

    const ma50toMA200 = ((ma50 - ma200) / ma200) * 100;
    const deathCrossActive = ma50 < ma200;

    let value = '';
    let context = '';
    let level: RiskMetricResult['level'] = 'low';

    if (deathCrossActive) {
      value = 'Death Cross Active';
      context = `MA50 ${ma50toMA200.toFixed(1)}% below MA200`;
      level = 'high';
    } else if (belowMA200) {
      value = `Below MA200 (${daysBelow200}d)`;
      context = `Death cross watch: MA50 ${ma50toMA200 >= 0 ? '+' : ''}${ma50toMA200.toFixed(1)}% vs MA200`;
      level = daysBelow200 >= 5 ? 'high' : 'elevated';
    } else if (belowMA100) {
      value = 'Below MA100';
      context = `Above MA200 · MA50 ${ma50toMA200 >= 0 ? '+' : ''}${ma50toMA200.toFixed(1)}% vs MA200`;
      level = 'elevated';
    } else if (belowMA50) {
      value = 'Below MA50';
      context = 'Above MA100 & MA200';
      level = 'elevated';
    } else if (ma50toMA200 < 2) {
      value = 'Death Cross Watch';
      context = `MA50 only +${ma50toMA200.toFixed(1)}% above MA200`;
      level = 'elevated';
    } else {
      value = 'Healthy Uptrend';
      context = `Above all major MAs · MA50 +${ma50toMA200.toFixed(1)}% vs MA200`;
      level = 'low';
    }

    const explanation = level === 'low'
      ? 'Price above MA50, MA100, and MA200. No recent downside breaks.'
      : level === 'elevated'
        ? `Price has broken below a key moving average. Trend structure weakening.`
        : deathCrossActive ? 'MA50 has crossed below MA200 — a historically bearish trend signal.' : `Price trading below MA200 for ${daysBelow200} consecutive days.`;

    return { value, context, level, explanation, detail: 'Price position relative to 50/100/200-day moving averages. Death cross = MA50 crosses below MA200. Not financial advice.' };
  } catch { return null; }
}

function computeVolatility(closes: number[]): RiskMetricResult | null {
  if (closes.length < 200) return null;
  try {
    const ret20 = dailyReturns(closes.slice(-21));
    const vol20 = stdDev(ret20) * Math.sqrt(252) * 100;

    const allRets = dailyReturns(closes);
    const historicalVols: number[] = [];
    for (let i = 20; i < allRets.length; i++) {
      historicalVols.push(stdDev(allRets.slice(i - 20, i)) * Math.sqrt(252) * 100);
    }
    const pctl = percentileRank(vol20, historicalVols);

    const level: RiskMetricResult['level'] = pctl > 80 ? 'high' : pctl > 60 ? 'elevated' : 'low';
    const explanation = level === 'low'
      ? `Recent price swings are within normal historical range.`
      : `Daily price swings at ${vol20.toFixed(1)}% annualized — higher than ${pctl.toFixed(0)}% of historical periods.`;

    return {
      value: `${vol20.toFixed(1)}%`,
      context: `20D annualized (${pctl.toFixed(0)}th percentile)`,
      percentile: pctl,
      level,
      explanation,
      detail: `20-day realized volatility, annualized (×√252). Percentile vs ${(closes.length / 252).toFixed(1)} years of history. Not financial advice.`,
    };
  } catch { return null; }
}

function computeCrashCluster(closes: number[]): RiskMetricResult | null {
  if (closes.length < 200) return null;
  try {
    const ret30 = dailyReturns(closes.slice(-31));
    const crashDays = ret30.filter(r => r <= -0.02).length;

    const allRets = dailyReturns(closes);
    const historicalCounts: number[] = [];
    for (let i = 30; i < allRets.length; i++) {
      historicalCounts.push(allRets.slice(i - 30, i).filter(r => r <= -0.02).length);
    }
    const pctl = percentileRank(crashDays, historicalCounts);

    const level: RiskMetricResult['level'] = pctl > 80 ? 'high' : pctl > 60 ? 'elevated' : 'low';
    const explanation = level === 'low'
      ? `${crashDays} day${crashDays !== 1 ? 's' : ''} ≤ −2% in last 30 — historically moderate.`
      : `${crashDays} large down days in 30 sessions — more frequent than ${pctl.toFixed(0)}% of historical windows.`;

    return {
      value: `${crashDays}`,
      context: `days ≤ −2% in last 30 (${pctl.toFixed(0)}th pctl)`,
      percentile: pctl,
      level,
      explanation,
      detail: `Count of trading days with ≥2% decline in the last 30 sessions. Percentile vs rolling 30-day windows over full history. Not financial advice.`,
    };
  } catch { return null; }
}

function computeDrawdownPressure(closes: number[]): RiskMetricResult | null {
  if (closes.length < 252) return null;
  try {
    const last252 = closes.slice(-252);
    const high52w = Math.max(...last252);
    const current = closes[closes.length - 1];
    const currentDD = ((current - high52w) / high52w) * 100;

    let peak = last252[0];
    let worstDD = 0;
    for (const c of last252) {
      if (c > peak) peak = c;
      const dd = (peak - c) / peak;
      if (dd > worstDD) worstDD = dd;
    }

    const absDD = Math.abs(currentDD);
    const level: RiskMetricResult['level'] = absDD > 20 ? 'high' : absDD > 10 ? 'elevated' : 'low';
    const explanation = level === 'low'
      ? `Price within ${absDD.toFixed(1)}% of 52-week high — minimal drawdown.`
      : `${absDD.toFixed(1)}% decline from 52-week high. Worst 12M drop was ${(worstDD * 100).toFixed(1)}%.`;

    return {
      value: `${currentDD.toFixed(1)}%`,
      context: `from 52w high · worst 12M: −${(worstDD * 100).toFixed(1)}%`,
      level,
      explanation,
      detail: `Current decline from 52-week high, and the maximum peak-to-trough drop in the last 12 months. Not financial advice.`,
    };
  } catch { return null; }
}

function computeGapRisk(closes: number[], opens: number[]): RiskMetricResult | null {
  if (closes.length < 200 || opens.length < 200) return null;
  const recentOpens = opens.slice(-21);
  if (recentOpens.some(o => o === 0 || o == null)) return null;
  try {
    const recentCloses = closes.slice(-21);
    const gaps: number[] = [];
    for (let i = 0; i < 20; i++) {
      gaps.push(Math.abs((recentOpens[i + 1] - recentCloses[i]) / recentCloses[i]));
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

    const historicalAvgs: number[] = [];
    for (let i = 21; i < closes.length; i++) {
      const g: number[] = [];
      for (let j = i - 20; j < i; j++) {
        if (opens[j + 1] && closes[j]) {
          g.push(Math.abs((opens[j + 1] - closes[j]) / closes[j]));
        }
      }
      if (g.length === 20) historicalAvgs.push(g.reduce((a, b) => a + b, 0) / g.length);
    }
    const pctl = percentileRank(avgGap, historicalAvgs);

    const level: RiskMetricResult['level'] = pctl > 80 ? 'high' : pctl > 60 ? 'elevated' : 'low';
    const explanation = level === 'low'
      ? 'Overnight gaps between sessions are within normal range.'
      : `Average overnight gap at ${pctl.toFixed(0)}th percentile — larger than typical.`;

    return {
      value: `${(avgGap * 100).toFixed(2)}%`,
      context: `20D avg gap (${pctl.toFixed(0)}th pctl)`,
      percentile: pctl,
      level,
      explanation,
      detail: `Average absolute overnight gap (open vs prior close) over 20 sessions. Larger gaps = more overnight risk. Not financial advice.`,
    };
  } catch { return null; }
}

function computeDistributionDays(closes: number[], volumes: number[]): RiskMetricResult | null {
  if (closes.length < 200 || volumes.length < 200) return null;
  const recentVols = volumes.slice(-21);
  if (recentVols.some(v => v === 0 || v == null)) return null;
  try {
    const recentCloses = closes.slice(-21);
    const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
    let distDays = 0;
    for (let i = 1; i < 21; i++) {
      if (recentCloses[i] < recentCloses[i - 1] && recentVols[i] > avgVol) {
        distDays++;
      }
    }

    const level: RiskMetricResult['level'] = distDays >= 6 ? 'high' : distDays >= 4 ? 'elevated' : 'low';
    const explanation = level === 'low'
      ? `${distDays} distribution day${distDays !== 1 ? 's' : ''} — low institutional selling pressure.`
      : `${distDays} high-volume down days in 20 sessions. Clusters have historically preceded increased volatility.`;

    return {
      value: `${distDays}`,
      context: 'down + high-volume days in last 20',
      level,
      explanation,
      detail: `Distribution day = price decline on above-average volume. Clusters of distribution days have historically preceded increased volatility. This is contextual, not predictive. Not financial advice.`,
    };
  } catch { return null; }
}

function computeEuphoriaMeter(closes: number[], volPctl: number | undefined, trendPctl: number | undefined): RiskMetricResult | null {
  if (closes.length < 200) return null;
  try {
    const rsi = calculateRSI(closes);
    if (rsi === null) return null;

    const rsiComponent = rsi;
    const overextComponent = trendPctl ?? 50;
    const volComponent = volPctl ?? 50;

    // Weighted: RSI 40%, overextension 35%, vol 25%
    const score = rsiComponent * 0.40 + overextComponent * 0.35 + volComponent * 0.25;

    const level: RiskMetricResult['level'] = score > 75 ? 'high' : score > 55 ? 'elevated' : 'low';
    const explanation = level === 'low'
      ? 'Momentum, trend extension, and volatility are within calm ranges.'
      : level === 'elevated'
        ? `Composite reads ${score.toFixed(0)}/100 — above-average momentum and extension.`
        : `RSI at ${rsi.toFixed(0)}, trend at ${overextComponent.toFixed(0)}th percentile — historically stretched.`;

    return {
      value: `${score.toFixed(0)}`,
      context: `RSI ${rsi.toFixed(0)} · trend ${overextComponent.toFixed(0)}p · vol ${volComponent.toFixed(0)}p`,
      percentile: score,
      level,
      explanation,
      detail: `Composite heat score: 40% RSI(14), 35% trend overextension percentile, 25% volatility percentile. Descriptive only — not predictive. Not financial advice.`,
    };
  } catch { return null; }
}

function levelToScore(level: RiskMetricResult['level']): number {
  return level === 'high' ? 95 : level === 'elevated' ? 65 : 30;
}

function computeComposite(metrics: {
  volPctl?: number;
  trendPctl?: number;
  euphoria?: number;
  crashPctl?: number;
  ddPct?: number;
  trendLevel?: RiskMetricResult['level'];
  correctionLevel?: RiskMetricResult['level'];
  gapPctl?: number;
  distributionLevel?: RiskMetricResult['level'];
}): RiskMetricResult | null {
  try {
    const raw = metrics;
    const safe = (v: number | undefined, fallback: number) => { const n = v ?? fallback; return Number.isFinite(n) ? n : fallback; };
    const volPctl = safe(raw.volPctl, 50);
    const trendPctl = safe(raw.trendPctl, 50);
    const euphoria = safe(raw.euphoria, 50);
    const crashPctl = safe(raw.crashPctl, 50);
    const ddPct = safe(raw.ddPct, 0);
    const gapPctl = safe(raw.gapPctl, 50);
    const trendLevel = raw.trendLevel ?? 'low';
    const correctionLevel = raw.correctionLevel ?? 'low';
    const distributionLevel = raw.distributionLevel ?? 'low';

    // Trend distance: two-tailed — far above OR far below trend is risky
    const trendRisk = Math.abs(trendPctl - 50) * 2;

    const trendBreakScore = levelToScore(trendLevel);
    const correctionScore = levelToScore(correctionLevel);
    const distributionScore = levelToScore(distributionLevel);

    const absDd = Math.abs(ddPct);
    const ddScore = absDd > 25 ? 95 : absDd > 15 ? 75 : absDd > 8 ? 55 : 30;

    // Weighted composite — all 9 metrics included
    const score =
      volPctl * 0.15 +
      trendRisk * 0.10 +
      trendBreakScore * 0.15 +
      crashPctl * 0.12 +
      ddScore * 0.15 +
      correctionScore * 0.10 +
      gapPctl * 0.08 +
      distributionScore * 0.10 +
      euphoria * 0.05;

    // Breadth boost: if most metrics are HIGH, nudge score up
    const catLevels = [trendLevel, correctionLevel, distributionLevel];
    const pctlHighCount = [volPctl, crashPctl, gapPctl, trendRisk].filter(p => p > 80).length;
    const catHighCount = catLevels.filter(l => l === 'high').length;
    const totalHigh = pctlHighCount + catHighCount + (absDd > 20 ? 1 : 0) + (euphoria > 75 ? 1 : 0);
    const breadthBoost = totalHigh >= 5 ? 8 : totalHigh >= 3 ? 4 : 0;

    const finalScore = Math.min(100, score + breadthBoost);

    let label = 'Low';
    let level: RiskMetricResult['level'] = 'low';
    if (finalScore >= 70) { label = 'High'; level = 'high'; }
    else if (finalScore >= 50) { label = 'Elevated'; level = 'elevated'; }

    const explanation = level === 'low'
      ? 'Most risk metrics are within normal historical ranges.'
      : level === 'elevated'
        ? 'Several risk metrics are above their historical averages.'
        : 'Multiple risk metrics are at historically elevated levels.';

    return {
      value: `${finalScore.toFixed(0)}`,
      context: label,
      percentile: finalScore,
      explanation,
      level,
      detail: `Composite risk score (0–100) from 9 metrics: volatility, trend distance, trend break, crash clustering, drawdown, correction clocks, gap risk, distribution days, and euphoria. Descriptive — not a prediction. Not financial advice.`,
    };
  } catch { return null; }
}

/* ─── Assembly ─── */

/**
 * Compute the full metric set from raw candle arrays. Exported for tests.
 * Assembly order mirrors the original client: euphoria consumes the
 * volatility/trend percentiles; the composite consumes everything.
 */
export function computeRiskTemperatureFromCandles(candles: {
  closes: number[];
  opens: number[];
  volumes: number[];
}): RiskTemperatureMetrics | null {
  const { closes, opens, volumes } = candles;
  if (closes.length < 200) return null;

  const correction = computeCorrectionClocks(closes);
  const trend = computeTrendDistance(closes);
  const trendBreak = computeTrendBreak(closes);
  const volatility = computeVolatility(closes);
  const crash = computeCrashCluster(closes);
  const drawdown = computeDrawdownPressure(closes);
  const gap = computeGapRisk(closes, opens);
  const distribution = computeDistributionDays(closes, volumes);
  const euphoria = computeEuphoriaMeter(closes, volatility?.percentile, trend?.percentile);

  const ddVal = drawdown ? parseFloat(drawdown.value) : 0;
  const temperature = computeComposite({
    volPctl: volatility?.percentile,
    trendPctl: trend?.percentile,
    euphoria: euphoria?.percentile,
    crashPctl: crash?.percentile,
    ddPct: ddVal,
    trendLevel: trendBreak?.level,
    correctionLevel: correction?.level,
    gapPctl: gap?.percentile,
    distributionLevel: distribution?.level,
  });

  return { temperature, trend, trendBreak, volatility, euphoria, crash, drawdown, correction, gap, distribution };
}

export async function getRiskTemperature(ticker: string): Promise<RiskTemperatureResponse> {
  const upper = ticker.toUpperCase();
  const cacheKey = `risk-temp:${upper}`;
  const cached = riskTempCache.get<RiskTemperatureResponse>(cacheKey);
  if (cached) return cached;

  const candles = await fetchCandles(upper, 'MAX', '1D');
  const closes = candles.map(c => c.close);
  const opens = candles.map(c => c.open);
  const volumes = candles.map(c => c.volume);

  const metrics = computeRiskTemperatureFromCandles({ closes, opens, volumes });
  const response: RiskTemperatureResponse = {
    ticker: upper,
    available: metrics !== null,
    asOf: candles.length > 0 ? candles[candles.length - 1].time.slice(0, 10) : null,
    days: candles.length,
    metrics,
  };

  // Cache even unavailable responses briefly so unknown tickers don't hammer
  // the candle providers (short TTL lets newly-listed data appear).
  riskTempCache.set(cacheKey, response, metrics === null ? 300 : 1800);
  return response;
}
