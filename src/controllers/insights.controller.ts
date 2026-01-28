import { Request, Response } from 'express';
import {
  getHealthScore,
  getAttribution,
  getLeakDetector,
  getRiskForecast,
} from '../services/insights.service';

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
