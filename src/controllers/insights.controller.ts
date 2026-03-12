import { Response } from 'express';
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

export async function getHealthHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const portfolioId = req.query.portfolioId as string | undefined;
    const healthScore = await getHealthScore(req.user!.userId, portfolioId);
    res.json(healthScore);
  } catch (error: unknown) {
    console.error('Error getting health score:', error);
    res.status(500).json({
      error: 'Failed to calculate health score',
      partial: true,
    });
  }
}

export async function getAttributionHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const portfolioId = req.query.portfolioId as string | undefined;
    const windowParam = req.query.window as string | undefined;
    let window: AttributionWindow = '1d';

    if (windowParam && VALID_WINDOWS.includes(windowParam as AttributionWindow)) {
      window = windowParam as AttributionWindow;
    }

    const attribution = await getAttribution(req.user!.userId, window, portfolioId);
    res.json(attribution);
  } catch (error: unknown) {
    console.error('Error getting attribution:', error);
    res.status(500).json({
      error: 'Failed to get attribution',
      partial: true,
    });
  }
}

export async function getLeakDetectorHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const portfolioId = req.query.portfolioId as string | undefined;
    const leaks = await getLeakDetector(req.user!.userId, portfolioId);
    res.json(leaks);
  } catch (error: unknown) {
    console.error('Error getting leak detector:', error);
    res.status(500).json({
      error: 'Failed to analyze correlations',
      correlationClusters: [],
      summaries: ['Analysis temporarily unavailable'],
      heatmapData: null,
      partial: true,
    });
  }
}

export async function getRiskForecastHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const portfolioId = req.query.portfolioId as string | undefined;
    const riskForecast = await getRiskForecast(req.user!.userId, portfolioId);
    res.json(riskForecast);
  } catch (error: unknown) {
    console.error('Error getting risk forecast:', error);
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

export async function getIncomeInsightsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requirePremium(res)) return;
    const portfolioId = req.query.portfolioId as string | undefined;
    const windowParam = req.query.window as string | undefined;
    let window: IncomeWindow = 'today';

    if (windowParam && VALID_INCOME_WINDOWS.includes(windowParam as IncomeWindow)) {
      window = windowParam as IncomeWindow;
    }

    const incomeInsights = await getIncomeInsights(req.user!.userId, window, portfolioId);
    res.json(incomeInsights);
  } catch (error: unknown) {
    console.error('Error getting income insights:', error);
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
    const portfolioId = req.query.portfolioId as string | undefined;
    const briefing = await getPortfolioBriefing(req.user.userId, portfolioId);
    res.json(briefing);
  } catch (error) {
    if (error instanceof EmailVerificationRequiredError) {
      res.status(403).json({ error: 'email_verification_required', message: 'Verify your email to use AI features' });
      return;
    }
    console.error('Error getting portfolio briefing:', error);
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
    const portfolioId = req.query.portfolioId as string | undefined;
    const behavior = await getBehaviorInsights(req.user.userId, portfolioId);
    res.json(behavior);
  } catch (error) {
    if (error instanceof EmailVerificationRequiredError) {
      res.status(403).json({ error: 'email_verification_required', message: 'Verify your email to use AI features' });
      return;
    }
    console.error('Error getting behavior insights:', error);
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

export async function getDailyReportHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requirePremium(res)) return;
    const portfolioId = req.query.portfolioId as string | undefined;
    const report = await getDailyReport(req.user!.userId, portfolioId);
    res.json(report);
  } catch (error) {
    if (error instanceof EmailVerificationRequiredError) {
      res.status(403).json({ error: 'email_verification_required', message: 'Verify your email to use AI features' });
      return;
    }
    console.error('Daily report error:', error);
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

export async function getEarningsSummaryHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const portfolioId = req.query.portfolioId as string | undefined;
    const result = await getEarningsSummary(req.user!.userId, portfolioId);
    res.json(result);
  } catch (error: unknown) {
    console.error('Earnings summary error:', error);
    res.status(500).json({
      results: [],
      partial: true,
    });
  }
}

export async function regenerateDailyReportHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requirePremium(res)) return;
    const portfolioId = req.query.portfolioId as string | undefined;
    const report = await regenerateDailyReport(req.user!.userId, portfolioId);
    res.json(report);
  } catch (error) {
    if (error instanceof EmailVerificationRequiredError) {
      res.status(403).json({ error: 'email_verification_required', message: 'Verify your email to use AI features' });
      return;
    }
    console.error('Daily report regenerate error:', error);
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
    if (!title || typeof title !== 'string' || !body || typeof body !== 'string') {
      res.status(400).json({ error: 'title and body are required strings' });
      return;
    }
    if (title.length > 100) {
      res.status(400).json({ error: 'title must be 100 characters or fewer' });
      return;
    }
    if (body.length > 1000) {
      res.status(400).json({ error: 'body must be 1000 characters or fewer' });
      return;
    }
    const result = await explainBriefingSection(title.slice(0, 100), body.slice(0, 1000), req.user.userId);
    res.json(result);
  } catch (error) {
    if (error instanceof EmailVerificationRequiredError) {
      res.status(403).json({ error: 'email_verification_required', message: 'Verify your email to use AI features' });
      return;
    }
    console.error('[Briefing Explain] Error:', error);
    res.status(500).json({ explanation: 'Unable to load explanation.', citations: [], cached: false });
  }
}
