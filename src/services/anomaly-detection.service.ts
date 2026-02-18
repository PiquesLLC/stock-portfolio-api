import NodeCache from 'node-cache';
import prisma from '../utils/prisma';
import { getHoldings } from './portfolio.service';
import { fetchPrices } from './market.service';
import { fetchPolygonAggs } from '../utils/yahoo-http';
import { getSector } from '../utils/sectors';
import { callPerplexity } from '../utils/perplexity';

const SYSTEM_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

// Cooldown: 1 anomaly per ticker+type per 4 hours
const COOLDOWN_MS = 4 * 60 * 60 * 1000;

// Perplexity explanation cache: 1 hour per ticker
const analysisCache = new NodeCache({ stdTTL: 3600 });

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

async function checkCooldown(ticker: string, type: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - COOLDOWN_MS);
  const recent = await prisma.anomalyEvent.findFirst({
    where: {
      ticker,
      type,
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: 'desc' },
  });
  return recent != null; // true = on cooldown, skip
}

async function getPerplexityAnalysis(ticker: string, context: string): Promise<{ analysis: string; citations: string[] } | null> {
  const cacheKey = `analysis:${ticker}:${formatDate(new Date())}`;
  const cached = analysisCache.get<{ analysis: string; citations: string[] }>(cacheKey);
  if (cached) return cached;

  try {
    const resp = await callPerplexity([
      {
        role: 'system',
        content: 'You are a financial news analyst. Provide a brief 2-3 sentence explanation. Be specific about today\'s catalysts. Respond in plain text, no JSON.',
      },
      {
        role: 'user',
        content: context,
      },
    ], { timeout: 30000 });

    if (!resp?.content) return null;

    // sonar-pro may wrap in markdown fences — strip them
    let analysis = resp.content;
    if (analysis.startsWith('```')) {
      analysis = analysis.replace(/```[a-z]*\n?/g, '').replace(/```$/g, '').trim();
    }

    const result = {
      analysis,
      citations: resp.citations ?? [],
    };
    analysisCache.set(cacheKey, result);
    return result;
  } catch (err: any) {
    console.error(`[Anomaly] Perplexity failed for ${ticker}:`, err.message);
    return null;
  }
}

export async function detectAnomalies(): Promise<void> {
  console.log('[Anomaly Detection] Running scan...');

  const holdings = await getHoldings();
  if (holdings.length === 0) {
    console.log('[Anomaly Detection] No holdings, skipping');
    return;
  }

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
    if (changePct >= PRICE_SPIKE_PCT) {
      const direction = q.changePercent > 0 ? 'up' : 'down';
      const severity = changePct >= PRICE_CRITICAL_PCT ? 'critical' as const : 'warning' as const;
      candidates.push({
        ticker: h.ticker,
        type: 'price_spike',
        severity,
        title: `${h.ticker}: ${direction === 'up' ? 'Surging' : 'Dropping'} ${changePct.toFixed(1)}% today`,
        description: `${h.ticker} is ${direction} ${changePct.toFixed(1)}% ($${q.currentPrice.toFixed(2)}) from previous close of $${q.previousClose.toFixed(2)}.`,
        value: changePct,
        threshold: PRICE_SPIKE_PCT,
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
    const onCooldown = await checkCooldown(c.ticker, c.type);
    if (onCooldown) continue;

    // Get Perplexity analysis for price and volume spikes
    let analysis: string | null = null;
    let citations: string | null = null;

    if (c.type === 'price_spike' || c.type === 'volume_spike') {
      const q = quotes.get(c.ticker);
      const context = c.type === 'price_spike'
        ? `Stock ${c.ticker} is ${q && q.changePercent > 0 ? 'up' : 'down'} ${c.value.toFixed(1)}% today. What news, events, or market conditions are driving this move?`
        : `Stock ${c.ticker} is trading at ${c.value.toFixed(1)}x its average daily volume today. What news or events are causing this unusual trading activity?`;

      const result = await getPerplexityAnalysis(c.ticker, context);
      if (result) {
        analysis = result.analysis;
        citations = result.citations.length > 0 ? JSON.stringify(result.citations) : null;
      }
    }

    await prisma.anomalyEvent.create({
      data: {
        userId: SYSTEM_USER_ID,
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
    created++;
  }

  console.log(`[Anomaly Detection] Created ${created} new events (${candidates.length - created} on cooldown)`);
}

/**
 * Detect dividend increases/decreases for held tickers.
 * Creates AnomalyEvent with type 'dividend_change'.
 */
export async function detectDividendChanges(): Promise<void> {
  console.log('[Dividend Change Detection] Running scan...');

  const holdings = await getHoldings();
  if (holdings.length === 0) return;

  let created = 0;
  for (const holding of holdings) {
    const ticker = holding.ticker;

    // Get the last 2 regular dividend events for this ticker
    const events = await prisma.dividendEvent.findMany({
      where: { ticker, dividendType: 'regular' },
      orderBy: { exDate: 'desc' },
      take: 2,
    });

    if (events.length < 2) continue;

    const [latest, previous] = events;
    if (latest.amountPerShare === previous.amountPerShare) continue;

    // Only alert on recent dividend changes — skip if the latest ex-date
    // is more than 7 days old. Without this, the same old dividend change
    // triggers new notifications every cooldown cycle.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (latest.exDate < sevenDaysAgo) continue;

    const onCooldown = await checkCooldown(ticker, 'dividend_change');
    if (onCooldown) continue;

    const changeAmount = latest.amountPerShare - previous.amountPerShare;
    const changePct = (changeAmount / previous.amountPerShare) * 100;
    const direction = changeAmount > 0 ? 'raised' : 'cut';

    // Estimate annual frequency from gap between ex-dates
    const daysBetween = Math.abs(latest.exDate.getTime() - previous.exDate.getTime()) / (1000 * 60 * 60 * 24);
    const estimatedFrequency = daysBetween < 45 ? 12 : daysBetween < 120 ? 4 : daysBetween < 200 ? 2 : 1;

    const annualImpact = changeAmount * holding.shares * estimatedFrequency;
    const severity = Math.abs(changePct) >= 20 ? 'critical' : Math.abs(changePct) >= 10 ? 'warning' : 'info';

    await prisma.anomalyEvent.create({
      data: {
        userId: SYSTEM_USER_ID,
        ticker,
        type: 'dividend_change',
        severity,
        title: `${ticker} ${direction} dividend ${Math.abs(changePct).toFixed(1)}%`,
        description: `${ticker} ${direction} its dividend from $${previous.amountPerShare.toFixed(4)} to $${latest.amountPerShare.toFixed(4)} per share (${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%). Your annual income ${changeAmount > 0 ? 'rose' : 'fell'} by $${Math.abs(annualImpact).toFixed(2)}/yr.`,
        analysis: null,
        citations: null,
        value: changePct,
        threshold: 0,
      },
    });
    created++;
  }

  console.log(`[Dividend Change Detection] Created ${created} alerts`);
}
