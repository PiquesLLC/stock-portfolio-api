/**
 * Tax-Loss Harvesting Service — identifies unrealized losses for tax harvesting.
 * Uses portfolio data, lot-level cost basis, and Perplexity AI for recommendations.
 */

import NodeCache from 'node-cache';
import prisma from '../utils/prisma';
import { getHoldings } from './portfolio.service';
import { fetchPrices } from './market.service';
import { getSector } from '../utils/sectors';
import { callPerplexity } from '../utils/perplexity';

const cache = new NodeCache({ stdTTL: 86400 }); // 24-hour cache — tax situation only changes on trades

const SHORT_TERM_TAX_RATE = 0.25;
const LONG_TERM_TAX_RATE = 0.15;

export interface HarvestCandidate {
  ticker: string;
  shares: number;
  costBasis: number;
  currentValue: number;
  unrealizedLoss: number;
  unrealizedLossPct: number;
  holdingPeriod: 'short-term' | 'long-term' | 'mixed';
  potentialTaxSavings: number;
  sector: string;
  daysHeld: number | null;
}

export interface TaxHarvestResponse {
  totalUnrealizedGain: number;
  totalUnrealizedLoss: number;
  netPosition: number;
  estimatedTaxLiability: number;
  potentialTotalSavings: number;
  harvestCandidates: HarvestCandidate[];
  washSaleWarnings: string[];
  aiAnalysis: string | null;
  aiCitations: string[];
  generatedAt: string;
  cached: boolean;
}

export async function getTaxHarvestSuggestions(userId: string, portfolioId?: string): Promise<TaxHarvestResponse> {
  const cacheKey = `tax-harvest:${userId}${portfolioId ? `:${portfolioId}` : ''}`;
  const cached_result = cache.get<TaxHarvestResponse>(cacheKey);
  if (cached_result) return { ...cached_result, cached: true };

  const holdings = await getHoldings(userId, portfolioId);
  if (holdings.length === 0) {
    return emptyResponse();
  }

  const tickers = holdings.map(h => h.ticker);
  const priceResult = await fetchPrices(tickers, { preferPolygon: true });
  const quotes = priceResult.quotes;

  // Get lots for holding period determination
  const lots = await prisma.lot.findMany({
    where: { userId, ticker: { in: tickers } },
    orderBy: { acquiredAt: 'asc' },
  });
  const lotsByTicker = new Map<string, typeof lots>();
  for (const lot of lots) {
    const existing = lotsByTicker.get(lot.ticker) ?? [];
    existing.push(lot);
    lotsByTicker.set(lot.ticker, existing);
  }

  let totalUnrealizedGain = 0;
  let totalUnrealizedLoss = 0;
  const candidates: HarvestCandidate[] = [];

  for (const holding of holdings) {
    const quote = quotes.get(holding.ticker);
    if (!quote) continue;

    const currentValue = holding.shares * quote.currentPrice;
    const costBasis = holding.shares * holding.averageCost;
    const unrealized = currentValue - costBasis;

    if (unrealized >= 0) {
      totalUnrealizedGain += unrealized;
    } else {
      totalUnrealizedLoss += Math.abs(unrealized);

      // Determine holding period from lots
      const tickerLots = lotsByTicker.get(holding.ticker) ?? [];
      const now = Date.now();
      let holdingPeriod: 'short-term' | 'long-term' | 'mixed' = 'long-term';
      let oldestDaysHeld: number | null = null;

      if (tickerLots.length > 0) {
        let hasShort = false;
        let hasLong = false;
        for (const lot of tickerLots) {
          const days = Math.floor((now - lot.acquiredAt.getTime()) / (1000 * 60 * 60 * 24));
          if (oldestDaysHeld == null || days > oldestDaysHeld) oldestDaysHeld = days;
          if (days < 365) hasShort = true;
          else hasLong = true;
        }
        holdingPeriod = hasShort && hasLong ? 'mixed' : hasShort ? 'short-term' : 'long-term';
      } else {
        // Fall back to holding createdAt
        const days = Math.floor((now - holding.createdAt.getTime()) / (1000 * 60 * 60 * 24));
        oldestDaysHeld = days;
        holdingPeriod = days < 365 ? 'short-term' : 'long-term';
      }

      const taxRate = holdingPeriod === 'short-term' ? SHORT_TERM_TAX_RATE
        : holdingPeriod === 'mixed' ? (SHORT_TERM_TAX_RATE + LONG_TERM_TAX_RATE) / 2
        : LONG_TERM_TAX_RATE;

      candidates.push({
        ticker: holding.ticker,
        shares: holding.shares,
        costBasis: round(costBasis),
        currentValue: round(currentValue),
        unrealizedLoss: round(unrealized),
        unrealizedLossPct: round((unrealized / costBasis) * 100),
        holdingPeriod,
        potentialTaxSavings: round(Math.abs(unrealized) * taxRate),
        sector: getSector(holding.ticker) ?? 'Unknown',
        daysHeld: oldestDaysHeld,
      });
    }
  }

  // Sort by biggest loss first
  candidates.sort((a, b) => a.unrealizedLoss - b.unrealizedLoss);

  // Check for wash sale risk: recently removed tickers
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentActivity = await prisma.activityEvent.findMany({
    where: {
      userId,
      type: 'holding_removed',
      createdAt: { gte: thirtyDaysAgo },
    },
    select: { payload: true },
  });
  const recentSells = [...new Set(recentActivity.map(a => {
    try { return JSON.parse(a.payload).ticker as string; } catch { return ''; }
  }).filter(Boolean))];
  const washSaleWarnings = recentSells.filter(t =>
    candidates.some(c => c.ticker === t)
  ).map(t => `${t} was sold in the last 30 days. Repurchasing within 30 days may trigger wash sale rules.`);

  const potentialTotalSavings = candidates.reduce((s, c) => s + c.potentialTaxSavings, 0);
  const estimatedTaxLiability = round(totalUnrealizedGain * SHORT_TERM_TAX_RATE);

  // AI analysis via Perplexity
  let aiAnalysis: string | null = null;
  let aiCitations: string[] = [];

  if (candidates.length > 0) {
    try {
      const candidateSummary = candidates.slice(0, 8).map(c =>
        `${c.ticker} (${c.sector}): $${Math.abs(c.unrealizedLoss).toFixed(0)} loss (${c.unrealizedLossPct.toFixed(1)}%), ${c.holdingPeriod}, held ${c.daysHeld ?? '?'} days`
      ).join('\n');

      const result = await callPerplexity(
        [
          { role: 'system', content: 'You are a tax planning advisor. Provide brief, practical tax-loss harvesting recommendations. Focus on wash sale rules, sector diversification impact, and whether now is a good time to harvest each position. Respond in 2-3 concise paragraphs.' },
          { role: 'user', content: `Analyze these unrealized losses for tax-loss harvesting opportunities:\n\n${candidateSummary}\n\nTotal unrealized gains: $${totalUnrealizedGain.toFixed(0)}\nTotal unrealized losses: $${totalUnrealizedLoss.toFixed(0)}\nNet: $${(totalUnrealizedGain - totalUnrealizedLoss).toFixed(0)}` },
        ],
        { feature: 'tax-harvest', userId },
      );

      if (result) {
        aiAnalysis = result.content;
        aiCitations = result.citations ?? [];
      }
    } catch (err) {
      console.error('[Tax Harvest] Perplexity analysis failed:', (err as Error).message);
    }
  }

  const response: TaxHarvestResponse = {
    totalUnrealizedGain: round(totalUnrealizedGain),
    totalUnrealizedLoss: round(totalUnrealizedLoss),
    netPosition: round(totalUnrealizedGain - totalUnrealizedLoss),
    estimatedTaxLiability,
    potentialTotalSavings: round(potentialTotalSavings),
    harvestCandidates: candidates,
    washSaleWarnings,
    aiAnalysis,
    aiCitations,
    generatedAt: new Date().toISOString(),
    cached: false,
  };

  cache.set(cacheKey, response);
  return response;
}

function round(v: number, d = 2): number {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

function emptyResponse(): TaxHarvestResponse {
  return {
    totalUnrealizedGain: 0,
    totalUnrealizedLoss: 0,
    netPosition: 0,
    estimatedTaxLiability: 0,
    potentialTotalSavings: 0,
    harvestCandidates: [],
    washSaleWarnings: [],
    aiAnalysis: null,
    aiCitations: [],
    generatedAt: new Date().toISOString(),
    cached: false,
  };
}
