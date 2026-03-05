import NodeCache from 'node-cache';
import { callPerplexity, extractJson } from '../utils/perplexity';
import { getPortfolio } from './portfolio.service';
import { getUserActivity } from './activity.service';
import { ensureEmailVerifiedForAi } from './email-verification-guard.service';

// Cache behavior insights for 12 hours (43200s) — portfolio composition doesn't change hourly
const behaviorCache = new NodeCache({ stdTTL: 43200 });


export interface BehaviorInsight {
  category: 'concentration' | 'timing' | 'sizing' | 'diversification' | 'general';
  title: string;
  observation: string;
  suggestion: string;
  severity: 'info' | 'warning' | 'positive';
}

export interface BehaviorInsightsResponse {
  generatedAt: string;
  summary: string;
  insights: BehaviorInsight[];
  activityCount: number;
  holdingCount: number;
  cached: boolean;
}

const SYSTEM_PROMPT = `You are a behavioral finance coach for a retail investor. Analyze their portfolio composition and activity history.
Return ONLY valid JSON:
{
  "summary": "One paragraph overall assessment of their investing behavior and portfolio health",
  "insights": [
    {
      "category": "concentration|timing|sizing|diversification|general",
      "title": "Short title (5-8 words)",
      "observation": "What you observe in their portfolio/behavior (1-2 sentences)",
      "suggestion": "Constructive, educational suggestion (1-2 sentences)",
      "severity": "info|warning|positive"
    }
  ]
}
Provide 4-6 insights. Be constructive, not judgmental. Use plain language.
Focus on: position sizing, concentration risk, sector diversification, cost-basis efficiency,
activity frequency (too much trading vs buy-and-hold), and unrealized gain/loss management.
For "positive" severity, highlight good habits. For "warning", flag potential risks. For "info", offer educational tips.`;

export async function getBehaviorInsights(userId: string): Promise<BehaviorInsightsResponse> {
  await ensureEmailVerifiedForAi(userId);
  const cacheKey = `behavior-insights:${userId}`;
  const cached = behaviorCache.get<BehaviorInsightsResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  const [portfolio, activity] = await Promise.all([
    getPortfolio(userId),
    getUserActivity(userId, 50),
  ]);

  if (portfolio.holdings.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      summary: 'Add holdings to your portfolio to receive behavior insights.',
      insights: [],
      activityCount: 0,
      holdingCount: 0,
      cached: false,
    };
  }

  // Build holdings summary with weights
  const holdingsSummary = portfolio.holdings
    .sort((a, b) => b.currentValue - a.currentValue)
    .map(h => {
      const weight = portfolio.holdingsValue > 0
        ? ((h.currentValue / portfolio.holdingsValue) * 100).toFixed(1)
        : '0';
      return `${h.ticker}: ${weight}% of portfolio, ${h.shares} shares at $${h.averageCost.toFixed(2)} avg cost, ` +
        `current $${h.currentPrice.toFixed(2)}, P/L ${h.profitLossPercent >= 0 ? '+' : ''}${h.profitLossPercent.toFixed(1)}%`;
    })
    .join('\n');

  // Build activity summary
  const activitySummary = activity.length > 0
    ? activity.slice(0, 30).map(a => {
        const dateStr = new Date(a.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        if (a.type === 'holding_added') return `${dateStr}: Added ${a.payload.ticker} (${a.payload.shares} shares at $${a.payload.averageCost?.toFixed(2)})`;
        if (a.type === 'holding_removed') return `${dateStr}: Removed ${a.payload.ticker}`;
        if (a.type === 'holding_updated') return `${dateStr}: Updated ${a.payload.ticker} (${a.payload.previousShares} → ${a.payload.shares} shares)`;
        return `${dateStr}: ${a.type} ${a.payload.ticker}`;
      }).join('\n')
    : 'No recent activity recorded.';

  const userMessage =
    `Portfolio (${portfolio.holdings.length} positions, net equity $${portfolio.netEquity.toFixed(0)}, ` +
    `cash $${portfolio.cashBalance.toFixed(0)}, margin debt $${portfolio.marginDebt.toFixed(0)}):\n\n` +
    `${holdingsSummary}\n\n` +
    `Recent Activity:\n${activitySummary}\n\n` +
    `Analyze my portfolio behavior and provide educational insights.`;

  const buildFallback = (): BehaviorInsightsResponse => {
    const totalValue = portfolio.holdingsValue;
    const top = [...portfolio.holdings].sort((a, b) => b.currentValue - a.currentValue)[0];
    const topWeight = top && totalValue > 0 ? (top.currentValue / totalValue) * 100 : 0;

    const insights: BehaviorInsight[] = [];
    if (top) {
      insights.push({
        category: 'concentration',
        title: 'Largest position weight',
        observation: `${top.ticker} is your largest holding at ${topWeight.toFixed(1)}% of the portfolio.`,
        suggestion: topWeight > 25 ? 'Consider whether this concentration matches your risk tolerance.' : 'Concentration appears reasonable.',
        severity: topWeight > 25 ? 'warning' : 'info',
      });
    }
    insights.push({
      category: 'diversification',
      title: 'Number of positions',
      observation: `You currently hold ${portfolio.holdings.length} positions.`,
      suggestion: portfolio.holdings.length < 5 ? 'Adding more positions can reduce single‑stock risk.' : 'Your position count supports diversification.',
      severity: portfolio.holdings.length < 5 ? 'warning' : 'positive',
    });
    insights.push({
      category: 'timing',
      title: 'Recent activity',
      observation: `You have ${activity.length} recent activity events.`,
      suggestion: activity.length > 20 ? 'High activity can increase timing risk. Ensure changes are intentional.' : 'Activity level looks manageable.',
      severity: activity.length > 20 ? 'info' : 'positive',
    });

    return {
      generatedAt: new Date().toISOString(),
      summary: 'Behavior insights generated in basic mode.',
      insights,
      activityCount: activity.length,
      holdingCount: portfolio.holdings.length,
      cached: false,
    };
  };

  try {
    const resp = await callPerplexity([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ], { timeout: 60000, feature: 'behavior-insights', userId });

    if (!resp || !resp.content) {
      return buildFallback();
    }

    const jsonStr = extractJson(resp.content);
    const parsed = JSON.parse(jsonStr);

    const validCategories = ['concentration', 'timing', 'sizing', 'diversification', 'general'];
    const validSeverities = ['info', 'warning', 'positive'];

    const result: BehaviorInsightsResponse = {
      generatedAt: new Date().toISOString(),
      summary: String(parsed.summary || '').slice(0, 500),
      insights: (parsed.insights || []).slice(0, 8).map((i: any) => ({
        category: validCategories.includes(i.category) ? i.category : 'general',
        title: String(i.title || '').slice(0, 100),
        observation: String(i.observation || '').slice(0, 300),
        suggestion: String(i.suggestion || '').slice(0, 300),
        severity: validSeverities.includes(i.severity) ? i.severity : 'info',
      })),
      activityCount: activity.length,
      holdingCount: portfolio.holdings.length,
      cached: false,
    };

    if (result.insights.length > 0) {
      behaviorCache.set(cacheKey, result);
    }
    console.log(`[Perplexity Behavior] Generated ${result.insights.length} insights for ${portfolio.holdings.length} holdings`);
    return result;
  } catch (_error) {
    console.error('[Perplexity Behavior] Error');
    return buildFallback();
  }
}
