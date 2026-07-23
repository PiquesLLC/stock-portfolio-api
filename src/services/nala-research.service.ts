import NodeCache from 'node-cache';
import prisma from '../utils/prisma';
import { callAI } from '../utils/ai-provider';
import { extractJson } from '../utils/perplexity';
import { sanitizeContent, validateCitationUrl } from '../utils/content-filter';
import { matchPersona, StrategyPersona } from '../data/strategy-personas';
import { getPortfolio } from './portfolio.service';
import { enforceAiText } from '../eval/financial-safety/enforce';



// Cache research results for 2 hours (7200s) — screening data doesn't shift in 30 min
const nalaCache = new NodeCache({ stdTTL: 7200 });

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface NalaStockMetrics {
  peRatio: number | null;
  roe: number | null;
  debtToEquity: number | null;
  dividendYield: number | null;
  revenueGrowthYoY: number | null;
  profitMargin: number | null;
  freeCashFlowYield: number | null;
  marketCapB: number | null;
  beta: number | null;
  pegRatio: number | null;
}

export interface NalaLocalDataMatch {
  ticker: string;
  isHeld: boolean;
  localMetrics: {
    peRatio: number | null;
    roe: number | null;
    dividendYield: number | null;
    profitMargin: number | null;
    marketCap: number | null;
    beta: number | null;
  };
  deviations: string[];
}

export interface NalaStockResult {
  ticker: string;
  companyName: string;
  sector: string;
  currentPrice: number | null;
  metrics: NalaStockMetrics;
  confidenceScore: number;
  explanation: string;
  risks: string;
  localData: NalaLocalDataMatch | null;
}

export interface NalaStrategyInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  riskLevel: 'conservative' | 'moderate' | 'aggressive';
}

export interface NalaResearchResponse {
  question: string;
  strategy: NalaStrategyInfo | null;
  stocks: NalaStockResult[];
  strategyExplanation: string;
  citations: string[];
  generatedAt: string;
  cached: boolean;
}

export interface NalaSuggestion {
  text: string;
  icon: string;
}

export interface NalaSuggestionsResponse {
  suggestions: NalaSuggestion[];
}

// â”€â”€ System Prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SYSTEM_PROMPT = `You are a stock research engine. Return ONLY valid JSON matching this exact schema:
{
  "stocks": [
    {
      "ticker": "AAPL",
      "companyName": "Apple Inc.",
      "sector": "Technology",
      "currentPrice": 185.50,
      "metrics": {
        "peRatio": 28.5,
        "roe": 147.0,
        "debtToEquity": 1.76,
        "dividendYield": 0.55,
        "revenueGrowthYoY": 8.2,
        "profitMargin": 25.3,
        "freeCashFlowYield": 3.8,
        "marketCapB": 2850,
        "beta": 1.28,
        "pegRatio": 2.1
      },
      "confidenceScore": 85,
      "explanation": "2-3 sentences explaining WHY this stock fits the criteria, citing specific data points",
      "risks": "1-2 sentences on key risks"
    }
  ],
  "strategyExplanation": "2-3 sentences explaining the overall approach used"
}
Rules:
- Return 5-8 US-listed stocks ranked by fit
- confidenceScore: 60-95 (how well it matches the criteria, never 100)
- All prices and metrics must be current and factual from financial data sources
- NEVER use prediction language ("will go up", "guaranteed", "should buy")
- NEVER recommend buying or selling
- Use phrases like "historically has shown", "currently trades at", "data indicates"
- In explanation and risks text, use HUMAN-READABLE names like "P/E ratio", "return on equity", "revenue growth", "debt-to-equity", "profit margin", "free cash flow yield", "market cap". NEVER use JSON field names like peRatio, roe, debtToEquity, revenueGrowthYoY, marketCapB, freeCashFlowYield, profitMargin in the text.
- Do NOT use markdown formatting (no asterisks, no hashtags, no code fences in explanation, risks, or strategyExplanation). Write plain text only.
- All explanations must cite specific numbers
- marketCapB is in billions (e.g. 2850 for $2.85T)
- Set metrics to null if data is unavailable`;

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function normalizeQuestion(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[?!.]+$/, '');
}

function stripMarkdown(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toNumberOrNull(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function buildUserMessage(question: string, persona: StrategyPersona | null): string {
  if (persona) {
    const metricsDesc = persona.metrics.map(m => m.label).join(', ');

    return (
      `Investment Research Question: "${question}"\n\n` +
      `Strategy: ${persona.name}\n` +
      `Philosophy: ${persona.philosophy}\n` +
      `Strategy traits (guidance, not a strict quantitative filter): ${metricsDesc}\n` +
      `Risk Level: ${persona.riskLevel}\n\n` +
      `Suggest ${persona.stockCount} well-known stocks whose profile is broadly consistent with this strategy.\n` +
      (persona.sectorPreferences ? `Focus on sectors: ${persona.sectorPreferences.join(', ')}\n` : '') +
      (persona.excludeETFs ? 'Exclude ETFs, only individual stocks.\n' : '') +
      `Rank by how well each fits the strategy's spirit and explain the qualitative rationale. ` +
      `Do NOT invent precise figures — Nala fills in the current price and fundamentals from market data.`
    );
  }

  return (
    `Investment Research Question: "${question}"\n\n` +
    `Research this question using current financial data from reputable sources.\n` +
    `Find 5-8 stocks that best answer this question.\n` +
    `For each stock, provide current financial metrics (P/E, ROE, revenue growth, dividend yield, market cap, etc.).\n` +
    `Rank by relevance to the question. Cite specific data points in explanations.`
  );
}

function parseStockResults(raw: any): NalaStockResult[] {
  if (!raw?.stocks || !Array.isArray(raw.stocks)) return [];

  return raw.stocks
    .filter((s: any) => s?.ticker && s?.companyName)
    .slice(0, 8)
    .map((s: any): NalaStockResult => ({
      ticker: String(s.ticker).toUpperCase().trim(),
      companyName: String(s.companyName).slice(0, 100),
      sector: String(s.sector || 'Unknown').slice(0, 50),
      currentPrice: toNumberOrNull(s.currentPrice),
      metrics: {
        peRatio: toNumberOrNull(s.metrics?.peRatio),
        roe: toNumberOrNull(s.metrics?.roe),
        debtToEquity: toNumberOrNull(s.metrics?.debtToEquity),
        dividendYield: toNumberOrNull(s.metrics?.dividendYield),
        revenueGrowthYoY: toNumberOrNull(s.metrics?.revenueGrowthYoY),
        profitMargin: toNumberOrNull(s.metrics?.profitMargin),
        freeCashFlowYield: toNumberOrNull(s.metrics?.freeCashFlowYield),
        marketCapB: toNumberOrNull(s.metrics?.marketCapB),
        beta: toNumberOrNull(s.metrics?.beta),
        pegRatio: toNumberOrNull(s.metrics?.pegRatio),
      },
      confidenceScore: clamp(Number(s.confidenceScore) || 70, 60, 95),
      // Deterministic safety backstop over model-authored rationale — fail
      // closed (drop the sentence) if it slips a guarantee / buy-sell / leverage
      // / all-in past the prompt rules.
      explanation: enforceAiText(sanitizeContent(stripMarkdown(String(s.explanation || '')).slice(0, 500)), {
        feature: 'nala-explanation',
        fallback: 'Rationale withheld by the safety filter — review the metrics above and do your own research.',
      }).text,
      risks: enforceAiText(sanitizeContent(stripMarkdown(String(s.risks || '')).slice(0, 1000)), {
        feature: 'nala-risks',
        fallback: 'All investments carry risk of loss. Review the fundamentals and your own situation before acting.',
      }).text,
      localData: null,
    }));
}

async function buildFallbackNala(
  question: string,
  strategyInfo: NalaStrategyInfo | null,
  userId: string
): Promise<NalaResearchResponse> {
  const portfolio = await getPortfolio(userId);

  if (portfolio.holdings.length === 0) {
    return {
      question,
      strategy: strategyInfo,
      stocks: [],
      strategyExplanation: 'Basic mode is available once you add holdings.',
      citations: [],
      generatedAt: new Date().toISOString(),
      cached: false,
    };
  }

  const holdings = [...portfolio.holdings].sort((a, b) => b.currentValue - a.currentValue).slice(0, 8);
  const tickers = holdings.map(h => h.ticker);
  const cachedRows = await prisma.fundamentalsCache.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true, overviewJson: true },
  });

  const cacheMap = new Map<string, any>();
  for (const row of cachedRows) {
    if (row.overviewJson) {
      try { cacheMap.set(row.ticker, JSON.parse(row.overviewJson)); } catch {}
    }
  }

  let stocks: NalaStockResult[] = holdings.map(h => {
    const ov = cacheMap.get(h.ticker);
    const marketCapB = ov?.marketCap ? ov.marketCap / 1e9 : null;
    const price = h.currentPrice ?? h.averageCost ?? 0;
    const priceText = price > 0 ? '$' + price.toFixed(2) : 'unavailable';
    return {
      ticker: h.ticker,
      companyName: ov?.companyName ?? (h as any).companyName ?? h.ticker,
      sector: ov?.sector ?? 'Unknown',
      currentPrice: h.currentPrice ?? null,
      metrics: {
        peRatio: ov?.peRatio ?? null,
        roe: ov?.returnOnEquity ?? null,
        debtToEquity: ov?.debtToEquity ?? null,
        dividendYield: ov?.dividendYield != null ? ov.dividendYield * 100 : null,
        revenueGrowthYoY: ov?.revenueGrowthYoY ?? null,
        profitMargin: ov?.profitMargin != null ? ov.profitMargin * 100 : null,
        freeCashFlowYield: ov?.freeCashFlowYield ?? null,
        marketCapB,
        beta: ov?.beta ?? null,
        pegRatio: ov?.pegRatio ?? null,
      },
      confidenceScore: 65,
      explanation: 'Included from your portfolio in basic mode. Current price ' + priceText + '.',
      risks: 'Basic mode uses limited data. Verify metrics before acting.',
      localData: null,
    };
  });

  if (stocks.length > 0) {
    try {
      stocks = await enrichWithLocalData(stocks, userId);
    } catch {}
  }

  return {
    question,
    strategy: strategyInfo,
    stocks,
    strategyExplanation: 'Basic mode uses your current holdings and cached fundamentals.',
    citations: [],
    generatedAt: new Date().toISOString(),
    cached: false,
  };
}

async function enrichWithLocalData(stocks: NalaStockResult[], userId: string): Promise<NalaStockResult[]> {
  // Fast Prisma-only lookup â€” never triggers live Alpha Vantage fetches
  const tickers = stocks.map(s => s.ticker);
  const cachedRows = await prisma.fundamentalsCache.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true, overviewJson: true },
  });

  const cacheMap = new Map<string, any>();
  for (const row of cachedRows) {
    if (row.overviewJson) {
      try { cacheMap.set(row.ticker, JSON.parse(row.overviewJson)); } catch {}
    }
  }

  // Check actual user holdings to set isHeld correctly
  const heldTickers = new Set<string>();
  if (userId) {
    try {
      const holdings = await prisma.holding.findMany({
        where: { userId, ticker: { in: tickers } },
        select: { ticker: true },
      });
      for (const h of holdings) heldTickers.add(h.ticker);
    } catch {}
  }

  // Real prices (F-A-20): the model picks tickers and writes rationale, not authoritative
  // numbers. Fetch live quotes and override the displayed price below (best-effort; falls
  // back to whatever the model returned only when no real quote is available).
  const priceMap = new Map<string, number>();
  try {
    const { fetchPrices } = await import('./market.service');
    const { quotes } = await fetchPrices(tickers, { preferPolygon: true });
    for (const [tk, q] of quotes) {
      const px = (q as any)?.currentPrice;
      if (typeof px === 'number' && px > 0) priceMap.set(String(tk).toUpperCase(), px);
    }
  } catch { /* price fetch best-effort */ }

  return stocks.map((stock): NalaStockResult => {
    const ov = cacheMap.get(stock.ticker);
    const isHeld = heldTickers.has(stock.ticker);

    // Prefer REAL market data over the model's self-reported numbers (F-A-20): live price,
    // and the fundamentals we have cached locally. The model's figure is a last resort.
    const realPrice = priceMap.get(stock.ticker);
    const currentPrice = (typeof realPrice === 'number' && realPrice > 0) ? realPrice : stock.currentPrice;
    const metrics = ov ? {
      ...stock.metrics,
      peRatio: ov.peRatio ?? stock.metrics.peRatio,
      roe: ov.returnOnEquity ?? stock.metrics.roe,
      dividendYield: ov.dividendYield != null ? ov.dividendYield * 100 : stock.metrics.dividendYield,
      profitMargin: ov.profitMargin != null ? ov.profitMargin * 100 : stock.metrics.profitMargin,
      beta: ov.beta ?? stock.metrics.beta,
    } : stock.metrics;

    if (!ov && !isHeld) return { ...stock, currentPrice, metrics };

    return {
      ...stock,
      currentPrice,
      metrics,
      localData: {
        ticker: stock.ticker,
        isHeld,
        localMetrics: ov ? {
          peRatio: ov.peRatio ?? null,
          roe: ov.returnOnEquity ?? null,
          dividendYield: ov.dividendYield != null ? ov.dividendYield * 100 : null,
          profitMargin: ov.profitMargin != null ? ov.profitMargin * 100 : null,
          marketCap: ov.marketCap ?? null,
          beta: ov.beta ?? null,
        } : {
          peRatio: null, roe: null, dividendYield: null,
          profitMargin: null, marketCap: null, beta: null,
        },
        deviations: [],
      },
    };
  });
}

// â”€â”€ Main Function â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function askNala(question: string, userId: string): Promise<NalaResearchResponse> {
  const normalized = normalizeQuestion(question);
  const cacheKey = `nala-${userId}-${normalized}`;

  // Check cache
  const cached = nalaCache.get<NalaResearchResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  // Match persona
  const persona = matchPersona(question);

  const strategyInfo: NalaStrategyInfo | null = persona
    ? {
        id: persona.id,
        name: persona.name,
        description: persona.shortDescription,
        icon: persona.icon,
        riskLevel: persona.riskLevel,
      }
    : null;

  console.log(`[Nala AI] Question: "${question}" â†’ Persona: ${persona?.name || 'General Research'}`);

  try {
    const resp = await callAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(question, persona) },
    ], { timeout: 60000, feature: 'nala-research', userId });

    if (!resp || !resp.content) {
      console.warn('[Nala AI] Empty Perplexity response');
      return await buildFallbackNala(question, strategyInfo, userId);
    }

    const jsonStr = extractJson(resp.content);
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (_parseErr) {
      console.error('[Nala AI] JSON parse error', _parseErr instanceof Error ? _parseErr.message : String(_parseErr));
      return await buildFallbackNala(question, strategyInfo, userId);
    }

    // Parse and validate stocks
    let stocks = parseStockResults(parsed);

    // Enrich with local data (non-blocking, best-effort)
    if (stocks.length > 0) {
      try {
        stocks = await enrichWithLocalData(stocks, userId);
      } catch (_enrichErr) {
        console.warn('[Nala AI] Enrichment error (non-fatal)');
      }
    }

    const result: NalaResearchResponse = {
      question,
      strategy: strategyInfo,
      stocks,
      strategyExplanation: enforceAiText(
        sanitizeContent(stripMarkdown(String(parsed.strategyExplanation || '')).slice(0, 500)),
        { feature: 'nala-strategy', fallback: 'Strategy summary withheld by the safety filter. This is educational information, not advice.' },
      ).text,
      citations: (resp.citations || []).filter(validateCitationUrl),
      generatedAt: new Date().toISOString(),
      cached: false,
    };

    // Only cache non-empty results
    if (result.stocks.length > 0) {
      nalaCache.set(cacheKey, result);
    }

    console.log(`[Nala AI] Returned ${result.stocks.length} stocks, ${result.citations.length} citations`);
    return result;
  } catch (_error) {
    console.error('[Nala AI] Error', _error instanceof Error ? _error.message : String(_error));
    return await buildFallbackNala(question, strategyInfo, userId);
  }
}

