import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { getUserPortfolio } from '../services/user-portfolio.service';
import { createUserSnapshotIfNeeded, getUserChartSnapshots, reconstructPortfolioHistory, reconstructPortfolioHistoryHiRes, reconstructIntradayGap } from '../services/snapshot.service';
import { AuthRequest } from '../types/auth';

const prisma = new PrismaClient();

const VALID_CHART_PERIODS = ['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL'];

/**
 * GET /users
 * Returns only users with public profiles to prevent enumeration
 * Does NOT expose username (only displayName) to prevent login enumeration
 */
export async function getUsersHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      where: { profilePublic: true }, // Only show public profiles
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        displayName: true, // Exclude username to prevent enumeration
        createdAt: true,
      },
    });
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
}

export async function getUserPortfolioHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const viewerId = req.user?.userId; // Get viewer from auth context

    // First check if user exists and their privacy settings
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { profilePublic: true, holdingsVisibility: true },
    });

    if (!targetUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // IDOR Protection: If profile is private and viewer is not the owner, deny access
    const isOwner = viewerId === userId;
    if (!targetUser.profilePublic && !isOwner) {
      res.status(403).json({ error: 'This profile is private' });
      return;
    }

    const portfolio = await getUserPortfolio(userId);

    if (!portfolio) {
      res.status(404).json({ error: 'Portfolio not found' });
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
    if (!isOwner) {
      const vis = targetUser.holdingsVisibility ?? 'all';
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

// IDOR Protection: Only owner can update their holdings visibility
export async function updateHoldingsVisibilityHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const authUserId = req.user?.userId;

    // Verify ownership
    if (!authUserId || authUserId !== userId) {
      res.status(403).json({ error: 'Access denied. You can only update your own settings.' });
      return;
    }

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

export async function getUserChartHandler(req: AuthRequest, res: Response): Promise<void> {
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
      const now = Date.now();
      const liveValue = portfolio.totalAssets - portfolio.marginDebt;
      const previousCloseValue = liveValue - portfolio.dayChange;
      const holdings = await prisma.holding.findMany({ where: { userId } });

      // Reconstruct 1D from Yahoo 5-min intraday candles (same as main portfolio chart)
      let points = await reconstructPortfolioHistoryHiRes(
        holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
        portfolio.cashBalance, portfolio.marginDebt, '1d', '5m',
      );

      // If Yahoo returned insufficient data, fall back to snapshots
      if (points.length < 5) {
        const chartData = await getUserChartSnapshots(userId, period);
        if (chartData.points.length >= 2) {
          points = chartData.points;
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
