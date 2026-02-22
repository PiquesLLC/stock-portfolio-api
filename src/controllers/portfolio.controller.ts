import { Request, Response } from 'express';
import {
  getPortfolio,
  upsertHolding,
  deleteHolding,
  updateCashBalance,
  getHoldings,
} from '../services/portfolio.service';
import { getUserPortfolio } from '../services/user-portfolio.service';
import { createActivityEvent, getUserActivityByTicker } from '../services/activity.service';
import { createSnapshotIfNeeded, createUserSnapshotIfNeeded, getAllSnapshots, getSnapshotsAfter, reconstructPortfolioHistory, reconstructPortfolioHistoryHiRes, reconstructPortfolioHistoryFromTrades, resetSnapshotsForCompositionChange, recordCompositionChange, getLatestCompositionChangeAfter } from '../services/snapshot.service';
import { extractBestOcrForHoldings, parseHoldingsFromText } from '../services/screenshot-ocr.service';
import { addTransaction } from '../services/transaction.service';
import { setBaseline } from '../services/settings.service';

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
import prisma from '../utils/prisma';
import { parse as parseCsv } from 'csv-parse/sync';
import {
  addHoldingSchema,
  removeHoldingParamsSchema,
  removeHoldingQuerySchema,
  setCashBalanceSchema,
} from '../validators/portfolio.validators';
import { PlanLimitError } from '../utils/plan-limit.error';
import { normalizeSourceBroker } from '../services/ledger/settlement-policy';
import { parseNumber } from '../utils/parse-number';

const VALID_MODES: ProjectionMode[] = ['sp500', 'realized'];
const VALID_LOOKBACKS: LookbackPeriod[] = ['1d', '1w', '1m', '6m', '1y', 'max'];
const FREE_CHART_PERIODS = new Set(['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL']);

export async function getPortfolioHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    // Only use userId if explicitly passed as query param (e.g., leaderboard/social profile views).
    // The main portfolio always uses the system/default user's data.
    const userId = req.query.userId as string | undefined;

    let portfolio;
    if (userId) {
      // User-specific portfolio (public profile/leaderboard views only)
      // Privacy check: if viewer is not the owner, verify profile is public
      const viewerId = req.user?.userId;
      if (viewerId !== userId) {
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
      ).catch(() => console.error('User snapshot error'));
    } else {
      // Default portfolio â€” the main portfolio data (all users see this)
      await createSnapshotIfNeeded(req.user!.userId);
      portfolio = await getPortfolio(req.user!.userId);
    }

    // Calculate pace projections (uses totalAssets - assets only, no margin)
    const paceProjection = await getPaceProjection(req.user!.userId, portfolio.netEquity);

    res.json({
      ...portfolio,
      paceProjection,
    });
  } catch (_error) {
    console.error('Error fetching portfolio:');
    res.status(500).json({ error: 'Failed to fetch portfolio' });
  }
}

export async function addHolding(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsed = addHoldingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { ticker, shares, averageCost, skipTransaction } = parsed.data;

    // Check if this is an update vs new add
    // Always use system/default portfolio â€” auth is for access control only
    const existingHoldings = await getHoldings(req.user!.userId);
    const existingHolding = existingHoldings.find(h => h.ticker === ticker.toUpperCase());

    const holding = await upsertHolding({ ticker, shares, averageCost }, req.user!.userId);
    try {
      await recordCompositionChange(req.user!.userId, 'holding_update');
      await resetSnapshotsForCompositionChange(req.user!.userId);
    } catch (_err) {
      console.warn('[Snapshot] Reset failed after holding update:');
    }

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
          userId: req.user!.userId,
        });
      }
    }

    // Fire activity event using authenticated user ID
    const authUserId = req.user?.userId;
    if (authUserId) {
      if (existingHolding) {
        createActivityEvent(authUserId, 'holding_updated', {
          ticker: ticker.toUpperCase(),
          shares,
          previousShares: existingHolding.shares,
          averageCost,
        }).catch(() => {});
      } else {
        createActivityEvent(authUserId, 'holding_added', {
          ticker: ticker.toUpperCase(),
          shares,
          averageCost,
        }).catch(() => {});
      }
    }

    res.status(201).json(holding);
  } catch (error) {
    if (error instanceof PlanLimitError) {
      res.status(403).json({ error: 'limit_reached', limit: error.limit, plan: error.plan });
      return;
    }
    console.error('Error adding holding:');
    res.status(500).json({ error: 'Failed to add holding' });
  }
}

export async function removeHolding(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsedParams = removeHoldingParamsSchema.safeParse(req.params);
    const parsedQuery = removeHoldingQuerySchema.safeParse(req.query);
    if (!parsedParams.success || !parsedQuery.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const ticker = parsedParams.data.ticker.toUpperCase();
    const skipTransaction = parsedQuery.data.skipTransaction === 'true';

    // Get the holding before deletion to know the cost basis
    // Always use system/default portfolio â€” auth is for access control only
    const existingHoldings = await getHoldings(req.user!.userId);
    const existingHolding = existingHoldings.find(h => h.ticker === ticker);
    const costBasis = existingHolding ? existingHolding.shares * existingHolding.averageCost : 0;

    await deleteHolding(ticker, req.user!.userId);
    try {
      await recordCompositionChange(req.user!.userId, 'holding_remove');
      await resetSnapshotsForCompositionChange(req.user!.userId);
    } catch (_err) {
      console.warn('[Snapshot] Reset failed after holding removal:');
    }

    // Auto-create withdrawal transaction for TWR tracking
    if (!skipTransaction && costBasis >= 0.01) {
      await addTransaction({
        type: 'withdrawal',
        amount: costBasis,
        date: new Date().toISOString(),
        userId: req.user!.userId,
      });
      console.log(`[Holding] Auto-created withdrawal for removing ${ticker}`);
    }

    // Fire activity event using authenticated user ID
    const authUserId = req.user?.userId;
    if (authUserId) {
      createActivityEvent(authUserId, 'holding_removed', { ticker }).catch(() => {});
    }

    res.status(204).send();
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'P2025') {
      res.status(404).json({ error: 'Holding not found' });
      return;
    }
    console.error('Error removing holding:');
    res.status(500).json({ error: 'Failed to remove holding' });
  }
}

export async function setCashBalance(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsed = setCashBalanceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { cashBalance } = parsed.data;

    // Update user-specific cash if authenticated
    const authUserId = req.user?.userId;
    if (authUserId) {
      await prisma.userSettings.upsert({
        where: { userId: authUserId },
        update: { cashBalance },
        create: { userId: authUserId, cashBalance, marginDebt: 0 },
      });
    }

    const settings = await updateCashBalance(req.user!.userId, cashBalance);
    res.json({ cashBalance: settings.cashBalance });
  } catch (_error) {
    console.error('Error updating cash balance:');
    res.status(500).json({ error: 'Failed to update cash balance' });
  }
}

export async function getHistory(req: AuthRequest, res: Response): Promise<void> {
  try {
    const snapshots = await getAllSnapshots(req.user!.userId);
    res.json(snapshots);
  } catch (_error) {
    console.error('Error fetching history:');
    res.status(500).json({ error: 'Failed to fetch history' });
  }
}

export async function getProjectionsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
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
      projections = await getSP500Projections(userId);
    } else {
      projections = await getRealizedProjections(userId, lookback);
    }

    res.json(projections);
  } catch (_error) {
    console.error('Error calculating projections:');
    res.status(500).json({ error: 'Failed to calculate projections' });
  }
}

export async function getMetricsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const lookback = (req.query.lookback as LookbackPeriod) || '1y';

    if (!VALID_LOOKBACKS.includes(lookback)) {
      res.status(400).json({
        error: `Invalid lookback. Must be one of: ${VALID_LOOKBACKS.join(', ')}`,
      });
      return;
    }

    const metrics = await getMetrics(userId, lookback);
    res.json(metrics);
  } catch (_error) {
    console.error('Error calculating metrics:');
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

    const plan = req.user?.plan ?? 'free';
    const isProOrHigher = plan === 'pro' || plan === 'premium';
    if (!isProOrHigher && !FREE_CHART_PERIODS.has(period)) {
      res.status(403).json({ error: 'upgrade_required', requiredPlan: 'pro' });
      return;
    }

    // If userId provided, delegate to user chart handler (public profile/leaderboard only)
    if (userId) {
      req.params = { ...req.params, userId };
      return getUserChartHandler(req, res);
    }

    const portfolio = await getPortfolio(req.user!.userId);

    if (period === '1D') {
      const now = Date.now();
      const liveValue = portfolio.totalAssets - portfolio.marginDebt;
      const previousCloseValue = liveValue - portfolio.dayChange;
      const holdings = await getHoldings(req.user!.userId);

      // Reconstruct 1D from Yahoo 5-min intraday candles (current holdings only).
      // After hours, Yahoo range=1d still returns the last trading session's data.
      let points = await reconstructPortfolioHistoryHiRes(
        holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
        portfolio.cashBalance, portfolio.marginDebt, '1d', '5m',
      );

      // If Yahoo returned insufficient data, fall back to last 24h of snapshots
      if (points.length < 5) {
        const cutoff = new Date(now - 24 * 60 * 60 * 1000);
        const snapshots = await getAllSnapshots(req.user!.userId);
        const recentSnapshots = snapshots.filter(s => s.timestamp.getTime() >= cutoff.getTime());
        if (recentSnapshots.length >= 2) {
          points = recentSnapshots.map(s => ({
            time: s.timestamp.getTime(),
            value: s.netEquity ?? s.totalValue,
          }));
        }
      }

      // Normalize candle-based chart points to match live portfolio value.
      // Candle prices (Polygon/Yahoo) can differ from live quotes (Finnhub),
      // and some tickers may lack candle data entirely. Adding a constant offset
      // keeps the chart shape intact while aligning with the actual portfolio value.
      if (points.length > 0 && liveValue > 0) {
        const lastCandleVal = points[points.length - 1].value;
        const offset = liveValue - lastCandleVal;
        if (Math.abs(offset) > 1) {
          for (const p of points) p.value += offset;
        }
      }

      // Fill the gap between last Yahoo candle (~15min delayed) and now
      // using recent snapshots recorded every 60 seconds.
      // Cap at 4 hours to avoid bridging across overnight/weekend/holiday gaps —
      // Yahoo candles already contain the complete last trading session.
      if (points.length > 0) {
        const lastCandleTime = points[points.length - 1].time;
        const gapMs = now - lastCandleTime;
        if (gapMs > 5 * 60 * 1000 && gapMs < 4 * 3600000) {
          const snapshots = await getSnapshotsAfter(req.user!.userId, new Date(lastCandleTime));
          for (const s of snapshots) {
            const t = s.timestamp.getTime();
            if (t > lastCandleTime && t < now - 5000) {
              points.push({ time: t, value: s.netEquity ?? s.totalValue });
            }
          }
        }
      }

      // Append live value only if we're within the same session (gap < 4 hours).
      // On weekends/holidays, the Yahoo candles are the complete picture.
      const lastPointTime = points.length > 0 ? points[points.length - 1].time : 0;
      if (points.length === 0 || (now - lastPointTime > 5000 && now - lastPointTime < 4 * 3600000)) {
        points.push({ time: now, value: liveValue });
      }

      // If composition changed within the last day, rebaseline to avoid false jumps.
      // But don't filter if it would leave the chart empty (e.g. fresh import on weekend).
      const rangeStart = new Date(now - 24 * 60 * 60 * 1000);
      const latestChange = await getLatestCompositionChangeAfter(req.user!.userId, rangeStart);
      if (latestChange) {
        const cutoff = latestChange.getTime();
        const filtered = points.filter(p => p.time >= cutoff);
        if (filtered.length >= 2) {
          points = filtered;
        }
      }

      const periodStartValue = latestChange
        ? (points.length > 0 ? points[0].value : liveValue)
        : (previousCloseValue || (points.length > 0 ? points[0].value : liveValue));

      res.json({ points, periodStartValue, period: '1D' });
      return;
    }

    const holdings = await getHoldings(req.user!.userId);
    const now = Date.now();
    let points: { time: number; value: number }[];

    // Check if user has trade history (from Robinhood CSV import).
    // If so, use trade-aware reconstruction for accurate historical charts.
    const tradeCount = await prisma.portfolioTrade.count({ where: { userId: req.user!.userId } });
    const hasTrades = tradeCount > 0;
    let tradeHistory: { date: Date; ticker: string; type: string; shares: number; price: number }[] = [];
    if (hasTrades) {
      tradeHistory = await prisma.portfolioTrade.findMany({
        where: { userId: req.user!.userId },
        orderBy: [{ date: 'asc' }, { rowIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: { date: true, ticker: true, type: true, shares: true, price: true },
      });
      console.log(`[Chart] ${period} for user ${req.user!.userId} — using ${tradeHistory.length} trades for accurate reconstruction`);
    }

    // For 1W: always use current-holdings reconstruction (hi-res intraday candles).
    // Trade-aware hi-res has data coverage issues. 1W composition change is minimal.
    if (period === '1W') {
      points = await reconstructPortfolioHistoryHiRes(
        holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
        portfolio.cashBalance, portfolio.marginDebt, '5d', '15m',
      );
    } else if (period === '1M') {
      // 1M: trade-aware with full cash reconstruction (deposits minimal over 1 month)
      if (hasTrades) {
        points = await reconstructPortfolioHistoryFromTrades(tradeHistory, portfolio.cashBalance, 30, portfolio.marginDebt, 1.0);
      } else {
        points = await reconstructPortfolioHistoryHiRes(
          holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
          portfolio.cashBalance, portfolio.marginDebt, '1mo', '1h',
        );
      }
    } else if (period === 'YTD') {
      // YTD/3M+: trade-aware with partial cash reconstruction (0.7 weight).
      // 0.7 accounts for ~30% of net purchases coming from external deposits
      // that aren't in the trade history, avoiding inflated starting values.
      const ytdDays = Math.floor((now - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000);
      if (hasTrades) {
        points = await reconstructPortfolioHistoryFromTrades(tradeHistory, portfolio.cashBalance, ytdDays, portfolio.marginDebt, 0.7);
      } else {
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
      }
    } else {
      // 3M/1Y/ALL: trade-aware with partial cash reconstruction
      const periodDaysMap: Record<string, number> = {
        '3M': 90,
        '1Y': 365, 'ALL': 365 * 5,
      };
      const periodDays = periodDaysMap[period] ?? 30;
      if (hasTrades) {
        points = await reconstructPortfolioHistoryFromTrades(tradeHistory, portfolio.cashBalance, periodDays, portfolio.marginDebt, 0.7);
      } else {
        points = await reconstructPortfolioHistory(holdings, portfolio.cashBalance, periodDays, portfolio.marginDebt);
      }
    }

    // Normalize chart points to match live portfolio value.
    // Use median of last 5 points as scaling anchor (more robust than single last point).
    // Clamp scale to [0.97, 1.03] to prevent extreme adjustments from bad data.
    const liveVal = portfolio.totalAssets - portfolio.marginDebt;
    if (points.length > 0 && liveVal > 0) {
      const anchorWindow = points.slice(-Math.min(5, points.length));
      const sortedAnchor = anchorWindow.map(p => p.value).sort((a, b) => a - b);
      const anchorVal = sortedAnchor[Math.floor(sortedAnchor.length / 2)]; // median
      if (anchorVal > 0 && Math.abs(liveVal - anchorVal) > 1) {
        const rawScale = liveVal / anchorVal;
        const scale = Math.max(0.97, Math.min(1.03, rawScale));
        if (Math.abs(rawScale - scale) > 0.001) {
          console.warn(`[Chart] ${period} scale clamped: raw=${rawScale.toFixed(4)} → ${scale.toFixed(4)} (liveVal=${liveVal.toFixed(0)}, anchor=${anchorVal.toFixed(0)})`);
        } else {
          console.log(`[Chart] ${period} normalization: liveVal=${liveVal.toFixed(0)}, anchor=${anchorVal.toFixed(0)}, scale=${scale.toFixed(4)}`);
        }
        for (const p of points) p.value *= scale;
      }
    }

    // Append current live value
    if (points.length === 0 || now - points[points.length - 1].time > 5000) {
      points.push({ time: now, value: liveVal });
    }

    // Rebaseline to latest composition change within the window to avoid false jumps.
    // Skip for trade-aware periods (1M/YTD/3M/1Y/ALL) — trades already account for composition changes.
    // 1W always uses current-holdings, so it still needs this filter.
    const usedTradeReconstruction = hasTrades && period !== '1W';
    if (!usedTradeReconstruction && points.length > 0) {
      const windowStart = new Date(points[0].time);
      const latestChange = await getLatestCompositionChangeAfter(req.user!.userId, windowStart);
      if (latestChange) {
        const cutoff = latestChange.getTime();
        const filtered = points.filter(p => p.time >= cutoff);
        if (filtered.length >= 2) {
          points = filtered;
        }
      }
    }

    const periodStartValue = points.length > 0 ? points[0].value : portfolio.totalAssets;

    res.json({ points, periodStartValue, period });
  } catch (chartError) {
    console.error('Error fetching chart data:', chartError instanceof Error ? chartError.stack : String(chartError));
    res.status(500).json({ error: 'Failed to fetch chart data' });
  }
}

const VALID_PACE_WINDOWS: PaceWindow[] = ['1D', '1M', '6M', '1Y', 'YTD'];

export async function getCurrentPaceHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const window = ((req.query.window as string) || '1M').toUpperCase() as PaceWindow;

    if (!VALID_PACE_WINDOWS.includes(window)) {
      res.status(400).json({
        error: `Invalid window. Must be one of: ${VALID_PACE_WINDOWS.join(', ')}`,
      });
      return;
    }

    const result = await getCurrentPaceProjection(userId, window);
    res.json(result);
  } catch (_error) {
    console.error('Error calculating current pace:');
    res.status(500).json({ error: 'Failed to calculate current pace' });
  }
}

const VALID_PERF_WINDOWS: PerformanceWindow[] = ['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL'];
const VALID_BENCHMARKS = ['SPY', 'QQQ', 'DIA'];

export async function getPerformanceHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const window = ((req.query.window as string) || '1M').toUpperCase() as PerformanceWindow;
    const benchmark = ((req.query.benchmark as string) || 'SPY').toUpperCase();
    // Optional userId for public profile/leaderboard comparisons only.
    const userId = (req.query.userId as string) || undefined;

    if (!VALID_PERF_WINDOWS.includes(window)) {
      res.status(400).json({ error: `Invalid window. Must be one of: ${VALID_PERF_WINDOWS.join(', ')}` });
      return;
    }
    if (!VALID_BENCHMARKS.includes(benchmark)) {
      res.status(400).json({ error: `Invalid benchmark. Must be one of: ${VALID_BENCHMARKS.join(', ')}` });
      return;
    }

    // Privacy check: if userId provided and viewer is not the owner, verify profile is public
    if (userId) {
      const viewerId = req.user?.userId;
      if (viewerId !== userId) {
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
    }

    const result = await getPerformanceComparison(window, benchmark, userId || req.user!.userId);
    res.json(result);
  } catch (_error) {
    console.error('Error fetching performance:');
    res.status(500).json({ error: 'Failed to fetch performance data' });
  }
}

export async function getTickerActivity(req: AuthRequest, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    if (!ticker) {
      res.status(400).json({ error: 'Missing ticker parameter' });
      return;
    }
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const events = await getUserActivityByTicker(userId, ticker);
    res.json(events);
  } catch (_error) {
    console.error('Error fetching ticker activity:');
    res.status(500).json({ error: 'Failed to fetch ticker activity' });
  }
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Detect and parse Robinhood transaction history CSV.
 * Replays Buy/Sell transactions to compute current positions with weighted avg cost.
 */
function parseRobinhoodTransactionCsv(
  data: Record<string, unknown>[]
): { parsed: { rowNumber: number; ticker: string; shares: number; averageCost: number; confidence: 'high' | 'medium' | 'low' }[]; warnings: { rowNumber: number; message: string }[]; trades: { date: string; ticker: string; type: string; shares: number; price: number; rowIndex: number; sourceBroker: string; rawAction: string }[] } | null {
  const headers = Object.keys(data[0] || {}).map(h => h.toLowerCase().trim());
  const isRobinhood = headers.includes('activity date') && headers.includes('trans code') && headers.includes('instrument');
  if (!isRobinhood) return null;

  const positions = new Map<string, { shares: number; totalCost: number }>();
  const warnings: { rowNumber: number; message: string }[] = [];
  const trades: { date: string; ticker: string; type: string; shares: number; price: number; rowIndex: number; sourceBroker: string; rawAction: string }[] = [];
  let tradeRowIndex = 0;

  // Codes that don't affect share counts — skip silently
  const ignoreCodes = new Set(['CDIV', 'GOLD', 'ACH', 'GDBP', 'INT', 'MINT', 'MDIV', 'DTAX', 'DFEE', 'AFEE', 'SLIP', 'MISC', 'FUTSWP']);
  // Options codes — contracts, not stock shares
  const optionsCodes = new Set(['BTO', 'STC', 'STO', 'OEXP']);

  // Robinhood exports newest-first — reverse to process chronologically
  const chronological = [...data].reverse();

  chronological.forEach((row, index) => {
    const originalRowNum = data.length - index;
    const ticker = String(row['Instrument'] || '').trim().toUpperCase();
    if (!ticker || !isValidTicker(ticker)) return;

    const transCode = String(row['Trans Code'] || '').trim();
    if (ignoreCodes.has(transCode) || optionsCodes.has(transCode)) return;

    const dateStr = String(row['Activity Date'] || '').trim();
    const qtyRaw = String(row['Quantity'] || '').replace(/[$,]/g, '').trim();
    const qtyClean = qtyRaw.replace(/S$/i, '');
    const priceRaw = String(row['Price'] || '').replace(/[$,()]/g, '').trim();
    const qty = parseFloat(qtyClean);
    const price = parseFloat(priceRaw);

    const pos = positions.get(ticker) || { shares: 0, totalCost: 0 };

    if (transCode === 'Buy') {
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
        warnings.push({ rowNumber: originalRowNum, message: `Skipped ${ticker} Buy — invalid qty/price` });
        return;
      }
      pos.totalCost += qty * price;
      pos.shares += qty;
      trades.push({ date: dateStr, ticker, type: 'buy', shares: qty, price, rowIndex: tradeRowIndex++, sourceBroker: 'robinhood', rawAction: transCode });
    } else if (transCode === 'Sell') {
      if (!Number.isFinite(qty) || qty <= 0) {
        warnings.push({ rowNumber: originalRowNum, message: `Skipped ${ticker} Sell — invalid qty` });
        return;
      }
      if (pos.shares <= 0) {
        warnings.push({ rowNumber: originalRowNum, message: `${ticker} sell without open position` });
      } else {
        const avgBefore = pos.totalCost / pos.shares;
        pos.shares -= qty;
        if (pos.shares <= 0.001) {
          pos.shares = 0;
          pos.totalCost = 0;
        } else {
          pos.totalCost = pos.shares * avgBefore;
        }
        trades.push({ date: dateStr, ticker, type: 'sell', shares: qty, price: Number.isFinite(price) ? price : 0, rowIndex: tradeRowIndex++, sourceBroker: 'robinhood', rawAction: transCode });
      }
    } else if (transCode === 'SPL') {
      // Stock split: adds shares, total cost unchanged (avg cost decreases)
      if (Number.isFinite(qty) && qty > 0 && pos.shares > 0) {
        pos.shares += qty;
        trades.push({ date: dateStr, ticker, type: 'split', shares: qty, price: 0, rowIndex: tradeRowIndex++, sourceBroker: 'robinhood', rawAction: transCode });
      }
    } else if (transCode === 'ACATI' || transCode === 'REC' || transCode === 'T/A') {
      // Transfer in / Receive / Transfer-adjustment: add shares
      if (Number.isFinite(qty) && qty > 0) {
        const p = Number.isFinite(price) && price > 0 ? price : 0;
        pos.totalCost += qty * p;
        pos.shares += qty;
        trades.push({ date: dateStr, ticker, type: 'transfer', shares: qty, price: p, rowIndex: tradeRowIndex++, sourceBroker: 'robinhood', rawAction: transCode });
      }
    } else if (transCode === 'SXCH' || transCode === 'MRGS') {
      // Symbol exchange or Merger: 'S' suffix = shares removed (old symbol), plain = shares added (new symbol)
      if (qtyRaw.endsWith('S')) {
        pos.shares = 0;
        pos.totalCost = 0;
        trades.push({ date: dateStr, ticker, type: 'sell', shares: Number.isFinite(qty) ? qty : 0, price: 0, rowIndex: tradeRowIndex++, sourceBroker: 'robinhood', rawAction: transCode });
      } else if (Number.isFinite(qty) && qty > 0) {
        const p = Number.isFinite(price) && price > 0 ? price : 0;
        pos.totalCost += qty * p;
        pos.shares += qty;
        trades.push({ date: dateStr, ticker, type: 'merger', shares: qty, price: p, rowIndex: tradeRowIndex++, sourceBroker: 'robinhood', rawAction: transCode });
      }
    } else if (transCode === 'BCXL') {
      // Buy cancel: reverse a buy
      if (Number.isFinite(qty) && qty > 0 && pos.shares > 0) {
        const avgBefore = pos.totalCost / pos.shares;
        pos.shares -= qty;
        if (pos.shares <= 0.001) {
          pos.shares = 0;
          pos.totalCost = 0;
        } else {
          pos.totalCost = pos.shares * avgBefore;
        }
        trades.push({ date: dateStr, ticker, type: 'cancel', shares: qty, price: Number.isFinite(price) ? price : 0, rowIndex: tradeRowIndex++, sourceBroker: 'robinhood', rawAction: transCode });
      }
    }

    positions.set(ticker, pos);
  });

  const parsed: { rowNumber: number; ticker: string; shares: number; averageCost: number; confidence: 'high' | 'medium' | 'low' }[] = [];
  let rowNum = 1;
  for (const [ticker, pos] of positions) {
    // Filter out closed/tiny positions
    if (pos.shares >= 0.01) {
      const avgCost = pos.totalCost / pos.shares;
      parsed.push({
        rowNumber: rowNum++,
        ticker,
        shares: Math.round(pos.shares * 1000000) / 1000000,
        averageCost: Math.round(avgCost * 100) / 100,
        confidence: 'high',
      });
    }
  }

  return { parsed, warnings, trades };
}

/**
 * Detect and parse Schwab transaction history CSV.
 * Format: Date, Action, Symbol, Description, Quantity, Price, Fees & Comm, Amount
 * Replays trades to compute current positions with weighted avg cost.
 */
function parseSchwabTransactionCsv(
  data: Record<string, unknown>[]
): { parsed: { rowNumber: number; ticker: string; shares: number; averageCost: number; confidence: 'high' | 'medium' | 'low' }[]; warnings: { rowNumber: number; message: string }[]; trades: { date: string; ticker: string; type: string; shares: number; price: number; rowIndex: number; sourceBroker: string; rawAction: string }[] } | null {
  const headers = Object.keys(data[0] || {}).map(h => h.toLowerCase().trim());
  const isSchwab = headers.includes('date') && headers.includes('action') && headers.includes('symbol') && !headers.includes('activity date');
  if (!isSchwab) return null;

  const positions = new Map<string, { shares: number; totalCost: number }>();
  const warnings: { rowNumber: number; message: string }[] = [];
  const trades: { date: string; ticker: string; type: string; shares: number; price: number; rowIndex: number; sourceBroker: string; rawAction: string }[] = [];
  let tradeRowIndex = 0;

  // Actions to skip (cash/interest/fees, not share transactions)
  const ignoreActions = new Set([
    'wire funds', 'wire funds received', 'moneylink transfer',
    'bank interest', 'credit interest', 'margin interest',
    'journal', 'cash dividend', 'qualified dividend',
    'non-qualified div', 'foreign tax paid', 'adr mgmt fee',
    'ira conversion', 'service fee',
  ]);

  // Schwab exports newest-first — reverse to process chronologically
  const chronological = [...data].reverse();

  chronological.forEach((row, index) => {
    const originalRowNum = data.length - index;
    const action = String(row['Action'] || '').trim();
    const actionLower = action.toLowerCase();

    // Skip totals row and non-trade actions
    if (actionLower === 'transactions total' || actionLower === '') return;
    if (ignoreActions.has(actionLower)) return;

    const ticker = String(row['Symbol'] || '').trim().toUpperCase();
    if (!ticker || !isValidTicker(ticker)) return;

    const dateStr = String(row['Date'] || '').trim();
    const qtyRaw = String(row['Quantity'] || '').replace(/[$,]/g, '').trim();
    const qty = parseFloat(qtyRaw);
    const priceRaw = String(row['Price'] || '').replace(/[$,()]/g, '').trim();
    const price = parseFloat(priceRaw);

    const pos = positions.get(ticker) || { shares: 0, totalCost: 0 };

    if (actionLower === 'buy' || actionLower === 'reinvest shares') {
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
        warnings.push({ rowNumber: originalRowNum, message: `Skipped ${ticker} ${action} — invalid qty/price` });
        return;
      }
      pos.totalCost += qty * price;
      pos.shares += qty;
      trades.push({ date: dateStr, ticker, type: 'buy', shares: qty, price, rowIndex: tradeRowIndex++, sourceBroker: 'schwab', rawAction: action });
    } else if (actionLower === 'sell') {
      if (!Number.isFinite(qty) || qty <= 0) {
        warnings.push({ rowNumber: originalRowNum, message: `Skipped ${ticker} Sell — invalid qty` });
        return;
      }
      if (pos.shares <= 0) {
        warnings.push({ rowNumber: originalRowNum, message: `${ticker} sell without open position` });
      } else {
        const avgBefore = pos.totalCost / pos.shares;
        pos.shares -= qty;
        if (pos.shares <= 0.001) {
          pos.shares = 0;
          pos.totalCost = 0;
        } else {
          pos.totalCost = pos.shares * avgBefore;
        }
        trades.push({ date: dateStr, ticker, type: 'sell', shares: qty, price: Number.isFinite(price) ? price : 0, rowIndex: tradeRowIndex++, sourceBroker: 'schwab', rawAction: action });
      }
    } else if (actionLower === 'stock split') {
      if (Number.isFinite(qty) && qty > 0 && pos.shares > 0) {
        pos.shares += qty;
        trades.push({ date: dateStr, ticker, type: 'split', shares: qty, price: 0, rowIndex: tradeRowIndex++, sourceBroker: 'schwab', rawAction: action });
      }
    } else if (actionLower === 'security transfer' || actionLower === 'receive') {
      if (Number.isFinite(qty) && qty > 0) {
        const p = Number.isFinite(price) && price > 0 ? price : 0;
        pos.totalCost += qty * p;
        pos.shares += qty;
        trades.push({ date: dateStr, ticker, type: 'transfer', shares: qty, price: p, rowIndex: tradeRowIndex++, sourceBroker: 'schwab', rawAction: action });
      }
    } else if (actionLower === 'stock merger') {
      if (Number.isFinite(qty) && qty > 0) {
        const p = Number.isFinite(price) && price > 0 ? price : 0;
        pos.totalCost += qty * p;
        pos.shares += qty;
        trades.push({ date: dateStr, ticker, type: 'merger', shares: qty, price: p, rowIndex: tradeRowIndex++, sourceBroker: 'schwab', rawAction: action });
      }
    } else {
      warnings.push({ rowNumber: originalRowNum, message: `Unknown Schwab action '${action}' for ${ticker}` });
    }

    positions.set(ticker, pos);
  });

  const parsed: { rowNumber: number; ticker: string; shares: number; averageCost: number; confidence: 'high' | 'medium' | 'low' }[] = [];
  let rowNum = 1;
  for (const [ticker, pos] of positions) {
    if (pos.shares >= 0.01) {
      const avgCost = pos.totalCost / pos.shares;
      parsed.push({
        rowNumber: rowNum++,
        ticker,
        shares: Math.round(pos.shares * 1000000) / 1000000,
        averageCost: Math.round(avgCost * 100) / 100,
        confidence: 'high',
      });
    }
  }

  return { parsed, warnings, trades };
}

// parseNumber imported from ../utils/parse-number

function isValidTicker(ticker: string): boolean {
  return /^[A-Z]{1,5}(\.[A-Z])?$/.test(ticker);
}

/**
 * Strip brokerage-specific header/footer lines from CSV text.
 * Schwab CSVs start with an account info line ("Transactions  for account...") before the actual headers.
 * Also removes BOM and trailing totals lines.
 */
function preprocessCsvText(text: string): string {
  // Strip BOM
  let cleaned = text.replace(/^\uFEFF/, '');

  const lines = cleaned.split(/\r?\n/);

  // Schwab: first line is account info (doesn't contain enough commas to be a header row)
  // e.g. "Transactions  for account XXXX-1234 as of 02/22/2026"
  if (lines.length > 1) {
    const firstLine = lines[0].trim();
    const commaCount = (firstLine.match(/,/g) || []).length;
    // Account info lines have 0 commas; even 2-column CSVs have at least 1
    if (commaCount === 0 && firstLine.length > 0 && !firstLine.startsWith('"Date"') && !firstLine.toLowerCase().startsWith('date,')) {
      lines.shift();
    }
  }

  // Remove trailing empty lines and totals rows
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim().toLowerCase();
    if (last === '' || last.startsWith('transactions total') || last.startsWith('"transactions total"')) {
      lines.pop();
    } else {
      break;
    }
  }

  return lines.join('\n');
}

export async function importPortfolioCsvHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file || !file.buffer) {
      res.status(400).json({ error: 'CSV file is required (field name: file)' });
      return;
    }

    const parseStart = Date.now();
    const csvText = preprocessCsvText(file.buffer.toString('utf8'));
    const data = parseCsv(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, unknown>[];

    // Try Robinhood transaction history format first
    const robinhoodResult = parseRobinhoodTransactionCsv(data);
    if (robinhoodResult) {
      const parseDurationMs = Date.now() - parseStart;
      res.json({
        reviewRequired: true,
        editableFields: ['ticker', 'shares', 'averageCost'],
        parsed: robinhoodResult.parsed,
        warnings: robinhoodResult.warnings,
        trades: robinhoodResult.trades,
        totalRows: data.length,
        validRows: robinhoodResult.parsed.length,
        skippedRows: data.length - robinhoodResult.parsed.length,
        warning: `Detected Robinhood transaction history — aggregated ${data.length} transactions into ${robinhoodResult.parsed.length} current positions`,
        telemetry: {
          rowsParsed: data.length,
          rowsSkipped: data.length - robinhoodResult.trades.length,
          skipReasons: {},
          brokerDetected: 'robinhood',
          parseDurationMs,
        },
      });
      return;
    }

    // Try Schwab transaction history format
    const schwabResult = parseSchwabTransactionCsv(data);
    if (schwabResult) {
      const parseDurationMs = Date.now() - parseStart;
      res.json({
        reviewRequired: true,
        editableFields: ['ticker', 'shares', 'averageCost'],
        parsed: schwabResult.parsed,
        warnings: schwabResult.warnings,
        trades: schwabResult.trades,
        totalRows: data.length,
        validRows: schwabResult.parsed.length,
        skippedRows: data.length - schwabResult.parsed.length,
        warning: `Detected Schwab transaction history — aggregated ${data.length} transactions into ${schwabResult.parsed.length} current positions`,
        telemetry: {
          rowsParsed: data.length,
          rowsSkipped: data.length - schwabResult.trades.length,
          skipReasons: {},
          brokerDetected: 'schwab',
          parseDurationMs,
        },
      });
      return;
    }

    // Standard holdings CSV format
    const headers = Object.keys(data[0] || {});

    const headerMap: Record<string, string> = {};
    headers.forEach((h) => {
      const normalized = normalizeHeader(h);
      headerMap[normalized] = h;
    });

    const tickerKey = headerMap.ticker || headerMap.symbol;
    const sharesKey = headerMap.shares || headerMap.qty || headerMap.quantity;
    const averageCostKey =
      headerMap.averagecost ||
      headerMap.avgcost ||
      headerMap.average_cost ||
      headerMap.avg_cost ||
      headerMap.costbasis ||
      headerMap.cost_basis;

    if (!tickerKey || !sharesKey || !averageCostKey) {
      res.status(400).json({ error: 'CSV must include ticker, shares, and average cost columns' });
      return;
    }

    const knownHeaders = new Set([
      tickerKey,
      sharesKey,
      averageCostKey,
    ]);

    const warnings: { rowNumber: number; message: string }[] = [];
    headers.forEach((h) => {
      if (!knownHeaders.has(h)) {
        warnings.push({ rowNumber: 0, message: `Unknown column '${h}' ignored` });
      }
    });

    const parsedRows: {
      rowNumber: number;
      ticker: string;
      shares: number;
      averageCost: number;
      confidence: 'high' | 'medium' | 'low';
    }[] = [];

    let skippedRows = 0;
    data.forEach((row, index) => {
      const rowNumber = index + 1;
      const rawTicker = String(row[tickerKey] || '').trim().toUpperCase();
      const shares = parseNumber(row[sharesKey]);
      const averageCost = parseNumber(row[averageCostKey]);

      if (!rawTicker || !isValidTicker(rawTicker) || shares == null || shares <= 0 || averageCost == null || averageCost < 0) {
        skippedRows += 1;
        warnings.push({
          rowNumber,
          message: 'Invalid row data (ticker/shares/averageCost)',
        });
        return;
      }

      parsedRows.push({
        rowNumber,
        ticker: rawTicker,
        shares,
        averageCost,
        confidence: 'high',
      });
    });

    res.json({
      reviewRequired: true,
      editableFields: ['ticker', 'shares', 'averageCost'],
      parsed: parsedRows,
      warnings,
      totalRows: data.length,
      validRows: parsedRows.length,
      skippedRows,
    });
  } catch (_error) {
    console.error('CSV import parse error:');
    res.status(500).json({ error: 'Failed to parse CSV' });
  }
}

/**
 * Generic column-mapped CSV import.
 * Accepts CSV file + column mappings as multipart form data.
 * Replays transactions using user-provided column assignments.
 */
export async function importMappedCsvHandler(req: AuthRequest, res: Response): Promise<void> {
  const parseStart = Date.now();
  const skipReasons: Record<string, number> = {};
  const incSkip = (reason: string) => { skipReasons[reason] = (skipReasons[reason] || 0) + 1; };

  try {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file || !file.buffer) {
      res.status(400).json({ error: 'CSV file is required (field name: file)' });
      return;
    }

    // Parse mappings from form field
    let mappings: { ticker: string; date?: string; price?: string; shares?: string; totalAmount?: string; action?: string };
    try {
      mappings = JSON.parse(req.body.mappings || '{}');
    } catch {
      res.status(400).json({ error: 'mappings must be valid JSON' });
      return;
    }

    if (!mappings.ticker) {
      res.status(400).json({ error: 'mappings.ticker is required' });
      return;
    }

    // At least one numeric field required
    if (!mappings.price && !mappings.shares && !mappings.totalAmount) {
      res.status(400).json({ error: 'mappings must include at least one of: price, shares, totalAmount' });
      return;
    }

    const excludedRows: Set<number> = new Set(
      JSON.parse(req.body.excludedRows || '[]')
    );
    const sourceBroker = normalizeSourceBroker(req.body.sourceBroker);

    // Parse CSV — strip BOM + preamble lines (e.g. Schwab account info)
    const csvText = preprocessCsvText(file.buffer.toString('utf8'));
    const data = parseCsv(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, unknown>[];

    // Row cap
    const MAX_ROWS = 2000;
    if (data.length > MAX_ROWS) {
      res.status(400).json({ error: 'too_many_rows', count: data.length, max: MAX_ROWS });
      return;
    }

    // Canonical trade types accepted by replay engine
    const CANONICAL_TYPES = new Set(['buy', 'sell', 'split', 'transfer', 'merger', 'cancel']);

    // Infer trade type from action text
    function inferType(actionText: string, amount: number | null): string | null {
      const lower = actionText.toLowerCase().trim();
      if (!lower) {
        // Infer from amount sign if no action column
        if (amount != null && amount < 0) return 'buy';
        if (amount != null && amount > 0) return 'sell';
        return null;
      }
      if (lower.includes('buy') || lower.includes('purchase') || lower.includes('reinvest')) return 'buy';
      if (lower.includes('sell') || lower.includes('sold')) return 'sell';
      if (lower.includes('split')) return 'split';
      if (lower.includes('transfer') || lower.includes('receive')) return 'transfer';
      if (lower.includes('merger') || lower.includes('exchange')) return 'merger';
      if (lower.includes('cancel')) return 'cancel';
      // Not a canonical trade type — skip
      return null;
    }

    const positions = new Map<string, { shares: number; totalCost: number }>();
    const warnings: { rowNumber: number; message: string }[] = [];
    const trades: { date: string; ticker: string; type: string; shares: number; price: number; rowIndex: number; sourceBroker: string; rawAction: string }[] = [];
    let tradeRowIndex = 0;

    // Process rows (assume chronological or newest-first — we reverse if dates are descending)
    const rows = [...data];

    // Detect date ordering: if first row date > last row date, reverse
    if (rows.length >= 2 && mappings.date) {
      const firstDate = new Date(String(rows[0][mappings.date] || ''));
      const lastDate = new Date(String(rows[rows.length - 1][mappings.date] || ''));
      if (!isNaN(firstDate.getTime()) && !isNaN(lastDate.getTime()) && firstDate > lastDate) {
        rows.reverse();
      }
    }

    rows.forEach((row, idx) => {
      const rowNum = idx + 1;

      // Check exclusion
      if (excludedRows.has(idx)) {
        incSkip('excluded_by_user');
        return;
      }

      // Extract ticker
      const ticker = String(row[mappings.ticker] || '').trim().toUpperCase();
      if (!ticker || !isValidTicker(ticker)) {
        incSkip('invalid_ticker');
        warnings.push({ rowNumber: rowNum, message: `Invalid ticker: '${ticker}'` });
        return;
      }

      // Extract date
      let dateStr = '';
      if (mappings.date) {
        dateStr = String(row[mappings.date] || '').trim();
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) {
          incSkip('invalid_date');
          warnings.push({ rowNumber: rowNum, message: `Invalid date: '${dateStr}' for ${ticker}` });
          return;
        }
      } else {
        dateStr = new Date().toLocaleDateString('en-US');
      }

      // Extract numeric fields
      const price = mappings.price ? parseNumber(row[mappings.price]) : null;
      const shares = mappings.shares ? parseNumber(row[mappings.shares]) : null;
      const totalAmount = mappings.totalAmount ? parseNumber(row[mappings.totalAmount]) : null;

      // Derive missing fields
      let finalPrice = price;
      let finalShares = shares;

      if (finalPrice == null && totalAmount != null && finalShares != null && finalShares !== 0) {
        finalPrice = Math.abs(totalAmount / finalShares);
      }
      if (finalShares == null && totalAmount != null && finalPrice != null && finalPrice !== 0) {
        finalShares = Math.abs(totalAmount / finalPrice);
      }
      if (finalPrice == null && finalShares == null) {
        incSkip('missing_numeric');
        warnings.push({ rowNumber: rowNum, message: `Missing price and shares for ${ticker}` });
        return;
      }

      finalPrice = finalPrice ?? 0;
      finalShares = finalShares ?? 0;
      if (finalPrice < 0) finalPrice = Math.abs(finalPrice);   // accounting format e.g. ($500)
      if (finalShares < 0) finalShares = Math.abs(finalShares);

      // Extract and infer action
      const rawAction = mappings.action ? String(row[mappings.action] || '').trim() : '';
      const inferredType = inferType(rawAction, totalAmount);
      if (inferredType == null || !CANONICAL_TYPES.has(inferredType)) {
        incSkip('unsupported_action');
        warnings.push({ rowNumber: rowNum, message: `Unsupported action '${rawAction}' for ${ticker}` });
        return;
      }

      // Replay transaction
      const pos = positions.get(ticker) || { shares: 0, totalCost: 0 };

      if (inferredType === 'buy') {
        if (finalShares <= 0 || finalPrice < 0) {
          incSkip('invalid_qty_price');
          return;
        }
        pos.totalCost += finalShares * finalPrice;
        pos.shares += finalShares;
      } else if (inferredType === 'sell') {
        if (finalShares <= 0) {
          incSkip('invalid_qty_price');
          return;
        }
        if (pos.shares > 0) {
          const avgBefore = pos.totalCost / pos.shares;
          pos.shares -= finalShares;
          if (pos.shares <= 0.001) {
            pos.shares = 0;
            pos.totalCost = 0;
          } else {
            pos.totalCost = pos.shares * avgBefore;
          }
        }
      } else if (inferredType === 'split') {
        if (finalShares > 0 && pos.shares > 0) {
          pos.shares += finalShares;
        }
      } else if (inferredType === 'transfer' || inferredType === 'merger') {
        if (finalShares > 0) {
          pos.totalCost += finalShares * finalPrice;
          pos.shares += finalShares;
        }
      } else if (inferredType === 'cancel') {
        if (finalShares > 0 && pos.shares > 0) {
          const avgBefore = pos.totalCost / pos.shares;
          pos.shares -= finalShares;
          if (pos.shares <= 0.001) {
            pos.shares = 0;
            pos.totalCost = 0;
          } else {
            pos.totalCost = pos.shares * avgBefore;
          }
        }
      }

      positions.set(ticker, pos);
      trades.push({
        date: dateStr,
        ticker,
        type: inferredType,
        shares: finalShares,
        price: finalPrice,
        rowIndex: tradeRowIndex++,
        sourceBroker,
        rawAction,
      });
    });

    // Build positions output
    const parsed: { rowNumber: number; ticker: string; shares: number; averageCost: number; confidence: 'high' | 'medium' | 'low' }[] = [];
    let rowNum = 1;
    for (const [ticker, pos] of positions) {
      if (pos.shares >= 0.01) {
        const avgCost = pos.totalCost / pos.shares;
        parsed.push({
          rowNumber: rowNum++,
          ticker,
          shares: Math.round(pos.shares * 1000000) / 1000000,
          averageCost: Math.round(avgCost * 100) / 100,
          confidence: 'high',
        });
      }
    }

    const parseDurationMs = Date.now() - parseStart;
    res.json({
      reviewRequired: true,
      editableFields: ['ticker', 'shares', 'averageCost'],
      parsed,
      warnings,
      trades,
      totalRows: data.length,
      validRows: parsed.length,
      skippedRows: Object.values(skipReasons).reduce((a, b) => a + b, 0),
      warning: `Mapped import — processed ${data.length} rows into ${parsed.length} positions`,
      telemetry: {
        rowsParsed: data.length,
        rowsSkipped: Object.values(skipReasons).reduce((a, b) => a + b, 0),
        skipReasons,
        brokerDetected: sourceBroker,
        parseDurationMs,
      },
    });
  } catch (_error) {
    console.error('[MappedImport] Error:', _error);
    res.status(500).json({ error: 'Failed to process mapped CSV' });
  }
}

export async function confirmPortfolioImportHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { holdings, mode, trades } = req.body as { holdings?: any[]; mode?: 'replace' | 'merge'; trades?: any[] };
    if (!Array.isArray(holdings) || holdings.length === 0) {
      res.status(400).json({ error: 'holdings must be a non-empty array' });
      return;
    }
    if (mode !== 'replace' && mode !== 'merge') {
      res.status(400).json({ error: 'mode must be replace or merge' });
      return;
    }

    const existingHoldings = await prisma.holding.findMany({
      where: { userId: req.user!.userId },
      select: { ticker: true },
    });
    const existingSet = new Set(existingHoldings.map(h => h.ticker.toUpperCase()));

    const normalized = holdings.map((h) => ({
      ticker: String(h.ticker || '').trim().toUpperCase(),
      shares: Number(h.shares),
      averageCost: Number(h.averageCost),
    })).filter(h => isValidTicker(h.ticker) && h.shares > 0 && Number.isFinite(h.averageCost) && h.averageCost >= 0);

    if (normalized.length === 0) {
      res.status(400).json({ error: 'holdings must include at least one valid entry' });
      return;
    }

    const _incomingSet = new Set(normalized.map(h => h.ticker));

    let added = 0;
    let updated = 0;
    let removed = 0;

    if (mode === 'replace') {
      removed = existingHoldings.length;
      added = normalized.length;
      updated = 0;

      await prisma.holding.deleteMany({ where: { userId: req.user!.userId } });
    } else {
      added = normalized.filter(h => !existingSet.has(h.ticker)).length;
      updated = normalized.filter(h => existingSet.has(h.ticker)).length;
    }

    for (const h of normalized) {
      await upsertHolding(
        { ticker: h.ticker, shares: h.shares, averageCost: h.averageCost },
        req.user!.userId
      );
    }

    // Save trade history if provided (from Robinhood CSV import)
    if (Array.isArray(trades) && trades.length > 0) {
      // Clear existing trades for this user on replace
      if (mode === 'replace') {
        await prisma.portfolioTrade.deleteMany({ where: { userId: req.user!.userId } });
      }
      // Generate a unique sourceFileId for this import batch
      const { randomUUID } = await import('crypto');
      const sourceFileId = randomUUID();
      // Batch insert trades with rowIndex for deterministic ordering
      const tradeRecords = trades
        .filter((t: any) => t.date && t.ticker && t.type)
        .map((t: any, idx: number) => ({
          userId: req.user!.userId,
          date: new Date(t.date),
          ticker: String(t.ticker).trim().toUpperCase(),
          type: String(t.type),
          shares: Number(t.shares) || 0,
          price: Number(t.price) || 0,
          rowIndex: Number(t.rowIndex) || idx,
          sourceFileId,
          sourceBroker: typeof t.sourceBroker === 'string' ? t.sourceBroker : null,
          rawAction: typeof t.rawAction === 'string' ? t.rawAction : null,
        }))
        .filter(t => !isNaN(t.date.getTime()));
      if (tradeRecords.length > 0) {
        await prisma.portfolioTrade.createMany({ data: tradeRecords });
        console.log(`[Import] Saved ${tradeRecords.length} portfolio trades for user ${req.user!.userId} (batch ${sourceFileId})`);
      }
    }

    try {
      await recordCompositionChange(req.user!.userId, mode === 'replace' ? 'import_replace' : 'import_merge');
      await resetSnapshotsForCompositionChange(req.user!.userId);
    } catch (_err) {
      console.warn('[Snapshot] Reset failed after import confirm:');
    }

    res.json({ added, updated, removed });
  } catch (error) {
    if (error instanceof PlanLimitError) {
      res.status(403).json({ error: 'limit_reached', limit: error.limit, plan: error.plan });
      return;
    }
    console.error('Import confirm error:');
    res.status(500).json({ error: 'Failed to apply import' });
  }
}

export async function clearPortfolioHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { confirmation } = req.body as { confirmation?: string };
    if (confirmation !== 'CLEAR') {
      res.status(400).json({ error: 'Invalid confirmation' });
      return;
    }

    const deleted = await prisma.holding.deleteMany({ where: { userId: req.user!.userId } });
    await prisma.userSettings.upsert({
      where: { userId: req.user!.userId },
      update: { cashBalance: 0, marginDebt: 0 },
      create: { userId: req.user!.userId, cashBalance: 0, marginDebt: 0 },
    });
    try {
      await recordCompositionChange(req.user!.userId, 'portfolio_clear');
      await resetSnapshotsForCompositionChange(req.user!.userId);
    } catch (_err) {
      console.warn('[Snapshot] Reset failed after clear portfolio:');
    }

    res.json({ cleared: true, holdingsRemoved: deleted.count });
  } catch (_error) {
    console.error('Clear portfolio error:');
    res.status(500).json({ error: 'Failed to clear portfolio' });
  }
}

export async function importPortfolioScreenshotHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file || !file.buffer) {
      res.status(400).json({ error: 'Image file is required (field name: file)' });
      return;
    }

    const { text, confidence, variant, parsed: parsedResult } = await extractBestOcrForHoldings(file.buffer, {
      mimeType: file.mimetype,
      fileName: file.originalname,
    });
    const result = parsedResult ?? parseHoldingsFromText(text);

    // Apply overall OCR confidence to row confidence (simple heuristic)
    const parsed = result.parsed.map(row => ({
      ...row,
      confidence: confidence >= 85 ? 'high' : confidence >= 70 ? 'medium' : 'low',
    }));

    const guidanceWarning = {
      rowNumber: 0,
      message: 'For best results, ensure the stock name/ticker, share count, and average price are clearly visible in the screenshot.',
    };

    const responsePayload: Record<string, unknown> = {
      reviewRequired: true,
      editableFields: ['ticker', 'shares', 'averageCost'],
      parsed,
      warnings: [guidanceWarning, ...result.warnings],
      totalRows: parsed.length + result.warnings.length,
      validRows: parsed.length,
      skippedRows: result.warnings.length,
    };

    if (process.env.NODE_ENV !== 'production' && String(req.query.debug) === '1') {
      responsePayload.debug = {
        rawText: text,
        rawLines: text.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
        ocrVariant: variant,
      };
    }

    res.json(responsePayload);
  } catch (error) {
    console.error('Screenshot OCR error:');
    if (String((error as Error)?.message || '').includes('HEIC conversion failed')) {
      res.status(400).json({ error: 'Unsupported image format. Please upload PNG or JPG.' });
      return;
    }
    res.status(500).json({ error: 'Failed to process screenshot' });
  }
}

const SAMPLE_HOLDINGS = [
  { ticker: 'AAPL', shares: 10, averageCost: 185.00 },
  { ticker: 'MSFT', shares: 5, averageCost: 410.00 },
  { ticker: 'GOOGL', shares: 8, averageCost: 175.00 },
  { ticker: 'AMZN', shares: 6, averageCost: 195.00 },
  { ticker: 'NVDA', shares: 4, averageCost: 880.00 },
];

export async function seedSamplePortfolio(req: AuthRequest, res: Response): Promise<void> {
  try {
    const existing = await getHoldings(req.user!.userId);
    if (existing.length > 0) {
      res.status(409).json({ error: 'Portfolio already has holdings. Clear first to re-seed.' });
      return;
    }

    for (const h of SAMPLE_HOLDINGS) {
      await upsertHolding(h, req.user!.userId);
    }

    await setBaseline(req.user!.userId, { type: 'existing_portfolio' });

    try {
      await recordCompositionChange(req.user!.userId, 'sample_seed');
      await resetSnapshotsForCompositionChange(req.user!.userId);
    } catch (_err) {
      console.warn('[Snapshot] Reset failed after sample seed:');
    }

    res.json({ seeded: true, holdings: SAMPLE_HOLDINGS.length });
  } catch (_error) {
    console.error('Error seeding sample portfolio:');
    res.status(500).json({ error: 'Failed to seed sample portfolio' });
  }
}

