import NodeCache from 'node-cache';
import prisma from '../utils/prisma';
import { getHoldings } from './portfolio.service';
import { fetchPrices } from './market.service';
import { fetchPolygonAggs } from '../utils/yahoo-http';
import { getSector } from '../utils/sectors';
import { fetchTickerNews } from './news.service';
import { sendPushToUser } from './push.service';


// Cooldown: 1 anomaly per user+ticker+type per 4 hours (general), 7 days (dividend)
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h — one alert per stock per day
const DIVIDEND_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

// ETFs with variable distributions — skip from dividend raise/cut detection
const ETF_VARIABLE_DISTRIBUTIONS = new Set([
  'DIA', 'SPY', 'QQQ', 'IWM', 'VTI', 'VOO', 'VEA', 'VWO', 'EEM', 'EFA',
  'XLF', 'XLK', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE',
  'RSP', 'IVV', 'IJH', 'IJR', 'MDY', 'FEZ', 'EWJ', 'EWY', 'EWP', 'EWZ',
  'AGG', 'BND', 'LQD', 'HYG', 'TLT', 'SHY', 'TIP', 'VCIT', 'VCSH',
  'GLD', 'SLV', 'IAU', 'GDXJ', 'XBI', 'XME', 'IGV', 'NLR',
]);

// News analysis cache: 8 hours per ticker — news doesn't change fast for the same move
const analysisCache = new NodeCache({ stdTTL: 28800 });

// Volume baseline cache: daily candles cached 6 hours (historical data won't change intraday)
const volumeCache = new NodeCache({ stdTTL: 21600 });

// Thresholds
const VOLUME_SPIKE_MULTIPLIER = 2.0;
const VOLUME_CRITICAL_MULTIPLIER = 5.0;
const PRICE_SPIKE_PCT = 3.0;
const PRICE_CRITICAL_PCT = 5.0;
const CONCENTRATION_PCT = 25.0;

interface AnomalyCandidate {
  ticker: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  value: number;
  threshold: number;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function getVolumeBaseline(ticker: string): Promise<{ avgVolume: number; todayVolume: number } | null> {
  const cacheKey = `vol:${ticker}`;
  const cached = volumeCache.get<{ avgVolume: number; todayVolume: number }>(cacheKey);
  if (cached) return cached;

  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30); // 30 days to get ~20 trading days

  const aggs = await fetchPolygonAggs(ticker, 1, 'day', formatDate(from), formatDate(to));
  if (!aggs || aggs.volumes.length < 5) return null;

  // Last bar is today (partial), previous bars are complete days
  const todayVolume = aggs.volumes[aggs.volumes.length - 1];
  const historicalVolumes = aggs.volumes.slice(0, -1);

  // Average of last 20 complete trading days
  const recentVols = historicalVolumes.slice(-20);
  const avgVolume = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;

  const result = { avgVolume, todayVolume };
  volumeCache.set(cacheKey, result);
  return result;
}

async function checkCooldown(userId: string, ticker: string, type: string, cooldownMs: number = COOLDOWN_MS): Promise<boolean> {
  const cutoff = new Date(Date.now() - cooldownMs);
  const recent = await prisma.anomalyEvent.findFirst({
    where: {
      userId,
      ticker,
      type,
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: 'desc' },
  });
  return recent != null; // true = on cooldown, skip
}

/**
 * Get news-based analysis for a ticker using Finnhub company news (free).
 * Picks the most recent relevant headlines and builds a short summary.
 */
async function getNewsAnalysis(ticker: string): Promise<{ analysis: string; citations: string[] } | null> {
  const cacheKey = `analysis:${ticker}:${formatDate(new Date())}`;
  const cached = analysisCache.get<{ analysis: string; citations: string[] }>(cacheKey);
  if (cached) return cached;

  try {
    const news = await fetchTickerNews(ticker, 5);
    if (!news || news.length === 0) return null;

    // Pick up to 3 most recent headlines as the analysis
    const recent = news.slice(0, 3);
    const analysis = recent
      .map(n => `${n.headline} (${n.source})`)
      .join('. ') + '.';
    const citations = recent.map(n => n.url).filter(Boolean);

    const result = { analysis, citations };
    analysisCache.set(cacheKey, result);
    return result;
  } catch (err: any) {
    console.error(`[Anomaly] News fetch failed for ${ticker}:`, err.message);
    return null;
  }
}

export async function detectAnomalies(userId: string): Promise<void> {
  console.log('[Anomaly Detection] Running scan...');

  const holdings = await getHoldings(userId);
  if (holdings.length === 0) {
    console.log('[Anomaly Detection] No holdings, skipping');
    return;
  }

  // Load user-configured price spike threshold (falls back to default 3%)
  const userSettings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { priceSpikePct: true },
  });
  const userPriceSpikePct = userSettings?.priceSpikePct ?? PRICE_SPIKE_PCT;
  // Critical threshold is always ~2% above warning (matches original 3→5 relationship)
  const userPriceCriticalPct = userPriceSpikePct + 2.0;

  const tickers = holdings.map(h => h.ticker);
  const { quotes } = await fetchPrices(tickers, { preferPolygon: true });

  const candidates: AnomalyCandidate[] = [];

  // Calculate total portfolio value for concentration check
  let totalValue = 0;
  const holdingValues = new Map<string, number>();
  for (const h of holdings) {
    const q = quotes.get(h.ticker);
    if (q) {
      const val = h.shares * q.currentPrice;
      holdingValues.set(h.ticker, val);
      totalValue += val;
    }
  }

  // Per-ticker checks
  for (const h of holdings) {
    const q = quotes.get(h.ticker);
    if (!q || q.currentPrice <= 0) continue;

    // Price spike check (intraday change %)
    const changePct = Math.abs(q.changePercent);
    if (changePct >= userPriceSpikePct) {
      const direction = q.changePercent > 0 ? 'up' : 'down';
      const severity = changePct >= userPriceCriticalPct ? 'critical' as const : 'warning' as const;
      candidates.push({
        ticker: h.ticker,
        type: 'price_spike',
        severity,
        title: `${h.ticker}: ${direction === 'up' ? 'Surging' : 'Dropping'} ${changePct.toFixed(1)}% today`,
        description: `${h.ticker} is ${direction} ${changePct.toFixed(1)}% ($${q.currentPrice.toFixed(2)}) from previous close of $${q.previousClose.toFixed(2)}.`,
        value: changePct,
        threshold: userPriceSpikePct,
      });
    }

    // Concentration check
    const holdingVal = holdingValues.get(h.ticker) ?? 0;
    if (totalValue > 0) {
      const concPct = (holdingVal / totalValue) * 100;
      if (concPct >= CONCENTRATION_PCT) {
        candidates.push({
          ticker: h.ticker,
          type: 'concentration',
          severity: 'info',
          title: `${h.ticker}: ${concPct.toFixed(1)}% of portfolio`,
          description: `${h.ticker} now represents ${concPct.toFixed(1)}% of your portfolio ($${holdingVal.toFixed(0)} of $${totalValue.toFixed(0)}). Consider rebalancing.`,
          value: concPct,
          threshold: CONCENTRATION_PCT,
        });
      }
    }
  }

  // Volume spike checks (batched — only fetch for tickers not on cooldown)
  const volumeCheckTickers = tickers.filter(t => {
    // Quick in-memory pre-check — skip if we already have a price spike candidate for this ticker
    return !candidates.some(c => c.ticker === t && c.type === 'volume_spike');
  });

  // Check volumes in batches of 5
  for (let i = 0; i < volumeCheckTickers.length; i += 5) {
    const batch = volumeCheckTickers.slice(i, i + 5);
    const volumeResults = await Promise.all(batch.map(t => getVolumeBaseline(t).catch(() => null)));

    for (let j = 0; j < batch.length; j++) {
      const ticker = batch[j];
      const vol = volumeResults[j];
      if (!vol || vol.avgVolume <= 0) continue;

      const ratio = vol.todayVolume / vol.avgVolume;
      if (ratio >= VOLUME_SPIKE_MULTIPLIER) {
        const severity = ratio >= VOLUME_CRITICAL_MULTIPLIER ? 'critical' as const : 'warning' as const;
        candidates.push({
          ticker,
          type: 'volume_spike',
          severity,
          title: `${ticker}: ${ratio.toFixed(1)}x average volume`,
          description: `${ticker} is trading at ${ratio.toFixed(1)}x its 20-day average volume (${(vol.todayVolume / 1e6).toFixed(1)}M vs avg ${(vol.avgVolume / 1e6).toFixed(1)}M).`,
          value: ratio,
          threshold: VOLUME_SPIKE_MULTIPLIER,
        });
      }
    }
  }

  // Sector divergence check
  const sectorReturns = new Map<string, { total: number; count: number; tickers: string[] }>();
  for (const h of holdings) {
    const q = quotes.get(h.ticker);
    if (!q) continue;
    const sector = getSector(h.ticker);
    if (!sector || sector === 'Unknown') continue;
    const existing = sectorReturns.get(sector) ?? { total: 0, count: 0, tickers: [] };
    existing.total += q.changePercent;
    existing.count++;
    existing.tickers.push(h.ticker);
    sectorReturns.set(sector, existing);
  }

  if (sectorReturns.size >= 2) {
    const sectorAvgs = Array.from(sectorReturns.entries()).map(([sector, data]) => ({
      sector,
      avg: data.total / data.count,
      tickers: data.tickers,
    }));
    const overallAvg = sectorAvgs.reduce((s, e) => s + e.avg, 0) / sectorAvgs.length;

    for (const sa of sectorAvgs) {
      const divergence = Math.abs(sa.avg - overallAvg);
      if (divergence >= 3.0 && sa.tickers.length >= 1) {
        const direction = sa.avg > overallAvg ? 'outperforming' : 'underperforming';
        candidates.push({
          ticker: sa.tickers[0], // Representative ticker
          type: 'sector_divergence',
          severity: 'info',
          title: `${sa.sector}: ${direction} by ${divergence.toFixed(1)}%`,
          description: `Your ${sa.sector} holdings (${sa.tickers.join(', ')}) are ${direction} the rest of your portfolio by ${divergence.toFixed(1)}% today.`,
          value: divergence,
          threshold: 3.0,
        });
      }
    }
  }

  console.log(`[Anomaly Detection] Found ${candidates.length} candidates`);

  // Filter by cooldown and create events
  let created = 0;
  for (const c of candidates) {
    const onCooldown = await checkCooldown(userId, c.ticker, c.type);
    if (onCooldown) continue;

    // Attach recent news headlines for price and volume spikes (free via Finnhub)
    let analysis: string | null = null;
    let citations: string | null = null;

    if (c.type === 'price_spike' || c.type === 'volume_spike') {
      const result = await getNewsAnalysis(c.ticker);
      if (result) {
        analysis = result.analysis;
        citations = result.citations.length > 0 ? JSON.stringify(result.citations) : null;
      }
    }

    await prisma.anomalyEvent.create({
      data: {
        userId,
        ticker: c.ticker,
        type: c.type,
        severity: c.severity,
        title: c.title,
        description: c.description,
        analysis,
        citations,
        value: c.value,
        threshold: c.threshold,
      },
    });

    // Fire-and-forget push for warning+critical only
    if (c.severity === 'warning' || c.severity === 'critical') {
      sendPushToUser(userId, {
        title: c.title,
        body: c.description,
        tag: `anomaly-${c.ticker}-${c.type}`,
        data: { type: 'anomaly', url: '/' },
      }).catch(() => {});
    }

    created++;
  }

  console.log(`[Anomaly Detection] Created ${created} new events (${candidates.length - created} on cooldown)`);
}

/**
 * Detect dividend increases/decreases for held tickers.
 * Creates AnomalyEvent with type 'dividend_change'.
 *
 * Guards:
 * 1. exDate recency — latest dividend must be within 60 days (prevents bulk-sync stale alerts)
 * 2. Amount changed — latest vs previous payout must differ
 * 3. Exact-match dedup — skip if we already alerted on this exact changePct for this ticker
 * 4. Cooldown scoped by userId (30-day window prevents repeat spam)
 * 5. ETFs with variable distributions are excluded (consecutive comparison is noisy)
 * 6. Re-checks holding exists at emit time (avoids post-sell stale alerts)
 * 7. Prefers YoY same-quarter comparison for equities when available
 */
export async function detectDividendChanges(userId: string): Promise<void> {
  console.log('[Dividend Change Detection] Running scan...');

  const holdings = await getHoldings(userId);
  if (holdings.length === 0) return;

  let created = 0;
  for (const holding of holdings) {
    const ticker = holding.ticker;

    // Skip ETFs with variable distributions — consecutive comparison is meaningless
    if (ETF_VARIABLE_DISTRIBUTIONS.has(ticker)) continue;

    // Get recent regular dividend events for this ticker (need enough for YoY comparison)
    const events = await prisma.dividendEvent.findMany({
      where: { ticker, dividendType: 'regular' },
      orderBy: { exDate: 'desc' },
      take: 8, // ~2 years of quarterly dividends
    });

    if (events.length < 2) continue;

    const latest = events[0];

    // Only alert on recent dividend changes — the latest dividend's exDate
    // must be within 60 days of now (covers quarterly) OR in the future.
    // This prevents stale alerts when old dividend events are bulk-synced
    // (all getting a fresh createdAt despite exDates months/years ago).
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    if (latest.exDate < sixtyDaysAgo) continue;

    // Only alert if the amount actually changed from the immediately previous
    // payout. This prevents re-alerting every quarter on a stale YoY comparison
    // (e.g., MLM paid $0.83 three quarters in a row but keeps alerting vs $0.79
    // from a year ago).
    if (latest.amountPerShare === events[1].amountPerShare) continue;

    // Try YoY same-quarter comparison first: find a dividend ~12 months ago (9-15 month window)
    let compareEvent = events.find(e => {
      const monthsAgo = (latest.exDate.getTime() - e.exDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
      return monthsAgo >= 9 && monthsAgo <= 15;
    });
    // Fallback: compare to the immediately previous dividend
    if (!compareEvent) compareEvent = events[1];

    if (latest.amountPerShare === compareEvent.amountPerShare) continue;

    // Exact-match dedup: skip if we already alerted on this exact dividend
    // amount for this ticker (prevents infinite re-alerting on the same change)
    const changePctPreview = compareEvent.amountPerShare > 0
      ? ((latest.amountPerShare - compareEvent.amountPerShare) / compareEvent.amountPerShare) * 100
      : 0;
    const alreadyAlerted = await prisma.anomalyEvent.findFirst({
      where: {
        userId,
        ticker,
        type: 'dividend_change',
        value: { gte: changePctPreview - 0.1, lte: changePctPreview + 0.1 },
      },
    });
    if (alreadyAlerted) continue;

    // User-scoped cooldown — 30 days to prevent repeat spam
    const onCooldown = await checkCooldown(userId, ticker, 'dividend_change', DIVIDEND_COOLDOWN_MS);
    if (onCooldown) continue;

    // Re-verify holding still exists (guards against stale-job post-sell alerts)
    const stillHeld = await prisma.holding.findFirst({
      where: { userId, ticker, shares: { gt: 0 } },
      select: { shares: true },
    });
    if (!stillHeld) continue;

    const changeAmount = latest.amountPerShare - compareEvent.amountPerShare;
    const changePct = compareEvent.amountPerShare > 0
      ? (changeAmount / compareEvent.amountPerShare) * 100
      : 0;
    const direction = changeAmount > 0 ? 'raised' : 'cut';
    const comparisonLabel = compareEvent === events[1] ? 'previous payout' : 'year-ago payout';

    // Estimate annual frequency from gap between the two most recent ex-dates
    const daysBetween = Math.abs(latest.exDate.getTime() - events[1].exDate.getTime()) / (1000 * 60 * 60 * 24);
    const estimatedFrequency = daysBetween < 45 ? 12 : daysBetween < 120 ? 4 : daysBetween < 200 ? 2 : 1;

    const annualImpact = changeAmount * stillHeld.shares * estimatedFrequency;
    const severity = Math.abs(changePct) >= 20 ? 'critical' : Math.abs(changePct) >= 10 ? 'warning' : 'info';

    const divTitle = `${ticker} ${direction} dividend ${Math.abs(changePct).toFixed(1)}%`;
    const divDescription = `${ticker} ${direction} its dividend from $${compareEvent.amountPerShare.toFixed(4)} to $${latest.amountPerShare.toFixed(4)} per share vs ${comparisonLabel} (${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%). Your annual income ${changeAmount > 0 ? 'rose' : 'fell'} by $${Math.abs(annualImpact).toFixed(2)}/yr.`;

    await prisma.anomalyEvent.create({
      data: {
        userId,
        ticker,
        type: 'dividend_change',
        severity,
        title: divTitle,
        description: divDescription,
        analysis: null,
        citations: null,
        value: changePct,
        threshold: 0,
      },
    });

    // Fire-and-forget push for warning+critical only
    if (severity === 'warning' || severity === 'critical') {
      sendPushToUser(userId, {
        title: divTitle,
        body: divDescription,
        tag: `anomaly-${ticker}-dividend_change`,
        data: { type: 'anomaly', url: '/' },
      }).catch(() => {});
    }

    created++;
  }

  console.log(`[Dividend Change Detection] Created ${created} alerts`);
}
