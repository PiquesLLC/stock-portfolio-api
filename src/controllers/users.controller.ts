import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { getUserPortfolio } from '../services/user-portfolio.service';
import { createUserSnapshotIfNeeded, getUserChartSnapshots, reconstructPortfolioHistory, reconstructPortfolioHistoryHiRes, reconstructIntradayGap } from '../services/snapshot.service';

const prisma = new PrismaClient();

const VALID_CHART_PERIODS = ['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL'];

export async function getUsersHandler(req: Request, res: Response): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        username: true,
        displayName: true,
        createdAt: true,
      },
    });
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
}

export async function getUserPortfolioHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const viewerId = req.query.viewerId as string | undefined;
    const portfolio = await getUserPortfolio(userId);

    if (!portfolio) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Create user snapshot in background (non-blocking)
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

    // Apply holdings visibility filter for non-owner viewers
    if (viewerId && viewerId !== userId) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { holdingsVisibility: true } });
      const vis = user?.holdingsVisibility ?? 'all';
      if (vis === 'hidden') {
        portfolio.holdings = [];
      } else if (vis === 'top5') {
        portfolio.holdings = portfolio.holdings
          .sort((a, b) => b.currentValue - a.currentValue)
          .slice(0, 5);
      } else if (vis === 'sectors') {
        // Show only sector names, zero out individual holding details
        portfolio.holdings = portfolio.holdings.map(h => ({
          ...h,
          shares: 0,
          averageCost: 0,
          totalCost: 0,
          currentPrice: 0,
          previousClose: 0,
          pl: 0,
          plPercent: 0,
          dayChange: 0,
          dayChangePercent: 0,
        }));
      }
    }

    res.json(portfolio);
  } catch (error) {
    console.error('Error fetching user portfolio:', error);
    res.status(500).json({ error: 'Failed to fetch user portfolio' });
  }
}

export async function updateHoldingsVisibilityHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const { holdingsVisibility } = req.body;
    const valid = ['all', 'top5', 'sectors', 'hidden'];
    if (!valid.includes(holdingsVisibility)) {
      res.status(400).json({ error: `Invalid holdingsVisibility. Must be one of: ${valid.join(', ')}` });
      return;
    }
    await prisma.user.update({ where: { id: userId }, data: { holdingsVisibility } });
    res.json({ holdingsVisibility });
  } catch (error) {
    console.error('Error updating holdings visibility:', error);
    res.status(500).json({ error: 'Failed to update holdings visibility' });
  }
}

export async function getUserChartHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const period = ((req.query.period as string) || '1D').toUpperCase();

    if (!VALID_CHART_PERIODS.includes(period)) {
      res.status(400).json({ error: `Invalid period. Must be one of: ${VALID_CHART_PERIODS.join(', ')}` });
      return;
    }

    const portfolio = await getUserPortfolio(userId);
    if (!portfolio) {
      res.json({ points: [], periodStartValue: 0, period });
      return;
    }

    if (period === '1D') {
      const chartData = await getUserChartSnapshots(userId, period);
      const now = Date.now();

      // Detect gaps > 30 min and fill with intraday candle reconstruction
      const GAP_THRESHOLD_MS = 30 * 60 * 1000;
      const holdings = await prisma.holding.findMany({ where: { userId } });
      if (holdings.length > 0 && chartData.points.length >= 2) {
        const gaps: { startMs: number; endMs: number; insertAfterIdx: number }[] = [];
        for (let i = 0; i < chartData.points.length - 1; i++) {
          const dt = chartData.points[i + 1].time - chartData.points[i].time;
          if (dt > GAP_THRESHOLD_MS) {
            gaps.push({ startMs: chartData.points[i].time, endMs: chartData.points[i + 1].time, insertAfterIdx: i });
          }
        }
        if (chartData.points.length > 0) {
          const lastTime = chartData.points[chartData.points.length - 1].time;
          if (now - lastTime > GAP_THRESHOLD_MS) {
            gaps.push({ startMs: lastTime, endMs: now, insertAfterIdx: chartData.points.length - 1 });
          }
        }
        if (gaps.length > 0) {
          const fillResults = await Promise.all(
            gaps.map(g => reconstructIntradayGap(
              holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
              portfolio.cashBalance, portfolio.marginDebt, g.startMs, g.endMs,
            ))
          );
          for (let g = gaps.length - 1; g >= 0; g--) {
            if (fillResults[g].length > 0) {
              chartData.points.splice(gaps[g].insertAfterIdx + 1, 0, ...fillResults[g]);
            }
          }
        }
      }

      if (chartData.points.length === 0 || now - chartData.points[chartData.points.length - 1].time > 5000) {
        chartData.points.push({ time: now, value: portfolio.totalAssets - portfolio.marginDebt });
      }
      if (chartData.periodStartValue === 0 && chartData.points.length > 0) {
        chartData.periodStartValue = chartData.points[0].value;
      }
      res.json(chartData);
      return;
    }

    // For other periods: reconstruct from candle data
    const holdings = await prisma.holding.findMany({ where: { userId } });
    const now = Date.now();
    let points: { time: number; value: number }[];

    // Use high-resolution data for short periods (like main portfolio)
    if (period === '1W') {
      // 15-min candles for 5 days
      points = await reconstructPortfolioHistoryHiRes(
        holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
        portfolio.cashBalance, portfolio.marginDebt, '5d', '15m',
      );
    } else if (period === '1M') {
      // 1-hour candles for 1 month
      points = await reconstructPortfolioHistoryHiRes(
        holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
        portfolio.cashBalance, portfolio.marginDebt, '1mo', '1h',
      );
    } else if (period === 'YTD') {
      const ytdDays = Math.floor((now - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000);
      if (ytdDays <= 90) {
        const yahooRange = ytdDays <= 30 ? '1mo' : '3mo';
        points = await reconstructPortfolioHistoryHiRes(
          holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
          portfolio.cashBalance, portfolio.marginDebt, yahooRange as any, '1h',
        );
        const ytdStart = new Date(new Date().getFullYear(), 0, 1).getTime();
        points = points.filter(p => p.time >= ytdStart);
      } else {
        points = await reconstructPortfolioHistory(holdings, portfolio.cashBalance, ytdDays, portfolio.marginDebt);
      }
    } else {
      // 3M+ use daily candles
      const periodDaysMap: Record<string, number> = {
        '3M': 90, '1Y': 365, 'ALL': 365 * 5,
      };
      const periodDays = periodDaysMap[period] ?? 30;
      points = await reconstructPortfolioHistory(holdings, portfolio.cashBalance, periodDays, portfolio.marginDebt);
    }

    if (points.length === 0 || now - points[points.length - 1].time > 5000) {
      points.push({ time: now, value: portfolio.totalAssets - portfolio.marginDebt });
    }

    const periodStartValue = points.length > 0 ? points[0].value : portfolio.totalAssets;
    res.json({ points, periodStartValue, period });
  } catch (error) {
    console.error('Error fetching user chart:', error);
    res.status(500).json({ error: 'Failed to fetch user chart data' });
  }
}
