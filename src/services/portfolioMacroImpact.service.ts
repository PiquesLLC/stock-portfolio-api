/**
 * Portfolio Macro Impact Service
 *
 * Computes four rule-based insights connecting the user's portfolio
 * to current macro economic indicators. All data from existing caches
 * — zero external API calls per request.
 */

import { getPortfolio } from './portfolio.service';
import { getEconomicDashboard, getInternationalEconomicDashboard, EconomicDashboard, InternationalEconomicDashboard } from './economic.service';
import { computeSectorExposure, SectorExposureEntry } from './portfolioIntelligence.service';
import { HoldingWithQuote } from '../types';
import { insightsCache } from '../utils/finnhub';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MacroInsight {
  id: 'sector_sensitivity' | 'cross_border' | 'regime' | 'ticker_macro';
  icon: string;
  headline: string;
  detail: string;
  sentiment: 'healthy' | 'caution' | 'concern' | 'neutral';
}

export interface FedSentiment {
  score: number;       // -100 (very dovish) to +100 (very hawkish)
  label: string;       // e.g. "Moderately Hawkish"
  rationale: string;   // short explanation
}

export interface PortfolioMacroImpactResponse {
  insights: MacroInsight[];
  fedSentiment: FedSentiment | null;
  projectedQuarter: string; // e.g. "Q2 2026"
  generatedAt: string;
  dataAge: 'fresh' | 'cached' | 'stale';
}

const CACHE_KEY = 'macro-impact';
const CACHE_TTL = 14400; // 4 hours

// ─── Sector Rate Sensitivity Map ─────────────────────────────────────────────

const SECTOR_RATE_SENSITIVITY: Record<string, { direction: 'negative' | 'positive' | 'neutral'; label: string }> = {
  'Tech':          { direction: 'negative', label: 'sensitive to rate changes' },
  'Finance':       { direction: 'positive', label: 'benefits from higher rates' },
  'Healthcare':    { direction: 'neutral',  label: 'relatively defensive' },
  'Energy':        { direction: 'neutral',  label: 'driven by commodity cycles' },
  'Consumer':      { direction: 'neutral',  label: 'mixed rate sensitivity' },
  'Industrial':    { direction: 'neutral',  label: 'tied to economic growth' },
  'Communication': { direction: 'negative', label: 'growth-sensitive to rates' },
  'Materials':     { direction: 'neutral',  label: 'inflation-linked' },
  'Utilities':     { direction: 'negative', label: 'pressured by rate increases' },
  'Real Estate':   { direction: 'negative', label: 'sensitive to borrowing costs' },
  'ETF/Index':     { direction: 'neutral',  label: 'broad market exposure' },
  'Other':         { direction: 'neutral',  label: 'mixed sensitivity' },
};

// ─── International Ticker Mapping ────────────────────────────────────────────

const INTERNATIONAL_TICKERS: Record<string, string> = {
  // China
  'BABA': 'China', 'BIDU': 'China', 'JD': 'China', 'PDD': 'China',
  'NIO': 'China', 'XPEV': 'China', 'LI': 'China', 'BILI': 'China',
  'TME': 'China', 'TCEHY': 'China', 'KWEB': 'China', 'FXI': 'China',
  // Europe
  'ASML': 'Europe',
  // Taiwan
  'TSM': 'Taiwan',
  // International ETFs
  'VEA': 'Developed Intl', 'VWO': 'Emerging Markets', 'EEM': 'Emerging Markets',
  'EFA': 'Developed Intl', 'INDA': 'India', 'IEMG': 'Emerging Markets',
};

// ─── Ticker-Macro Heuristics ─────────────────────────────────────────────────

interface TickerHeuristic {
  indicator: 'treasuryYield10Y' | 'fedFundsRate' | 'gdpGrowth';
  direction: 'negative' | 'positive';
  threshold: number;
  label: string;
}

const TICKER_MACRO_HEURISTICS: Record<string, TickerHeuristic> = {
  // Tech — negative correlation with yields
  'AAPL':  { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.5, label: 'tends to dip when 10Y yield rises above 4.5%' },
  'MSFT':  { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.5, label: 'growth premium compresses with higher yields' },
  'GOOGL': { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.5, label: 'ad revenue outlook weakens with higher rates' },
  'GOOG':  { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.5, label: 'ad revenue outlook weakens with higher rates' },
  'META':  { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.5, label: 'growth valuations compress at higher yields' },
  'AMZN':  { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.5, label: 'consumer spending and growth discount sensitive to yields' },
  'NVDA':  { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.0, label: 'valuation-sensitive to rising yields' },
  'TSLA':  { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.0, label: 'auto financing costs rise with yields' },
  'NFLX':  { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.5, label: 'growth stock sensitive to rate expectations' },
  'CRM':   { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.5, label: 'SaaS valuations compress at higher yields' },
  'AMD':   { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.0, label: 'semiconductor growth names sensitive to yields' },
  'PLTR':  { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.0, label: 'high-growth valuations compressed by higher rates' },
  // Finance — positive correlation with rates
  'JPM':   { indicator: 'fedFundsRate', direction: 'positive', threshold: 3.0, label: 'net interest income rises with Fed rate' },
  'BAC':   { indicator: 'fedFundsRate', direction: 'positive', threshold: 3.0, label: 'benefits from wider lending spreads at higher rates' },
  'WFC':   { indicator: 'fedFundsRate', direction: 'positive', threshold: 3.0, label: 'lending margins expand with higher Fed rate' },
  'GS':    { indicator: 'fedFundsRate', direction: 'positive', threshold: 3.0, label: 'trading and banking revenue linked to rate environment' },
  'MS':    { indicator: 'fedFundsRate', direction: 'positive', threshold: 3.0, label: 'benefits from higher rate environment' },
  // Energy — linked to GDP
  'XOM':   { indicator: 'gdpGrowth', direction: 'positive', threshold: 0, label: 'energy demand tracks GDP growth' },
  'CVX':   { indicator: 'gdpGrowth', direction: 'positive', threshold: 0, label: 'oil demand tied to global economic growth' },
  // REITs — negative correlation with yields
  'O':     { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.0, label: 'REIT yields compete with Treasuries above 4%' },
  'AMT':   { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.0, label: 'tower REIT sensitive to higher borrowing costs' },
  'SPG':   { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.0, label: 'retail REIT dividends less attractive vs higher yields' },
  // Utilities
  'NEE':   { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.0, label: 'utility yields less competitive at higher rates' },
  'DUK':   { indicator: 'treasuryYield10Y', direction: 'negative', threshold: 4.0, label: 'rate-sensitive due to high capital costs' },
};

// ─── Insight 1: Sector Sensitivity ───────────────────────────────────────────

function buildSectorSensitivity(
  sectorExposure: SectorExposureEntry[],
  econ: EconomicDashboard,
): MacroInsight {
  const topSector = sectorExposure[0]; // already sorted by exposurePercent desc
  if (!topSector) {
    return {
      id: 'sector_sensitivity',
      icon: '\u{1F4CA}',
      headline: 'Add holdings to see sector sensitivity',
      detail: '',
      sentiment: 'neutral',
    };
  }

  const sensitivity = SECTOR_RATE_SENSITIVITY[topSector.sector] ?? SECTOR_RATE_SENSITIVITY['Other'];
  const pct = Math.round(topSector.exposurePercent);
  const quarter = getProjectedQuarter();
  const headline = `${pct}% ${topSector.sector} \u2014 ${sensitivity.label}`;

  const fedRate = econ.indicators.fedFundsRate?.latestValue;
  const yield10Y = econ.indicators.treasuryYield10Y?.latestValue;

  let detail = '';
  let sentiment: MacroInsight['sentiment'] = 'neutral';

  if (sensitivity.direction === 'negative' && (fedRate != null || yield10Y != null)) {
    const parts: string[] = [];
    if (fedRate != null) parts.push(`Fed Funds at ${fedRate}%`);
    if (yield10Y != null) parts.push(`10Y at ${yield10Y}%`);

    if ((yield10Y ?? 0) > 4.5 || (fedRate ?? 0) > 5) {
      detail = `Projected impact (${quarter}): ${parts.join(', ')} \u2014 growth valuations face headwinds`;
      sentiment = 'concern';
    } else if ((yield10Y ?? 0) > 3.5 || (fedRate ?? 0) > 4) {
      detail = `Projected impact (${quarter}): ${parts.join(', ')} \u2014 moderate pressure on growth names`;
      sentiment = 'caution';
    } else {
      detail = `Projected impact (${quarter}): ${parts.join(', ')} \u2014 favorable environment for growth`;
      sentiment = 'healthy';
    }
  } else if (sensitivity.direction === 'positive' && fedRate != null) {
    if (fedRate > 4) {
      detail = `Projected impact (${quarter}): Fed at ${fedRate}% \u2014 favorable for net interest margins`;
      sentiment = 'healthy';
    } else if (fedRate > 2) {
      detail = `Projected impact (${quarter}): Fed at ${fedRate}% \u2014 moderate rate environment`;
      sentiment = 'neutral';
    } else {
      detail = `Projected impact (${quarter}): Fed at ${fedRate}% \u2014 low rates compress lending margins`;
      sentiment = 'caution';
    }
  } else {
    detail = 'Macro conditions have mixed impact on this sector';
  }

  return { id: 'sector_sensitivity', icon: '\u{1F4CA}', headline, detail, sentiment };
}

// ─── Insight 2: Cross-Border Exposure ────────────────────────────────────────

function buildCrossBorderExposure(holdings: HoldingWithQuote[]): MacroInsight {
  const totalValue = holdings.reduce((sum, h) => sum + h.currentValue, 0);
  if (totalValue === 0) {
    return {
      id: 'cross_border',
      icon: '\u{1F310}',
      headline: 'Add holdings to see international exposure',
      detail: '',
      sentiment: 'neutral',
    };
  }

  const regionValues = new Map<string, { value: number; tickers: string[] }>();
  for (const h of holdings) {
    const region = INTERNATIONAL_TICKERS[h.ticker.toUpperCase()];
    if (!region) continue;
    const entry = regionValues.get(region) ?? { value: 0, tickers: [] };
    entry.value += h.currentValue;
    entry.tickers.push(h.ticker);
    regionValues.set(region, entry);
  }

  const intlValue = Array.from(regionValues.values()).reduce((sum, e) => sum + e.value, 0);
  const intlPct = Math.round((intlValue / totalValue) * 100);

  if (intlPct <= 5) {
    return {
      id: 'cross_border',
      icon: '\u{1F310}',
      headline: 'Primarily domestic \u2014 minimal currency risk',
      detail: intlPct > 0
        ? `${intlPct}% of portfolio in international names`
        : 'No international-listed holdings detected',
      sentiment: 'healthy',
    };
  }

  // Find dominant region
  let dominantRegion = '';
  let dominantValue = 0;
  for (const [region, entry] of regionValues) {
    if (entry.value > dominantValue) {
      dominantRegion = region;
      dominantValue = entry.value;
    }
  }

  const dominantEntry = regionValues.get(dominantRegion)!;
  const tickerList = dominantEntry.tickers.slice(0, 3).join(', ');
  const more = dominantEntry.tickers.length > 3 ? ` +${dominantEntry.tickers.length - 3} more` : '';

  return {
    id: 'cross_border',
    icon: '\u{1F310}',
    headline: `${intlPct}% international exposure, primarily ${dominantRegion}`,
    detail: `Currency fluctuations may impact ${tickerList}${more}`,
    sentiment: 'caution',
  };
}

// ─── Insight 3: Macro Regime Classification ──────────────────────────────────

function buildRegimeClassification(
  econ: EconomicDashboard,
  intl: InternationalEconomicDashboard,
): MacroInsight {
  const fedRate = econ.indicators.fedFundsRate?.latestValue;
  const yield10Y = econ.indicators.treasuryYield10Y?.latestValue;
  const gdpGrowth = intl.regions.us.indicators.gdpGrowth?.latestValue;
  const unemployment = econ.indicators.unemployment?.latestValue;

  if (fedRate == null && gdpGrowth == null) {
    return {
      id: 'regime',
      icon: '\u{1F6E1}\uFE0F',
      headline: 'Macro data loading \u2014 check back soon',
      detail: 'Economic indicators are being fetched',
      sentiment: 'neutral',
    };
  }

  let regime = '';
  let sentiment: MacroInsight['sentiment'] = 'neutral';
  const parts: string[] = [];
  if (fedRate != null) parts.push(`Fed at ${fedRate}%`);
  if (gdpGrowth != null) parts.push(`GDP growth ${gdpGrowth.toFixed(1)}%`);
  if (unemployment != null) parts.push(`unemployment ${unemployment}%`);

  if (fedRate != null && fedRate > 4 && gdpGrowth != null && gdpGrowth < 1.5) {
    regime = 'Rising rates + slowing growth = cautious';
    sentiment = 'concern';
  } else if (fedRate != null && fedRate > 4 && gdpGrowth != null && gdpGrowth >= 2) {
    regime = 'Tight money + strong economy = selective';
    sentiment = 'caution';
  } else if (fedRate != null && fedRate <= 2 && gdpGrowth != null && gdpGrowth > 2) {
    regime = 'Accommodative + growth = favorable';
    sentiment = 'healthy';
  } else if (fedRate != null && fedRate < 3 && gdpGrowth != null && gdpGrowth < 0) {
    regime = 'Easing into weakness = uncertain';
    sentiment = 'concern';
  } else if (gdpGrowth != null && gdpGrowth > 2 && (unemployment ?? 10) < 5) {
    regime = 'Solid growth + low unemployment = constructive';
    sentiment = 'healthy';
  } else if (gdpGrowth != null && gdpGrowth < 1) {
    regime = 'Sluggish growth = cautious';
    sentiment = 'caution';
  } else {
    regime = 'Stable macro conditions';
    sentiment = 'neutral';
  }

  return {
    id: 'regime',
    icon: '\u{1F6E1}\uFE0F',
    headline: `Macro environment: ${regime}`,
    detail: parts.join(', '),
    sentiment,
  };
}

// ─── Insight 4: Ticker-Macro Heuristic ───────────────────────────────────────

function buildTickerMacroCorrelation(
  holdings: HoldingWithQuote[],
  econ: EconomicDashboard,
  intl: InternationalEconomicDashboard,
): MacroInsight {
  const totalValue = holdings.reduce((sum, h) => sum + h.currentValue, 0);
  if (totalValue === 0) {
    return {
      id: 'ticker_macro',
      icon: '\u{1F517}',
      headline: 'Add holdings to see macro correlations',
      detail: '',
      sentiment: 'neutral',
    };
  }

  // Get indicator values
  const indicatorValues: Record<string, number | null> = {
    treasuryYield10Y: econ.indicators.treasuryYield10Y?.latestValue ?? null,
    fedFundsRate: econ.indicators.fedFundsRate?.latestValue ?? null,
    gdpGrowth: intl.regions.us.indicators.gdpGrowth?.latestValue ?? null,
  };

  // Sort holdings by portfolio weight (largest first)
  const sorted = [...holdings].sort((a, b) => b.currentValue - a.currentValue);

  // Find the largest holding with an active threshold breach
  for (const h of sorted) {
    const heuristic = TICKER_MACRO_HEURISTICS[h.ticker.toUpperCase()];
    if (!heuristic) continue;

    const indicatorValue = indicatorValues[heuristic.indicator];
    if (indicatorValue == null) continue;

    const breached = heuristic.direction === 'negative'
      ? indicatorValue > heuristic.threshold
      : indicatorValue < heuristic.threshold;

    if (!breached) continue;

    const weightPct = Math.round((h.currentValue / totalValue) * 100);
    const indicatorLabel = heuristic.indicator === 'treasuryYield10Y' ? '10Y Treasury'
      : heuristic.indicator === 'fedFundsRate' ? 'Fed Funds Rate'
      : 'GDP Growth';

    return {
      id: 'ticker_macro',
      icon: '\u{1F517}',
      headline: `${h.ticker} ${heuristic.label}`,
      detail: `${indicatorLabel} is at ${indicatorValue}%. ${h.ticker} is ${weightPct}% of your portfolio.`,
      sentiment: heuristic.direction === 'negative' ? 'caution' : 'healthy',
    };
  }

  return {
    id: 'ticker_macro',
    icon: '\u{1F517}',
    headline: 'No strong macro-ticker signals detected',
    detail: 'Your holdings are within normal macro sensitivity ranges',
    sentiment: 'neutral',
  };
}

// ─── Fed Sentiment Gauge ─────────────────────────────────────────────────────

function computeFedSentiment(econ: EconomicDashboard, intl: InternationalEconomicDashboard): FedSentiment | null {
  const fedRate = econ.indicators.fedFundsRate;
  const cpi = econ.indicators.cpi;
  const unemployment = econ.indicators.unemployment;
  const gdpGrowth = intl.regions.us.indicators.gdpGrowth;

  if (!fedRate?.latestValue) return null;

  let score = 0; // -100 to +100
  const factors: string[] = [];

  // Factor 1: Current rate level (higher = more hawkish)
  if (fedRate.latestValue > 5) { score += 30; factors.push('rates elevated'); }
  else if (fedRate.latestValue > 4) { score += 15; factors.push('rates moderately high'); }
  else if (fedRate.latestValue > 2.5) { score += 0; }
  else if (fedRate.latestValue > 1) { score -= 15; factors.push('rates low'); }
  else { score -= 30; factors.push('near-zero rates'); }

  // Factor 2: Rate direction (rising = hawkish)
  if (fedRate.change != null) {
    if (fedRate.change > 0) { score += 25; factors.push('rates rising'); }
    else if (fedRate.change < 0) { score -= 25; factors.push('rates falling'); }
    else { factors.push('rates on hold'); }
  }

  // Factor 3: Inflation pressure (high CPI = hawkish pressure)
  if (cpi?.changePercent != null) {
    if (cpi.changePercent > 4) { score += 25; factors.push('inflation hot'); }
    else if (cpi.changePercent > 2.5) { score += 10; factors.push('inflation elevated'); }
    else if (cpi.changePercent < 1.5) { score -= 15; factors.push('inflation cooling'); }
  }

  // Factor 4: Employment (tight labor = hawkish)
  if (unemployment?.latestValue != null) {
    if (unemployment.latestValue < 4) { score += 10; }
    else if (unemployment.latestValue > 6) { score -= 10; }
  }

  // Factor 5: GDP growth (weak growth = dovish pressure)
  if (gdpGrowth?.latestValue != null) {
    if (gdpGrowth.latestValue < 0) { score -= 20; factors.push('GDP contracting'); }
    else if (gdpGrowth.latestValue < 1) { score -= 10; }
  }

  // Clamp to [-100, 100]
  score = Math.max(-100, Math.min(100, score));

  // Classify
  let label: string;
  if (score >= 50) label = 'Very Hawkish';
  else if (score >= 20) label = 'Moderately Hawkish';
  else if (score > -20) label = 'Neutral';
  else if (score > -50) label = 'Moderately Dovish';
  else label = 'Very Dovish';

  return {
    score,
    label,
    rationale: factors.slice(0, 3).join(', ') || 'balanced conditions',
  };
}

// ─── Projected Quarter Helper ────────────────────────────────────────────────

function getProjectedQuarter(): string {
  const now = new Date();
  // Project to next quarter
  const month = now.getMonth(); // 0-indexed
  const year = now.getFullYear();
  const currentQ = Math.floor(month / 3) + 1;
  const nextQ = currentQ >= 4 ? 1 : currentQ + 1;
  const nextYear = currentQ >= 4 ? year + 1 : year;
  return `Q${nextQ} ${nextYear}`;
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export async function getPortfolioMacroImpact(): Promise<PortfolioMacroImpactResponse> {
  const cached = insightsCache.get<PortfolioMacroImpactResponse>(CACHE_KEY);
  if (cached) return cached;

  try {
    const [portfolio, econ, intl] = await Promise.all([
      getPortfolio(),
      getEconomicDashboard(),
      getInternationalEconomicDashboard(),
    ]);

    const holdings = portfolio.holdings;

    const projectedQuarter = getProjectedQuarter();
    const fedSentiment = computeFedSentiment(econ, intl);

    if (holdings.length === 0) {
      return {
        insights: [],
        fedSentiment,
        projectedQuarter,
        generatedAt: new Date().toISOString(),
        dataAge: econ.dataAge,
      };
    }

    const sectorExposure = computeSectorExposure(holdings);

    const insights: MacroInsight[] = [
      buildSectorSensitivity(sectorExposure, econ),
      buildCrossBorderExposure(holdings),
      buildRegimeClassification(econ, intl),
      buildTickerMacroCorrelation(holdings, econ, intl),
    ];

    const result: PortfolioMacroImpactResponse = {
      insights,
      fedSentiment,
      projectedQuarter,
      generatedAt: new Date().toISOString(),
      dataAge: econ.dataAge,
    };

    insightsCache.set(CACHE_KEY, result, CACHE_TTL);
    return result;
  } catch (err) {
    console.error('[MacroImpact] Error computing portfolio macro impact:', (err as Error).message);
    return {
      insights: [],
      fedSentiment: null,
      projectedQuarter: getProjectedQuarter(),
      generatedAt: new Date().toISOString(),
      dataAge: 'stale',
    };
  }
}
