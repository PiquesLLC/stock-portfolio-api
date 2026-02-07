import { Request, Response } from 'express';
import {
  getHealthScore,
  getAttribution,
  getLeakDetector,
  getRiskForecast,
} from '../services/insights.service';
import { getIncomeInsights, IncomeWindow } from '../services/income-insights.service';
import { getPortfolioBriefing } from '../services/perplexity-briefing.service';
import { getBehaviorInsights } from '../services/perplexity-behavior.service';
import { getDailyReport } from '../services/perplexity-daily-report.service';

const VALID_WINDOWS = ['1d', '5d', '1m'] as const;
type AttributionWindow = typeof VALID_WINDOWS[number];

export async function getHealthHandler(req: Request, res: Response): Promise<void> {
  try {
    const healthScore = await getHealthScore();
    res.json(healthScore);
  } catch (error) {
    console.error('Error getting health score:', error);
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
  } catch (error) {
    console.error('Error getting attribution:', error);
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
  } catch (error) {
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

export async function getRiskForecastHandler(req: Request, res: Response): Promise<void> {
  try {
    const riskForecast = await getRiskForecast();
    res.json(riskForecast);
  } catch (error) {
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

export async function getIncomeInsightsHandler(req: Request, res: Response): Promise<void> {
  try {
    const windowParam = req.query.window as string | undefined;
    let window: IncomeWindow = 'today';

    if (windowParam && VALID_INCOME_WINDOWS.includes(windowParam as IncomeWindow)) {
      window = windowParam as IncomeWindow;
    }

    const incomeInsights = await getIncomeInsights(window);
    res.json(incomeInsights);
  } catch (error) {
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

export async function getBriefingHandler(req: Request, res: Response): Promise<void> {
  try {
    const briefing = await getPortfolioBriefing();
    res.json(briefing);
  } catch (error) {
    console.error('Error getting portfolio briefing:', error);
    res.status(500).json({
      error: 'Failed to generate briefing',
      generatedAt: new Date().toISOString(),
      headline: 'Briefing temporarily unavailable.',
      sections: [],
      holdingCount: 0,
      cached: false,
    });
  }
}

export async function getBehaviorHandler(req: Request, res: Response): Promise<void> {
  try {
    const behavior = await getBehaviorInsights();
    res.json(behavior);
  } catch (error) {
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

export async function getDailyReportHandler(req: Request, res: Response): Promise<void> {
  try {
    const report = await getDailyReport();
    res.json(report);
  } catch (error) {
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
