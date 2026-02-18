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
  } catch (_error) {
    console.error('Error fetching economic dashboard:');
    res.status(500).json({ error: 'Failed to fetch economic indicators' });
  }
}

// GET /fundamentals/economic/international
export async function getInternationalEconomicHandler(req: Request, res: Response): Promise<void> {
  try {
    const dashboard = await getInternationalEconomicDashboard();
    res.json(dashboard);
  } catch (_error) {
    console.error('Error fetching international economic dashboard:');
    res.status(500).json({ error: 'Failed to fetch international economic indicators' });
  }
}

// GET /fundamentals/status
export async function getAVStatusHandler(req: Request, res: Response): Promise<void> {
  try {
    const stats = await getDailyStats();
    res.json(stats);
  } catch (_error) {
    console.error('Error fetching AV status:');
    res.status(500).json({ error: 'Failed to fetch Alpha Vantage status' });
  }
}

// GET /fundamentals/economic/portfolio-impact
export async function getPortfolioMacroImpactHandler(req: Request, res: Response): Promise<void> {
  try {
    const impact = await getPortfolioMacroImpact();
    res.json(impact);
  } catch (_error) {
    console.error('Error computing portfolio macro impact:');
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
  } catch (_error) {
    console.error('Error fetching fundamentals:');
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
  } catch (_error) {
    console.error('Error fetching earnings:');
    res.status(500).json({ error: 'Failed to fetch earnings data' });
  }
}

// POST /fundamentals/earnings/batch
export async function getEarningsBatchHandler(req: Request, res: Response): Promise<void> {
  try {
    const tickers = Array.isArray(req.body?.tickers) ? req.body.tickers : [];

    if (tickers.length === 0) {
      res.status(400).json({ error: 'tickers must be a non-empty array' });
      return;
    }

    if (tickers.length > 25) {
      res.status(400).json({ error: 'tickers array too large (max 25)' });
      return;
    }

    const uniqueTickers: string[] = Array.from(
      new Set(
        tickers
          .filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0)
          .map((t: string) => t.trim().toUpperCase())
      )
    );

    if (uniqueTickers.length === 0) {
      res.status(400).json({ error: 'tickers must contain at least one valid symbol' });
      return;
    }

    const results = await Promise.allSettled(
      uniqueTickers.map(async (ticker) => {
        const data = await getEarningsData(ticker);
        return { ticker, data };
      })
    );

    const payload = results.map((result, index) => {
      const ticker = uniqueTickers[index];
      if (result.status === 'fulfilled') {
        return { ...result.value.data, ticker };
      }
      return { ticker, error: 'Failed to fetch earnings data' };
    });

    const partial = results.some(r => r.status === 'rejected');
    res.json({ results: payload, partial });
  } catch (_error) {
    console.error('Error fetching earnings batch:');
    res.status(500).json({ error: 'Failed to fetch earnings batch' });
  }
}
