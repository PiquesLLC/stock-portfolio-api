import { Request, Response } from 'express';
import {
  getHealthScore,
  getAttribution,
  getLeakDetector,
  getRiskForecast,
} from '../services/insights.service';
import { getIncomeInsights, IncomeWindow } from '../services/income-insights.service';
import { getPortfolioBriefing, explainBriefingSection } from '../services/perplexity-briefing.service';
import { getBehaviorInsights } from '../services/perplexity-behavior.service';
import { getDailyReport, regenerateDailyReport } from '../services/perplexity-daily-report.service';
import { getEarningsSummary } from '../services/earnings-summary.service';
import { AuthRequest } from '../types/auth';
import { EmailVerificationRequiredError } from '../services/email-verification-guard.service';

const VALID_WINDOWS = ['1d', '5d', '1m'] as const;
type AttributionWindow = typeof VALID_WINDOWS[number];
const AI_PREMIUM_ENABLED = process.env.AI_PREMIUM_ENABLED === 'true';

function requirePremium(res: Response): boolean {
  if (AI_PREMIUM_ENABLED) return true;
  res.status(402).json({
    error: 'Premium feature',
    code: 'premium_required',
  });
  return false;
}

export async function getHealthHandler(req: Request, res: Response): Promise<void> {
  try {
    const healthScore = await getHealthScore();
    res.json(healthScore);
  } catch (_error) {
    console.error('Error getting health score:');
    res.status(500).json({
      error: 'Failed to calculate health score',
      partial: true,
    });
  }
}

export async function getAttributionHandler(req: Request, res: Response): Promise<void> {
  try {
    const windowParam = req.query.window as string | undefined;
    let window: AttributionWindow = '1d';

    if (windowParam && VALID_WINDOWS.includes(windowParam as AttributionWindow)) {
      window = windowParam as AttributionWindow;
    }

    const attribution = await getAttribution(window);
    res.json(attribution);
  } catch (_error) {
    console.error('Error getting attribution:');
    res.status(500).json({
      error: 'Failed to get attribution',
      partial: true,
    });
  }
}

export async function getLeakDetectorHandler(req: Request, res: Response): Promise<void> {
  try {
    const leaks = await getLeakDetector();
    res.json(leaks);
  } catch (_error) {
    console.error('Error getting leak detector:');
    res.status(500).json({
      error: 'Failed to analyze correlations',
      correlationClusters: [],
      summaries: ['Analysis temporarily unavailable'],
      heatmapData: null,
      partial: true,
    });
  }
}

export async function getRiskForecastHandler(req: Request, res: Response): Promise<void> {
  try {
    const riskForecast = await getRiskForecast();
    res.json(riskForecast);
  } catch (_error) {
    console.error('Error getting risk forecast:');
    res.status(500).json({
      error: 'Failed to calculate risk forecast',
      expectedAnnualVol: null,
      maxDrawdown1y: null,
      monteCarloBands: null,
      partial: true,
    });
  }
}

const VALID_INCOME_WINDOWS = ['today', '5d', '1m'] as const;

export async function getIncomeInsightsHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!requirePremium(res)) return;
    const windowParam = req.query.window as string | undefined;
    let window: IncomeWindow = 'today';

    if (windowParam && VALID_INCOME_WINDOWS.includes(windowParam as IncomeWindow)) {
      window = windowParam as IncomeWindow;
    }

    const incomeInsights = await getIncomeInsights(window);
    res.json(incomeInsights);
  } catch (_error) {
    console.error('Error getting income insights:');
    res.status(500).json({
      error: 'Failed to get income insights',
      healthScore: { overall: 0, breakdown: { stability: 0, growth: 0, coverage: 0, diversification: 0 }, grade: 'Poor' },
      keyDrivers: [],
      liveIntelligence: { window: 'today', statement: 'Data unavailable', amountInWindow: 0 },
      signals: {
        cashFlow: { annualIncome: 0, monthlyIncome: 0, dailyIncome: 0, projectedNextMonth: 0 },
        momentum: { yoyChangePct: null, holdingsRaisedPayout: [], trend: 'unknown' },
        reliability: { classification: 'stable', monthlyStdDev: null, consecutiveMonths: 0 },
      },
      contributors: [],
      concentration: { top1Percent: 0, top3Percent: 0, top1Ticker: null, top3Tickers: [], isConcentrated: false },
      timeline: [],
    });
  }
}

export async function getBriefingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requirePremium(res)) return;
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const briefing = await getPortfolioBriefing(req.user.userId);
    res.json(briefing);
  } catch (error) {
    if (error instanceof EmailVerificationRequiredError) {
      res.status(403).json({ error: 'email_verification_required', message: 'Verify your email to use AI features' });
      return;
    }
    console.error('Error getting portfolio briefing:');
    res.status(500).json({
      error: 'Failed to generate briefing',
      generatedAt: new Date().toISOString(),
      verdict: '',
      headline: 'Briefing temporarily unavailable.',
      sections: [],
      holdingCount: 0,
      cached: false,
    });
  }
}

export async function getBehaviorHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requirePremium(res)) return;
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const behavior = await getBehaviorInsights(req.user.userId);
    res.json(behavior);
  } catch (error) {
    if (error instanceof EmailVerificationRequiredError) {
      res.status(403).json({ error: 'email_verification_required', message: 'Verify your email to use AI features' });
      return;
    }
    console.error('Error getting behavior insights:');
    res.status(500).json({
      error: 'Failed to generate behavior insights',
      generatedAt: new Date().toISOString(),
      summary: 'Behavior insights temporarily unavailable.',
      insights: [],
      activityCount: 0,
      holdingCount: 0,
      cached: false,
    });
  }
}

export async function getDailyReportHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!requirePremium(res)) return;
    const report = await getDailyReport();
    res.json(report);
  } catch (_error) {
    console.error('Daily report error:');
    res.status(500).json({
      generatedAt: new Date().toISOString(),
      greeting: 'Good morning!',
      marketOverview: 'Unable to generate market overview at this time.',
      portfolioSummary: 'Unable to generate portfolio summary at this time.',
      topStories: [],
      watchToday: [],
      cached: false,
    });
  }
}

export async function getEarningsSummaryHandler(req: Request, res: Response): Promise<void> {
  try {
    const result = await getEarningsSummary();
    res.json(result);
  } catch (_error) {
    console.error('Earnings summary error:');
    res.status(500).json({
      results: [],
      partial: true,
    });
  }
}

export async function regenerateDailyReportHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!requirePremium(res)) return;
    const report = await regenerateDailyReport();
    res.json(report);
  } catch (_error) {
    console.error('Daily report regenerate error:');
    res.status(500).json({
      generatedAt: new Date().toISOString(),
      greeting: 'Good morning!',
      marketOverview: 'Unable to generate market overview at this time.',
      portfolioSummary: 'Unable to generate portfolio summary at this time.',
      topStories: [],
      watchToday: [],
      cached: false,
    });
  }
}

export async function explainBriefingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requirePremium(res)) return;
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const { title, body } = req.body;
    if (!title || !body) {
      res.status(400).json({ error: 'title and body are required' });
      return;
    }
    const result = await explainBriefingSection(title, body, req.user.userId);
    res.json(result);
  } catch (error) {
    if (error instanceof EmailVerificationRequiredError) {
      res.status(403).json({ error: 'email_verification_required', message: 'Verify your email to use AI features' });
      return;
    }
    console.error('[Briefing Explain] Error');
    res.status(500).json({ explanation: 'Unable to load explanation.', citations: [], cached: false });
  }
}
