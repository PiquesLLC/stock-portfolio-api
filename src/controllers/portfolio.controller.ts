import { Request, Response } from 'express';
import {
  getPortfolio,
  upsertHolding,
  deleteHolding,
  updateCashBalance,
  getHoldings,
} from '../services/portfolio.service';
import { getUserPortfolio } from '../services/user-portfolio.service';
import { createActivityEvent } from '../services/activity.service';
import { createSnapshotIfNeeded, createUserSnapshotIfNeeded, getAllSnapshots, reconstructPortfolioHistory, reconstructPortfolioHistoryHiRes } from '../services/snapshot.service';
import { addTransaction } from '../services/transaction.service';

import {
  getSP500Projections,
  getRealizedProjections,
  getMetrics,
  getPaceProjection,
  getCurrentPaceProjection,
} from '../services/projection.service';
import { LookbackPeriod, ProjectionMode, PaceWindow } from '../types';
import { getPerformanceComparison, PerformanceWindow } from '../services/benchmark.service';
import { AuthRequest } from '../types/auth';

const VALID_MODES: ProjectionMode[] = ['sp500', 'realized'];
const VALID_LOOKBACKS: LookbackPeriod[] = ['1d', '1w', '1m', '6m', '1y', 'max'];

export async function getPortfolioHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.query.userId as string | undefined;

    let portfolio;
    if (userId) {
      // User-specific portfolio
      portfolio = await getUserPortfolio(userId);
      if (!portfolio) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      // Create user snapshot in background
      createUserSnapshotIfNeeded(
        userId,
        portfolio.totalAssets,
        portfolio.cashBalance,
        portfolio.dayChange,
        portfolio.dayChangePercent,
        portfolio.totalPL,
        portfolio.totalPLPercent,
        portfolio.netEquity,
      ).catch(e => console.error('User snapshot error:', e));
    } else {
      // Legacy: default portfolio (will be deprecated)
      await createSnapshotIfNeeded();
      portfolio = await getPortfolio();
    }

    // Calculate pace projections (uses totalAssets - assets only, no margin)
    const paceProjection = await getPaceProjection(portfolio.netEquity);

    res.json({
      ...portfolio,
      paceProjection,
    });
  } catch (error) {
    console.error('Error fetching portfolio:', error);
    res.status(500).json({ error: 'Failed to fetch portfolio' });
  }
}

export async function addHolding(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { ticker, shares, averageCost, skipTransaction } = req.body;

    if (!ticker || typeof ticker !== 'string') {
      res.status(400).json({ error: 'Missing or invalid ticker' });
      return;
    }

    if (typeof shares !== 'number' || shares <= 0) {
      res.status(400).json({ error: 'Invalid shares: must be a positive number' });
      return;
    }

    if (typeof averageCost !== 'number' || averageCost <= 0) {
      res.status(400).json({ error: 'Invalid averageCost: must be a positive number' });
      return;
    }

    // Check if this is an update vs new add
    const existingHoldings = await getHoldings();
    const existingHolding = existingHoldings.find(h => h.ticker === ticker.toUpperCase());

    const holding = await upsertHolding({ ticker, shares, averageCost });

    // Auto-create transaction for TWR tracking (unless skipTransaction is set)
    // This ensures adding/removing stocks doesn't artificially inflate returns
    if (!skipTransaction) {
      const newCostBasis = shares * averageCost;
      const oldCostBasis = existingHolding ? existingHolding.shares * existingHolding.averageCost : 0;
      const costBasisDiff = newCostBasis - oldCostBasis;

      if (Math.abs(costBasisDiff) >= 0.01) {
        const transactionType = costBasisDiff > 0 ? 'deposit' : 'withdrawal';
        await addTransaction({
          type: transactionType,
          amount: Math.abs(costBasisDiff),
          date: new Date().toISOString(),
          userId: req.body.userId ?? undefined,
        });
        console.log(`[Holding] Auto-created ${transactionType} of $${Math.abs(costBasisDiff).toFixed(2)} for ${ticker.toUpperCase()} change`);
      }
    }

    // Fire activity event if a userId is provided
    const userId = req.body.userId as string | undefined;
    if (userId) {
      if (existingHolding) {
        createActivityEvent(userId, 'holding_updated', {
          ticker: ticker.toUpperCase(),
          shares,
          previousShares: existingHolding.shares,
          averageCost,
        }).catch(() => {});
      } else {
        createActivityEvent(userId, 'holding_added', {
          ticker: ticker.toUpperCase(),
          shares,
          averageCost,
        }).catch(() => {});
      }
    }

    res.status(201).json(holding);
  } catch (error) {
    console.error('Error adding holding:', error);
    res.status(500).json({ error: 'Failed to add holding' });
  }
}

export async function removeHolding(req: AuthRequest, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    const skipTransaction = req.query.skipTransaction === 'true';

    if (!ticker) {
      res.status(400).json({ error: 'Missing ticker parameter' });
      return;
    }

    // Get the holding before deletion to know the cost basis
    const existingHoldings = await getHoldings();
    const existingHolding = existingHoldings.find(h => h.ticker === ticker);
    const costBasis = existingHolding ? existingHolding.shares * existingHolding.averageCost : 0;

    await deleteHolding(ticker);

    // Auto-create withdrawal transaction for TWR tracking
    if (!skipTransaction && costBasis >= 0.01) {
      const userId = req.query.userId as string | undefined;
      await addTransaction({
        type: 'withdrawal',
        amount: costBasis,
        date: new Date().toISOString(),
        userId,
      });
      console.log(`[Holding] Auto-created withdrawal of $${costBasis.toFixed(2)} for removing ${ticker}`);
    }

    // Fire activity event if userId provided in query
    const userId = req.query.userId as string | undefined;
    if (userId) {
      createActivityEvent(userId, 'holding_removed', { ticker }).catch(() => {});
    }

    res.status(204).send();
  } catch (error: any) {
    if (error?.code === 'P2025') {
      res.status(404).json({ error: 'Holding not found' });
      return;
    }
    console.error('Error removing holding:', error);
    res.status(500).json({ error: 'Failed to remove holding' });
  }
}

export async function setCashBalance(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { cashBalance } = req.body;

    if (typeof cashBalance !== 'number' || cashBalance < 0) {
      res.status(400).json({ error: 'Invalid cashBalance: must be a non-negative number' });
      return;
    }

    const settings = await updateCashBalance(cashBalance);
    res.json({ cashBalance: settings.cashBalance });
  } catch (error) {
    console.error('Error updating cash balance:', error);
    res.status(500).json({ error: 'Failed to update cash balance' });
  }
}

export async function getHistory(req: Request, res: Response): Promise<void> {
  try {
    const snapshots = await getAllSnapshots();
    res.json(snapshots);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
}

export async function getProjectionsHandler(req: Request, res: Response): Promise<void> {
  try {
    const mode = (req.query.mode as ProjectionMode) || 'sp500';
    const lookback = (req.query.lookback as LookbackPeriod) || '1y';

    // Validate mode
    if (!VALID_MODES.includes(mode)) {
      res.status(400).json({
        error: `Invalid mode. Must be one of: ${VALID_MODES.join(', ')}`,
      });
      return;
    }

    // Validate lookback for realized mode
    if (mode === 'realized' && !VALID_LOOKBACKS.includes(lookback)) {
      res.status(400).json({
        error: `Invalid lookback. Must be one of: ${VALID_LOOKBACKS.join(', ')}`,
      });
      return;
    }

    let projections;
    if (mode === 'sp500') {
      projections = await getSP500Projections();
    } else {
      projections = await getRealizedProjections(lookback);
    }

    res.json(projections);
  } catch (error) {
    console.error('Error calculating projections:', error);
    res.status(500).json({ error: 'Failed to calculate projections' });
  }
}

export async function getMetricsHandler(req: Request, res: Response): Promise<void> {
  try {
    const lookback = (req.query.lookback as LookbackPeriod) || '1y';

    if (!VALID_LOOKBACKS.includes(lookback)) {
      res.status(400).json({
        error: `Invalid lookback. Must be one of: ${VALID_LOOKBACKS.join(', ')}`,
      });
      return;
    }

    const metrics = await getMetrics(lookback);
    res.json(metrics);
  } catch (error) {
    console.error('Error calculating metrics:', error);
    res.status(500).json({ error: 'Failed to calculate metrics' });
  }
}

const VALID_CHART_PERIODS = ['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL'];

// Import user chart handler for delegation
import { getUserChartHandler } from './users.controller';

export async function getChartHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.query.userId as string | undefined;
    const period = ((req.query.period as string) || '1D').toUpperCase();
    if (!VALID_CHART_PERIODS.includes(period)) {
      res.status(400).json({ error: `Invalid period. Must be one of: ${VALID_CHART_PERIODS.join(', ')}` });
      return;
    }

    // If userId provided, delegate to user chart handler
    if (userId) {
      req.params = { ...req.params, userId };
      return getUserChartHandler(req, res);
    }

    const portfolio = await getPortfolio();

    if (period === '1D') {
      const now = Date.now();
      const liveValue = portfolio.totalAssets - portfolio.marginDebt;
      const previousCloseValue = liveValue - portfolio.dayChange;
      const holdings = await getHoldings();

      // Reconstruct 1D from Yahoo 5-min intraday candles (current holdings only).
      // After hours, Yahoo range=1d still returns the last trading session's data.
      let points = await reconstructPortfolioHistoryHiRes(
        holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
        portfolio.cashBalance, portfolio.marginDebt, '1d', '5m',
      );

      // If Yahoo returned insufficient data, fall back to last 24h of snapshots
      if (points.length < 5) {
        const cutoff = new Date(now - 24 * 60 * 60 * 1000);
        const snapshots = await getAllSnapshots();
        const recentSnapshots = snapshots.filter(s => s.timestamp.getTime() >= cutoff.getTime());
        if (recentSnapshots.length >= 2) {
          points = recentSnapshots.map(s => ({
            time: s.timestamp.getTime(),
            value: s.netEquity ?? s.totalValue,
          }));
        }
      }

      // Append live value
      if (points.length === 0 || now - points[points.length - 1].time > 5000) {
        points.push({ time: now, value: liveValue });
      }

      const periodStartValue = previousCloseValue || (points.length > 0 ? points[0].value : liveValue);

      res.json({ points, periodStartValue, period: '1D' });
      return;
    }

    const holdings = await getHoldings();
    const now = Date.now();
    let points: { time: number; value: number }[];

    // Use high-resolution data for short periods (like Robinhood)
    if (period === '1W') {
      // 15-min candles for 5 days → ~130 points per ticker
      points = await reconstructPortfolioHistoryHiRes(
        holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
        portfolio.cashBalance, portfolio.marginDebt, '5d', '15m',
      );
    } else if (period === '1M') {
      // 1-hour candles for 1 month → ~150 points per ticker
      points = await reconstructPortfolioHistoryHiRes(
        holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
        portfolio.cashBalance, portfolio.marginDebt, '1mo', '1h',
      );
    } else if (period === 'YTD') {
      const ytdDays = Math.floor((now - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000);
      if (ytdDays <= 90) {
        // Under 90 days: use 1-hour candles for smooth chart like 1M
        // Yahoo only accepts specific range values: 1mo, 3mo, 6mo, etc.
        const yahooRange = ytdDays <= 30 ? '1mo' : '3mo';
        points = await reconstructPortfolioHistoryHiRes(
          holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
          portfolio.cashBalance, portfolio.marginDebt, yahooRange as any, '1h',
        );
        // Trim to only include data from Jan 1st of current year
        const ytdStart = new Date(new Date().getFullYear(), 0, 1).getTime();
        points = points.filter(p => p.time >= ytdStart);
      } else {
        // Over 90 days: daily candles are dense enough
        points = await reconstructPortfolioHistory(holdings, portfolio.cashBalance, ytdDays, portfolio.marginDebt);
      }
    } else {
      // 3M+ use daily candles (already enough density)
      const periodDaysMap: Record<string, number> = {
        '3M': 90,
        '1Y': 365, 'ALL': 365 * 5,
      };
      const periodDays = periodDaysMap[period] ?? 30;
      points = await reconstructPortfolioHistory(holdings, portfolio.cashBalance, periodDays, portfolio.marginDebt);
    }

    // Append current live value
    if (points.length === 0 || now - points[points.length - 1].time > 5000) {
      points.push({ time: now, value: portfolio.totalAssets - portfolio.marginDebt });
    }

    const periodStartValue = points.length > 0 ? points[0].value : portfolio.totalAssets;

    res.json({ points, periodStartValue, period });
  } catch (error) {
    console.error('Error fetching chart data:', error);
    res.status(500).json({ error: 'Failed to fetch chart data' });
  }
}

const VALID_PACE_WINDOWS: PaceWindow[] = ['1D', '1M', '6M', '1Y', 'YTD'];

export async function getCurrentPaceHandler(req: Request, res: Response): Promise<void> {
  try {
    const window = ((req.query.window as string) || '1M').toUpperCase() as PaceWindow;

    if (!VALID_PACE_WINDOWS.includes(window)) {
      res.status(400).json({
        error: `Invalid window. Must be one of: ${VALID_PACE_WINDOWS.join(', ')}`,
      });
      return;
    }

    const result = await getCurrentPaceProjection(window);
    res.json(result);
  } catch (error) {
    console.error('Error calculating current pace:', error);
    res.status(500).json({ error: 'Failed to calculate current pace' });
  }
}

const VALID_PERF_WINDOWS: PerformanceWindow[] = ['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL'];
const VALID_BENCHMARKS = ['SPY', 'QQQ', 'DIA'];

export async function getPerformanceHandler(req: Request, res: Response): Promise<void> {
  try {
    const window = ((req.query.window as string) || '1M').toUpperCase() as PerformanceWindow;
    const benchmark = ((req.query.benchmark as string) || 'SPY').toUpperCase();
    const userId = (req.query.userId as string) || undefined;

    if (!VALID_PERF_WINDOWS.includes(window)) {
      res.status(400).json({ error: `Invalid window. Must be one of: ${VALID_PERF_WINDOWS.join(', ')}` });
      return;
    }
    if (!VALID_BENCHMARKS.includes(benchmark)) {
      res.status(400).json({ error: `Invalid benchmark. Must be one of: ${VALID_BENCHMARKS.join(', ')}` });
      return;
    }

    const result = await getPerformanceComparison(window, benchmark, userId || null);
    res.json(result);
  } catch (error) {
    console.error('Error fetching performance:', error);
    res.status(500).json({ error: 'Failed to fetch performance data' });
  }
}
