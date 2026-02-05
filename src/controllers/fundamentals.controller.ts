import { Request, Response } from 'express';
import { getEconomicDashboard, getInternationalEconomicDashboard } from '../services/economic.service';
import { getPortfolioMacroImpact } from '../services/portfolioMacroImpact.service';
import { getCompanyFundamentals } from '../services/fundamentals.service';
import { getEarningsData } from '../services/earnings.service';
import { getDailyStats } from '../utils/alpha-vantage';

// GET /fundamentals/economic
export async function getEconomicDashboardHandler(req: Request, res: Response): Promise<void> {
  try {
    const dashboard = await getEconomicDashboard();
    res.json(dashboard);
  } catch (error) {
    console.error('Error fetching economic dashboard:', error);
    res.status(500).json({ error: 'Failed to fetch economic indicators' });
  }
}

// GET /fundamentals/economic/international
export async function getInternationalEconomicHandler(req: Request, res: Response): Promise<void> {
  try {
    const dashboard = await getInternationalEconomicDashboard();
    res.json(dashboard);
  } catch (error) {
    console.error('Error fetching international economic dashboard:', error);
    res.status(500).json({ error: 'Failed to fetch international economic indicators' });
  }
}

// GET /fundamentals/status
export async function getAVStatusHandler(req: Request, res: Response): Promise<void> {
  try {
    const stats = await getDailyStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching AV status:', error);
    res.status(500).json({ error: 'Failed to fetch Alpha Vantage status' });
  }
}

// GET /fundamentals/economic/portfolio-impact
export async function getPortfolioMacroImpactHandler(req: Request, res: Response): Promise<void> {
  try {
    const impact = await getPortfolioMacroImpact();
    res.json(impact);
  } catch (error) {
    console.error('Error computing portfolio macro impact:', error);
    res.status(500).json({ error: 'Failed to compute macro impact insights' });
  }
}

// GET /fundamentals/:ticker
export async function getFundamentalsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { ticker } = req.params;
    if (!ticker) {
      res.status(400).json({ error: 'Ticker is required' });
      return;
    }
    const data = await getCompanyFundamentals(ticker);
    res.json(data);
  } catch (error) {
    console.error('Error fetching fundamentals:', error);
    res.status(500).json({ error: 'Failed to fetch company fundamentals' });
  }
}

// GET /fundamentals/:ticker/earnings
export async function getEarningsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { ticker } = req.params;
    if (!ticker) {
      res.status(400).json({ error: 'Ticker is required' });
      return;
    }
    const data = await getEarningsData(ticker);
    res.json(data);
  } catch (error) {
    console.error('Error fetching earnings:', error);
    res.status(500).json({ error: 'Failed to fetch earnings data' });
  }
}
