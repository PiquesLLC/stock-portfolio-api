import { Response } from 'express';
import prisma from '../utils/prisma';
import { getUserPortfolio } from '../services/user-portfolio.service';
import { createUserSnapshotIfNeeded, getUserChartSnapshots, getSnapshotChartPoints, reconstructPortfolioHistoryHiRes } from '../services/snapshot.service';
import { AuthRequest } from '../types/auth';
import { resolveAccessLevel } from '../services/creator.service';



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
  } catch (_error) {
    console.error('Error fetching users:');
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
      select: {
        profilePublic: true,
        holdingsVisibility: true,
        creator: {
          select: {
            status: true,
            visibility: {
              select: {
                showHoldings: true,
                tradeDelayHours: true,
                hideShareCount: true,
              },
            },
          },
        },
      },
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
    ).catch(() => console.error('User snapshot error'));

    // Apply holdings visibility filter for non-owner viewers
    if (!isOwner) {
      // Creator paywall filtering: server-side filtering only.
      if (targetUser.creator?.status === 'active' && targetUser.creator.visibility) {
        const accessLevel = await resolveAccessLevel(userId, viewerId);
        const visibility = targetUser.creator.visibility;
        if (accessLevel !== 'paid') {
          if (visibility.showHoldings) {
            // showHoldings=true means holdings are paywalled — clear them for non-paid viewers
            portfolio.holdings = [];
          } else {
            // Holdings are public but may have partial restrictions
            if (visibility.hideShareCount) {
              portfolio.holdings = portfolio.holdings.map(h => ({
                ...h,
                shares: 0,
              }));
            }
            if (visibility.tradeDelayHours > 0) {
              const cutoff = Date.now() - visibility.tradeDelayHours * 60 * 60 * 1000;
              portfolio.holdings = portfolio.holdings.filter(h => {
                const ts = new Date(h.createdAt).getTime();
                return Number.isFinite(ts) && ts <= cutoff;
              });
            }
          }
        }
      }

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
  } catch (_error) {
    console.error('Error fetching user portfolio:');
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
  } catch (_error) {
    console.error('Error updating holdings visibility:');
    res.status(500).json({ error: 'Failed to update holdings visibility' });
  }
}

export async function getUserChartHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const viewerId = req.user?.userId;
    const period = ((req.query.period as string) || '1D').toUpperCase();

    if (!VALID_CHART_PERIODS.includes(period)) {
      res.status(400).json({ error: `Invalid period. Must be one of: ${VALID_CHART_PERIODS.join(', ')}` });
      return;
    }

    // Privacy check: if viewer is not the owner, verify profile is public
    const isOwner = viewerId === userId;
    if (!isOwner) {
      const targetUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { profilePublic: true },
      });
      if (!targetUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      if (!targetUser.profilePublic) {
        res.status(403).json({ error: 'This profile is private' });
        return;
      }
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

      // Fix incomplete chart data: candle prices (from Polygon/Yahoo) may differ
      // from live quotes, and some tickers may lack candle data entirely.
      // Normalize all chart points so the last candle aligns with liveValue,
      // keeping the relative shape intact. This prevents the reference line
      // from sitting far above chart data and squishing the line to the bottom.
      if (points.length > 0 && liveValue > 0) {
        const lastCandleValue = points[points.length - 1].value;
        const offset = liveValue - lastCandleValue;
        if (Math.abs(offset) > 1) {
          for (const p of points) p.value += offset;
        }
      }

      // Append live value only if we're within the same session (gap < 4 hours).
      // On weekends/holidays, the Yahoo candles are the complete picture.
      const lastPtTime = points.length > 0 ? points[points.length - 1].time : 0;
      if (points.length === 0 || (now - lastPtTime > 5000 && now - lastPtTime < 4 * 3600000)) {
        points.push({ time: now, value: liveValue });
      }

      const periodStartValue = previousCloseValue || (points.length > 0 ? points[0].value : liveValue);

      res.json({ points, periodStartValue, period: '1D' });
      return;
    }

    // Non-1D periods: snapshot-only approach.
    // Use real recorded snapshot data — no reconstruction, no candle fetching.
    const now = Date.now();
    const periodDaysMap: Record<string, number> = {
      '1W': 7, '1M': 30, '3M': 90,
      'YTD': Math.floor((now - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000),
      '1Y': 365, 'ALL': 365 * 5,
    };
    const periodDays = periodDaysMap[period] ?? 30;
    let points = await getSnapshotChartPoints(userId, periodDays);

    // YTD baseline: if target user set a Jan 1 portfolio value, use it to anchor YTD returns
    let ytdBaselineValue: number | null = null;
    if (period === 'YTD') {
      const userSettings = await prisma.userSettings.findUnique({
        where: { userId },
        select: { ytdBaselineValue: true },
      });
      ytdBaselineValue = userSettings?.ytdBaselineValue ?? null;

      // getSnapshotChartPoints enforces >=2 points internally, so with only 1 snapshot
      // it returns []. For YTD baseline we only need 1 snapshot — fetch directly.
      if (points.length === 0 && ytdBaselineValue != null) {
        const since = new Date(now - periodDays * 86400000);
        const rawSnaps = await prisma.portfolioSnapshot.findMany({
          where: { userId, timestamp: { gte: since } },
          orderBy: { timestamp: 'asc' },
          select: { timestamp: true, totalValue: true, netEquity: true },
        });
        for (const s of rawSnaps) {
          const v = s.netEquity ?? s.totalValue;
          if (Number.isFinite(v) && v > 0) {
            points.push({ time: s.timestamp.getTime(), value: v });
          }
        }
      }
    }

    // Progressive unlock: each period requires minimum days of snapshot data.
    // YTD with baseline bypasses progressive unlock (minDays=0, minPoints=1).
    const minDaysRequired: Record<string, number> = {
      '1W': 2, '1M': 7, '3M': 30, 'YTD': 30, '1Y': 90, 'ALL': 90,
    };
    const spanMs = points.length >= 2 ? points[points.length - 1].time - points[0].time : 0;
    const spanDays = spanMs / 86400000;
    const minDays = (period === 'YTD' && ytdBaselineValue != null) ? 0 : (minDaysRequired[period] ?? 2);
    const minPoints = (period === 'YTD' && ytdBaselineValue != null) ? 1 : 2;

    if (points.length < minPoints || spanDays < minDays) {
      res.json({ points: [], insufficientData: true, period, periodStartValue: 0, source: 'snapshot' });
      return;
    }

    // Append current live value to connect last snapshot to now
    const liveVal = portfolio.totalAssets - portfolio.marginDebt;
    if (now - points[points.length - 1].time > 5000) {
      points.push({ time: now, value: liveVal });
    }

    // If YTD with baseline, prepend synthetic Jan 1 point and use baseline as periodStartValue
    let periodStartValue: number;
    if (period === 'YTD' && ytdBaselineValue != null) {
      const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime();
      if (points[0].time > jan1) {
        points = [{ time: jan1, value: ytdBaselineValue }, ...points];
      }
      periodStartValue = ytdBaselineValue;
    } else {
      periodStartValue = points[0].value;
    }

    res.json({ points, periodStartValue, period, source: 'snapshot' });
  } catch (_error) {
    console.error('Error fetching user chart:');
    res.status(500).json({ error: 'Failed to fetch user chart data' });
  }
}

