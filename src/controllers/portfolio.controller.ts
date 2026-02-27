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
import { createSnapshotIfNeeded, createUserSnapshotIfNeeded, getAllSnapshots, getSnapshotsAfter, getSnapshotChartPoints, reconstructPortfolioHistoryHiRes, getLedgerReplayGapSummary, resetSnapshotsForCompositionChange, recordCompositionChange, getLatestCompositionChangeAfter } from '../services/snapshot.service';
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
import { isValidLedgerEventType, normalizeSourceBroker } from '../services/ledger/settlement-policy';
import { parseNumber } from '../utils/parse-number';
import { getAccountHistory, HistoryCategory } from '../services/account-history.service';

const VALID_MODES: ProjectionMode[] = ['sp500', 'realized'];
const VALID_LOOKBACKS: LookbackPeriod[] = ['1d', '1w', '1m', '6m', '1y', 'max'];
const FREE_CHART_PERIODS = new Set(['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL']);

export async function getPortfolioHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    // Only use userId if explicitly passed as query param (e.g., leaderboard/social profile views).
    // The main portfolio uses the authenticated user's data from their JWT.
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

    // Own-portfolio path requires authentication
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const portfolio = await getPortfolio(req.user.userId);

    const includeDebug = String(req.query.debug) === '1';

    if (period === '1D') {
      const now = Date.now();
      const liveValue = portfolio.totalAssets - portfolio.marginDebt;
      const previousCloseValue = liveValue - portfolio.dayChange;
      const holdings = await getHoldings(req.user.userId);
      let source: 'snapshot' | 'model' | 'hiRes' | 'daily' = 'hiRes';

      // Reconstruct 1D from Yahoo 5-min intraday candles (current holdings only).
      // After hours, Yahoo range=1d still returns the last trading session's data.
      let points = await reconstructPortfolioHistoryHiRes(
        holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
        portfolio.cashBalance, portfolio.marginDebt, '1d', '5m',
      );

      // If intraday returned insufficient data, fall back to last 24h of snapshots
      if (points.length < 5) {
        const cutoff = new Date(now - 24 * 60 * 60 * 1000);
        const snapshots = await getAllSnapshots(req.user.userId);
        const recentSnapshots = snapshots.filter(s => s.timestamp.getTime() >= cutoff.getTime());
        if (recentSnapshots.length >= 2) {
          points = recentSnapshots.map(s => ({
            time: s.timestamp.getTime(),
            value: s.netEquity ?? s.totalValue,
          }));
          source = 'snapshot';
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
          const snapshots = await getSnapshotsAfter(req.user.userId, new Date(lastCandleTime));
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

      // Smooth intraday outlier spikes — a single point deviating >3% from both
      // neighbors is likely a bad extended-hours quote or snapshot glitch.
      if (points.length >= 3) {
        for (let i = 1; i < points.length - 1; i++) {
          const prev = points[i - 1].value;
          const curr = points[i].value;
          const next = points[i + 1].value;
          const neighborAvg = (prev + next) / 2;
          if (neighborAvg > 0 && Math.abs(curr - neighborAvg) / neighborAvg > 0.03) {
            points[i].value = neighborAvg;
          }
        }
      }

      // If composition changed within the last day, rebaseline to avoid false jumps.
      // But don't filter if it would leave too few points for a useful chart,
      // OR if the filtered set is entirely outside market hours (4 AM–8 PM ET).
      // After-hours imports produce points that cluster at the chart's right edge
      // and render as invisible. In that case, the full-day candles (already
      // offset-normalized to live value) produce a better chart.
      const pointCountRaw = points.length;
      let rebaselineApplied = false;
      const rangeStart = new Date(now - 24 * 60 * 60 * 1000);
      const latestChange = await getLatestCompositionChangeAfter(req.user.userId, rangeStart);
      if (latestChange) {
        const cutoff = latestChange.getTime();
        const filtered = points.filter(p => p.time >= cutoff);
        const minUsable = Math.max(20, Math.ceil(points.length * 0.5));
        // Verify filtered set has data within market hours (4 AM–8 PM ET)
        const etHourFmt = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
        });
        const hasMarketHours = filtered.some(p => {
          const h = parseInt(etHourFmt.format(new Date(p.time)).split(':')[0]);
          return h >= 4 && h < 20;
        });
        if (filtered.length >= minUsable && hasMarketHours) {
          points = filtered;
          rebaselineApplied = true;
        }
      }

      const periodStartValue = latestChange
        ? (points.length > 0 ? points[0].value : liveValue)
        : (previousCloseValue || (points.length > 0 ? points[0].value : liveValue));

      const response: Record<string, unknown> = { points, periodStartValue, period: '1D', source };
      if (includeDebug) {
        response.rebaselineApplied = rebaselineApplied;
        response.pointCountRaw = pointCountRaw;
        response.pointCountFinal = points.length;
      }
      res.json(response);
      return;
    }

    // Non-1D periods: snapshot-only approach.
    // Use real recorded snapshot data — no reconstruction, no candle fetching.
    // If not enough snapshots, return insufficientData flag for the UI.
    const now = Date.now();
    const periodDaysMap: Record<string, number> = {
      '1W': 7, '1M': 30, '3M': 90,
      'YTD': Math.floor((now - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000),
      '1Y': 365, 'ALL': 365 * 5,
    };
    const periodDays = periodDaysMap[period] ?? 30;
    let points = await getSnapshotChartPoints(req.user!.userId, periodDays);

    // YTD baseline: if user set a Jan 1 portfolio value, use it to anchor YTD returns
    let ytdBaselineValue: number | null = null;
    if (period === 'YTD') {
      const userSettings = await prisma.userSettings.findUnique({
        where: { userId: req.user!.userId },
        select: { ytdBaselineValue: true },
      });
      ytdBaselineValue = userSettings?.ytdBaselineValue ?? null;

      // getSnapshotChartPoints enforces >=2 points internally, so with only 1 snapshot
      // it returns []. For YTD baseline we only need 1 snapshot — fetch directly.
      if (points.length === 0 && ytdBaselineValue != null) {
        const since = new Date(now - periodDays * 86400000);
        const rawSnaps = await prisma.portfolioSnapshot.findMany({
          where: { userId: req.user!.userId, timestamp: { gte: since } },
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

    // Progressive unlock: each period requires a minimum number of days of snapshot data.
    // Prevents showing e.g. 6 days of data on a 1Y chart with misleading returns.
    // YTD with baseline bypasses progressive unlock (minDays=0, minPoints=1).
    const minDaysRequired: Record<string, number> = {
      '1W': 2, '1M': 7, '3M': 30, 'YTD': 30, '1Y': 90, 'ALL': 90,
    };
    const spanMs = points.length >= 2 ? points[points.length - 1].time - points[0].time : 0;
    const spanDays = spanMs / 86400000;
    const minDays = (period === 'YTD' && ytdBaselineValue != null) ? 0 : (minDaysRequired[period] ?? 2);
    const minPoints = (period === 'YTD' && ytdBaselineValue != null) ? 1 : 2;
    console.log(`[Chart] ${period} snapshot-only points=${points.length} span=${spanDays.toFixed(1)}d required=${minDays}d minPts=${minPoints} ytdBaseline=${ytdBaselineValue}`);

    if (points.length < minPoints || spanDays < minDays) {
      res.json({ points: [], insufficientData: true, period, periodStartValue: 0, source: 'snapshot' });
      return;
    }

    const pointCountRaw = points.length;

    // Append current live value to connect last snapshot to now
    const liveVal = portfolio.totalAssets - portfolio.marginDebt;
    if (now - points[points.length - 1].time > 5000) {
      points.push({ time: now, value: liveVal });
    }

    // If YTD with baseline, prepend synthetic Jan 1 point and use baseline as periodStartValue
    let periodStartValue: number;
    if (period === 'YTD' && ytdBaselineValue != null) {
      const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime();
      // Only prepend if first real point is after Jan 1
      if (points[0].time > jan1) {
        points = [{ time: jan1, value: ytdBaselineValue }, ...points];
      }
      periodStartValue = ytdBaselineValue;
    } else {
      periodStartValue = points[0].value;
    }

    const response: Record<string, unknown> = { points, periodStartValue, period, source: 'snapshot' };
    if (includeDebug) {
      response.rebaselineApplied = false;
      response.pointCountRaw = pointCountRaw;
      response.pointCountFinal = points.length;
    }
    res.json(response);
  } catch (chartError) {
    console.error('Error fetching chart data:', chartError instanceof Error ? chartError.stack : String(chartError));
    res.status(500).json({ error: 'Failed to fetch chart data' });
  }
}

export async function getChartGapSummaryHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const period = ((req.query.period as string) || '1W').toUpperCase();
    if (!['1W', '1M', '3M', 'YTD', '1Y', 'ALL'].includes(period)) {
      res.status(400).json({ error: 'Invalid period. Must be one of: 1W, 1M, 3M, YTD, 1Y, ALL' });
      return;
    }

    const hasLedgerEvents = await prisma.ledgerEvent.count({ where: { userId: req.user!.userId } });
    if (hasLedgerEvents === 0) {
      res.json({ period, gaps: [] });
      return;
    }

    const now = Date.now();
    const periodDaysMap: Record<string, number> = {
      '1W': 7,
      '1M': 30,
      '3M': 90,
      'YTD': Math.floor((now - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000),
      '1Y': 365,
      'ALL': 365 * 5,
    };
    const periodDays = periodDaysMap[period] ?? 30;
    const gaps = await getLedgerReplayGapSummary(req.user!.userId, periodDays);
    res.json({ period, gaps });
  } catch (_error) {
    console.error('Error fetching chart gap summary:');
    res.status(500).json({ error: 'Failed to fetch chart gap summary' });
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

type ImportTradeRecord = {
  date: string;
  ticker: string;
  type: string;
  shares: number;
  price: number;
  rowIndex: number;
  sourceBroker: string;
  rawAction: string;
};

type ImportLedgerEventRecord = {
  eventType: string;
  effectiveDate: string;
  settleDate: string | null;
  ticker: string | null;
  shares: number | null;
  price: number | null;
  amount: number;
  fees: number;
  rowIndex: number;
  sourceBroker: string;
  rawAction: string;
};

/**
 * Detect and parse Robinhood transaction history CSV.
 * Replays Buy/Sell transactions to compute current positions with weighted avg cost.
 */
function parseRobinhoodTransactionCsv(
  data: Record<string, unknown>[]
): { parsed: { rowNumber: number; ticker: string; shares: number; averageCost: number; confidence: 'high' | 'medium' | 'low' }[]; warnings: { rowNumber: number; message: string }[]; trades: ImportTradeRecord[]; ledgerEvents: ImportLedgerEventRecord[] } | null {
  const headers = Object.keys(data[0] || {}).map(h => h.toLowerCase().trim());
  const isRobinhood = headers.includes('activity date') && headers.includes('trans code') && headers.includes('instrument');
  if (!isRobinhood) return null;

  const positions = new Map<string, { shares: number; totalCost: number }>();
  const warnings: { rowNumber: number; message: string }[] = [];
  const trades: ImportTradeRecord[] = [];
  const ledgerEvents: ImportLedgerEventRecord[] = [];
  let tradeRowIndex = 0;
  let ledgerRowIndex = 0;

  // Codes that don't affect share counts — skip silently
  const ignoreCodes = new Set(['SLIP', 'MISC', 'FUTSWP']);
  // Options codes — contracts, not stock shares
  const optionsCodes = new Set(['BTO', 'STC', 'STO', 'OEXP']);

  // Robinhood exports newest-first — reverse to process chronologically
  const chronological = [...data].reverse();

  chronological.forEach((row, index) => {
    const originalRowNum = data.length - index;
    const transCode = String(row['Trans Code'] || '').trim();
    if (ignoreCodes.has(transCode) || optionsCodes.has(transCode)) return;

    const dateStr = String(row['Activity Date'] || '').trim();
    const settleDateStr = String(row['Settle Date'] || '').trim();
    const tickerRaw = String(row['Instrument'] || '').trim().toUpperCase();
    const ticker = tickerRaw && isValidTicker(tickerRaw) ? tickerRaw : null;
    const qtyRaw = String(row['Quantity'] || '').replace(/[$,]/g, '').trim();
    const qtyClean = qtyRaw.replace(/S$/i, '');
    const qty = parseFloat(qtyClean);
    const priceRaw = String(row['Price'] || '').replace(/[$,()]/g, '').trim();
    const price = parseFloat(priceRaw);
    const amount = parseNumber(row['Amount']);

    if (
      transCode === 'CDIV' ||
      transCode === 'MDIV' ||
      transCode === 'ACH' ||
      transCode === 'GOLD' ||
      transCode === 'INT' ||
      transCode === 'MINT' ||
      transCode === 'GDBP' ||
      transCode === 'DTAX' ||
      transCode === 'DFEE' ||
      transCode === 'AFEE'
    ) {
      let eventType: string | null = null;
      if (transCode === 'CDIV' || transCode === 'MDIV') eventType = 'CASH_DIVIDEND';
      else if (transCode === 'INT' || transCode === 'MINT' || transCode === 'GDBP') eventType = 'INTEREST';
      else if (transCode === 'DTAX' || transCode === 'DFEE' || transCode === 'AFEE') eventType = 'FEE';
      else if (transCode === 'ACH' || transCode === 'GOLD') {
        if (amount != null && amount > 0) eventType = 'DEPOSIT';
        else if (amount != null && amount < 0) eventType = 'WITHDRAWAL';
      }
      if (eventType && amount != null) {
        const normalizedAmount = eventType === 'FEE' && amount > 0 ? -amount : amount;
        ledgerEvents.push({
          eventType,
          effectiveDate: dateStr,
          settleDate: settleDateStr || null,
          ticker,
          shares: qty != null && Number.isFinite(qty) ? Math.abs(qty) : null,
          price: price != null && Number.isFinite(price) ? Math.abs(price) : null,
          amount: normalizedAmount,
          fees: eventType === 'FEE' ? Math.abs(amount) : 0,
          rowIndex: ledgerRowIndex++,
          sourceBroker: 'robinhood',
          rawAction: transCode,
        });
      }
      return;
    }

    if (!ticker) return;

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
        warnings.push({ rowNumber: originalRowNum, message: `${ticker} sell without open position (pre-CSV holding)` });
      } else {
        const avgBefore = pos.totalCost / pos.shares;
        pos.shares -= qty;
        if (pos.shares <= 0.001) {
          pos.shares = 0;
          pos.totalCost = 0;
        } else {
          pos.totalCost = pos.shares * avgBefore;
        }
      }
      // Always record sell trades — position may have been held before CSV period
      trades.push({ date: dateStr, ticker, type: 'sell', shares: qty, price: Number.isFinite(price) ? price : 0, rowIndex: tradeRowIndex++, sourceBroker: 'robinhood', rawAction: transCode });
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

  return { parsed, warnings, trades, ledgerEvents };
}

/**
 * Detect and parse Schwab transaction history CSV.
 * Format: Date, Action, Symbol, Description, Quantity, Price, Fees & Comm, Amount
 * Replays trades to compute current positions with weighted avg cost.
 */
function parseSchwabTransactionCsv(
  data: Record<string, unknown>[]
): { parsed: { rowNumber: number; ticker: string; shares: number; averageCost: number; confidence: 'high' | 'medium' | 'low' }[]; warnings: { rowNumber: number; message: string }[]; trades: ImportTradeRecord[]; ledgerEvents: ImportLedgerEventRecord[] } | null {
  const headers = Object.keys(data[0] || {}).map(h => h.toLowerCase().trim());
  const isSchwab = headers.includes('date') && headers.includes('action') && headers.includes('symbol') && !headers.includes('activity date');
  if (!isSchwab) return null;

  const positions = new Map<string, { shares: number; totalCost: number }>();
  const warnings: { rowNumber: number; message: string }[] = [];
  const trades: ImportTradeRecord[] = [];
  const ledgerEvents: ImportLedgerEventRecord[] = [];
  let tradeRowIndex = 0;
  let ledgerRowIndex = 0;

  // Actions to skip (cash/interest/fees, not share transactions)
  const ignoreActions = new Set(['journal', 'ira conversion']);

  // Schwab exports newest-first — reverse to process chronologically
  const chronological = [...data].reverse();

  chronological.forEach((row, index) => {
    const originalRowNum = data.length - index;
    const action = String(row['Action'] || '').trim();
    const actionLower = action.toLowerCase();
    const dateStr = String(row['Date'] || '').trim();
    const settleDateStr = String(row['Settlement Date'] || row['Settle Date'] || '').trim();
    const amount = parseNumber(row['Amount']);
    const feesAndComm = parseNumber(row['Fees & Comm']) ?? 0;

    // Skip totals row and non-trade actions
    if (actionLower === 'transactions total' || actionLower === '') return;
    if (
      actionLower === 'cash dividend' ||
      actionLower === 'qualified dividend' ||
      actionLower === 'non-qualified div' ||
      actionLower === 'non-qualified dividend'
    ) {
      if (amount != null) {
        ledgerEvents.push({
          eventType: 'CASH_DIVIDEND',
          effectiveDate: dateStr,
          settleDate: settleDateStr || null,
          ticker: null,
          shares: null,
          price: null,
          amount,
          fees: Math.abs(feesAndComm),
          rowIndex: ledgerRowIndex++,
          sourceBroker: 'schwab',
          rawAction: action,
        });
      }
      return;
    }
    if (
      actionLower === 'wire funds' ||
      actionLower === 'wire funds received' ||
      actionLower === 'moneylink transfer'
    ) {
      if (amount != null) {
        ledgerEvents.push({
          eventType: amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL',
          effectiveDate: dateStr,
          settleDate: settleDateStr || null,
          ticker: null,
          shares: null,
          price: null,
          amount,
          fees: Math.abs(feesAndComm),
          rowIndex: ledgerRowIndex++,
          sourceBroker: 'schwab',
          rawAction: action,
        });
      }
      return;
    }
    if (actionLower === 'bank interest' || actionLower === 'credit interest' || actionLower === 'margin interest') {
      if (amount != null) {
        ledgerEvents.push({
          eventType: 'INTEREST',
          effectiveDate: dateStr,
          settleDate: settleDateStr || null,
          ticker: null,
          shares: null,
          price: null,
          amount,
          fees: Math.abs(feesAndComm),
          rowIndex: ledgerRowIndex++,
          sourceBroker: 'schwab',
          rawAction: action,
        });
      }
      return;
    }
    if (actionLower === 'foreign tax paid' || actionLower === 'adr mgmt fee' || actionLower === 'service fee') {
      if (amount != null) {
        ledgerEvents.push({
          eventType: 'FEE',
          effectiveDate: dateStr,
          settleDate: settleDateStr || null,
          ticker: null,
          shares: null,
          price: null,
          amount: amount > 0 ? -amount : amount, // Schwab exports fees as positive; negate for cash-out convention
          fees: Math.abs(feesAndComm || amount),
          rowIndex: ledgerRowIndex++,
          sourceBroker: 'schwab',
          rawAction: action,
        });
      }
      return;
    }
    if (ignoreActions.has(actionLower)) return;

    const ticker = String(row['Symbol'] || '').trim().toUpperCase();
    if (!ticker || !isValidTicker(ticker)) return;

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
      if (actionLower === 'reinvest shares') {
        ledgerEvents.push({
          eventType: 'DIV_REINVEST',
          effectiveDate: dateStr,
          settleDate: settleDateStr || null,
          ticker,
          shares: qty,
          price,
          amount: 0,
          fees: Math.abs(feesAndComm),
          rowIndex: ledgerRowIndex++,
          sourceBroker: 'schwab',
          rawAction: action,
        });
      }
    } else if (actionLower === 'sell') {
      if (!Number.isFinite(qty) || qty <= 0) {
        warnings.push({ rowNumber: originalRowNum, message: `Skipped ${ticker} Sell — invalid qty` });
        return;
      }
      if (pos.shares <= 0) {
        warnings.push({ rowNumber: originalRowNum, message: `${ticker} sell without open position (pre-CSV holding)` });
      } else {
        const avgBefore = pos.totalCost / pos.shares;
        pos.shares -= qty;
        if (pos.shares <= 0.001) {
          pos.shares = 0;
          pos.totalCost = 0;
        } else {
          pos.totalCost = pos.shares * avgBefore;
        }
      }
      // Always record sell trades — position may have been held before CSV period
      trades.push({ date: dateStr, ticker, type: 'sell', shares: qty, price: Number.isFinite(price) ? price : 0, rowIndex: tradeRowIndex++, sourceBroker: 'schwab', rawAction: action });
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

  return { parsed, warnings, trades, ledgerEvents };
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
        ledgerEvents: robinhoodResult.ledgerEvents,
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
        ledgerEvents: schwabResult.ledgerEvents,
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

    function inferLedgerEventType(actionText: string, amount: number | null): string | null {
      const lower = actionText.toLowerCase().trim();
      if (!lower) {
        if (amount != null && amount > 0) return 'DEPOSIT';
        if (amount != null && amount < 0) return 'WITHDRAWAL';
        return null;
      }
      if (lower.includes('dividend') || lower.includes('cash div') || lower === 'cdiv') return 'CASH_DIVIDEND';
      if (lower.includes('interest') || lower.includes('gdbp')) return 'INTEREST';
      if (lower.includes('fee') || lower.includes('tax') || lower.includes('withholding')) return 'FEE';
      if (lower.includes('deposit') || lower.includes('wire') || lower.includes('ach')) return 'DEPOSIT';
      if (lower.includes('withdraw')) return 'WITHDRAWAL';
      if (lower.includes('reinvest')) return 'DIV_REINVEST';
      return null;
    }

    const positions = new Map<string, { shares: number; totalCost: number }>();
    const warnings: { rowNumber: number; message: string }[] = [];
    const trades: ImportTradeRecord[] = [];
    const ledgerEvents: ImportLedgerEventRecord[] = [];
    let tradeRowIndex = 0;
    let ledgerRowIndex = 0;

    // Snapshot detection: if no action column AND no totalAmount column, this is a
    // portfolio snapshot (current positions), not transaction history. Build positions
    // directly without trade inference — avoids "unsupported_action" skips.
    const isSnapshotImport = !mappings.action && !mappings.totalAmount;

    if (isSnapshotImport) {
      const excludedRowSet = new Set(
        JSON.parse(req.body.excludedRows || '[]')
      );

      data.forEach((row, idx) => {
        if (excludedRowSet.has(idx)) {
          incSkip('excluded_by_user');
          return;
        }
        const ticker = String(row[mappings.ticker] || '').trim().toUpperCase();
        if (!ticker || !isValidTicker(ticker)) {
          incSkip('invalid_ticker');
          warnings.push({ rowNumber: idx + 1, message: `Invalid ticker: '${ticker}'` });
          return;
        }
        const price = mappings.price ? parseNumber(row[mappings.price]) : null;
        const shares = mappings.shares ? parseNumber(row[mappings.shares]) : null;
        if (shares == null || shares <= 0) {
          incSkip('invalid_qty_price');
          warnings.push({ rowNumber: idx + 1, message: `Invalid shares for ${ticker}` });
          return;
        }
        const finalPrice = price != null && price >= 0 ? price : 0;
        const pos = positions.get(ticker) || { shares: 0, totalCost: 0 };
        pos.shares += shares;
        pos.totalCost += shares * finalPrice;
        positions.set(ticker, pos);
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
        trades: [],
        ledgerEvents: [],
        totalRows: data.length,
        validRows: parsed.length,
        skippedRows: Object.values(skipReasons).reduce((a, b) => a + b, 0),
        warning: `Snapshot import — ${parsed.length} positions from ${data.length} rows`,
        telemetry: {
          rowsParsed: data.length,
          rowsSkipped: Object.values(skipReasons).reduce((a, b) => a + b, 0),
          skipReasons,
          brokerDetected: sourceBroker,
          parseDurationMs,
        },
      });
      return;
    }

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

      // Action/amount are needed early for cash-only ledger events
      const rawAction = mappings.action ? String(row[mappings.action] || '').trim() : '';
      const totalAmount = mappings.totalAmount ? parseNumber(row[mappings.totalAmount]) : null;
      const earlyLedgerType = inferLedgerEventType(rawAction, totalAmount);

      // Extract ticker
      const ticker = String(row[mappings.ticker] || '').trim().toUpperCase();
      if (!ticker || !isValidTicker(ticker)) {
        if (earlyLedgerType && earlyLedgerType !== 'DIV_REINVEST' && totalAmount != null) {
          const effectiveDate = mappings.date
            ? String(row[mappings.date] || '').trim()
            : new Date().toLocaleDateString('en-US');
          if (mappings.date && isNaN(new Date(effectiveDate).getTime())) {
            incSkip('invalid_date');
            warnings.push({ rowNumber: rowNum, message: `Invalid date: '${effectiveDate}' for cash event` });
            return;
          }
          ledgerEvents.push({
            eventType: earlyLedgerType,
            effectiveDate,
            settleDate: null,
            ticker: null,
            shares: null,
            price: null,
            amount: earlyLedgerType === 'FEE' && totalAmount > 0 ? -totalAmount : totalAmount,
            fees: earlyLedgerType === 'FEE' ? Math.abs(totalAmount) : 0,
            rowIndex: ledgerRowIndex++,
            sourceBroker,
            rawAction: rawAction || 'mapped',
          });
          return;
        }
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
        const candidateLedgerType = inferLedgerEventType(rawAction, totalAmount);
        if (!(candidateLedgerType && totalAmount != null)) {
          incSkip('missing_numeric');
          warnings.push({ rowNumber: rowNum, message: `Missing price and shares for ${ticker}` });
          return;
        }
      }

      finalPrice = finalPrice ?? 0;
      finalShares = finalShares ?? 0;
      if (finalPrice < 0) finalPrice = Math.abs(finalPrice);   // accounting format e.g. ($500)
      if (finalShares < 0) finalShares = Math.abs(finalShares);

      // Infer action
      const inferredType = inferType(rawAction, totalAmount);
      if (inferredType == null || !CANONICAL_TYPES.has(inferredType)) {
        const ledgerType = inferLedgerEventType(rawAction, totalAmount);
        if (ledgerType && totalAmount != null) {
          ledgerEvents.push({
            eventType: ledgerType,
            effectiveDate: dateStr,
            settleDate: null,
            ticker,
            shares: ledgerType === 'DIV_REINVEST' ? finalShares : null,
            price: ledgerType === 'DIV_REINVEST' ? finalPrice : null,
            amount: ledgerType === 'FEE' && totalAmount > 0 ? -totalAmount : totalAmount,
            fees: ledgerType === 'FEE' ? Math.abs(totalAmount) : 0,
            rowIndex: ledgerRowIndex++,
            sourceBroker,
            rawAction: rawAction || 'mapped',
          });
          return;
        }
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
      ledgerEvents,
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
    const { holdings, mode, trades, ledgerEvents, marginDebt } = req.body as {
      holdings?: any[];
      mode?: 'replace' | 'merge' | 'incremental';
      trades?: any[];
      ledgerEvents?: any[];
      marginDebt?: number;
    };
    if (mode !== 'replace' && mode !== 'merge' && mode !== 'incremental') {
      res.status(400).json({ error: 'mode must be replace, merge, or incremental' });
      return;
    }
    // Validate: need either holdings or trades (or both)
    const hasHoldings = Array.isArray(holdings) && holdings.length > 0;
    const hasTradesToProcess = Array.isArray(trades) && trades.length > 0;
    if (!hasHoldings && !hasTradesToProcess) {
      res.status(400).json({ error: 'Must provide either holdings or trades' });
      return;
    }

    const existingHoldings = await prisma.holding.findMany({
      where: { userId: req.user!.userId },
      select: { ticker: true, shares: true, averageCost: true },
    });
    const existingSet = new Set(existingHoldings.map(h => h.ticker.toUpperCase()));
    const existingMap = new Map(existingHoldings.map(h => [h.ticker.toUpperCase(), { shares: h.shares, averageCost: h.averageCost }]));

    const normalized = (Array.isArray(holdings) ? holdings : []).map((h) => ({
      ticker: String(h.ticker || '').trim().toUpperCase(),
      shares: Number(h.shares),
      averageCost: Number(h.averageCost),
    })).filter(h => isValidTicker(h.ticker) && h.shares > 0 && Number.isFinite(h.averageCost) && h.averageCost >= 0);

    if (normalized.length === 0 && !hasTradesToProcess) {
      res.status(400).json({ error: 'No valid holdings or trades found' });
      return;
    }

    let added = 0;
    let updated = 0;
    let removed = 0;

    if (mode === 'replace') {
      removed = existingHoldings.length;
      added = normalized.length;
      updated = 0;
    } else if (mode === 'incremental') {
      // Stats calculated after applying trades below
    } else {
      added = normalized.filter(h => !existingSet.has(h.ticker)).length;
      updated = normalized.filter(h => existingSet.has(h.ticker)).length;
    }

    // Generate a unique sourceFileId for this import batch if any events exist
    const hasTrades = Array.isArray(trades) && trades.length > 0;
    const hasLedgerEvents = Array.isArray(ledgerEvents) && ledgerEvents.length > 0;
    const { randomUUID } = await import('crypto');
    const sourceFileId = hasTrades || hasLedgerEvents ? randomUUID() : null;

    const tradeRecords = (Array.isArray(trades) ? trades : [])
      .filter((t: any) => t.date && t.ticker && t.type)
      .map((t: any, idx: number) => ({
        userId: req.user!.userId,
        date: new Date(t.date),
        ticker: String(t.ticker).trim().toUpperCase(),
        type: String(t.type),
        shares: Number(t.shares) || 0,
        price: Number(t.price) || 0,
        rowIndex: Number.isFinite(Number(t.rowIndex)) ? Number(t.rowIndex) : idx,
        sourceFileId,
        sourceBroker: normalizeSourceBroker(t.sourceBroker),
        rawAction: typeof t.rawAction === 'string' ? t.rawAction : null,
      }))
      .filter(t => !isNaN(t.date.getTime()) && isValidTicker(t.ticker));

    const ledgerRecords = (Array.isArray(ledgerEvents) ? ledgerEvents : [])
      .filter((e: any) => e.effectiveDate && e.eventType)
      .map((e: any, idx: number) => {
        const effectiveDate = new Date(e.effectiveDate);
        const settleDate = e.settleDate ? new Date(e.settleDate) : null;
        return {
          userId: req.user!.userId,
          eventType: String(e.eventType),
          effectiveDate,
          settleDate: settleDate && !isNaN(settleDate.getTime()) ? settleDate : null,
          ticker: typeof e.ticker === 'string' && isValidTicker(String(e.ticker).trim().toUpperCase())
            ? String(e.ticker).trim().toUpperCase()
            : null,
          shares: Number.isFinite(Number(e.shares)) ? Number(e.shares) : null,
          price: Number.isFinite(Number(e.price)) ? Number(e.price) : null,
          amount: Number(e.amount) || 0,
          fees: Number(e.fees) || 0,
          rowIndex: Number.isFinite(Number(e.rowIndex)) ? Number(e.rowIndex) : idx,
          sourceFileId,
          sourceBroker: normalizeSourceBroker(e.sourceBroker),
          rawAction: typeof e.rawAction === 'string' ? e.rawAction : null,
        };
      })
      .filter(e => !isNaN(e.effectiveDate.getTime()) && isValidLedgerEventType(e.eventType));

    // --- Incremental preflight guards (watermark, broker consistency, oversell) ---
    let skippedDuplicates = 0;
    if (mode === 'incremental' && tradeRecords.length > 0) {
      // 1. Broker consistency: all incoming trades must share one broker
      const incomingBrokers = new Set(tradeRecords.map(t => t.sourceBroker).filter(Boolean));
      if (incomingBrokers.size > 1) {
        res.status(400).json({
          error: 'INCREMENTAL_MIXED_BROKERS',
          message: `Incremental import requires all trades from a single broker. Found: ${[...incomingBrokers].join(', ')}`,
        });
        return;
      }
      const incomingBroker = [...incomingBrokers][0] || 'unknown';

      // 2. Watermark guard: incoming trades must be strictly AFTER the last imported
      // trade for this broker. Prevents partial-history overlap → double-counting.
      const lastImportedTrade = await prisma.portfolioTrade.findFirst({
        where: { userId: req.user!.userId, sourceBroker: incomingBroker },
        orderBy: { date: 'desc' },
        select: { date: true },
      });
      if (lastImportedTrade) {
        const incomingMinDate = new Date(Math.min(...tradeRecords.map(t => t.date.getTime())));
        if (incomingMinDate <= lastImportedTrade.date) {
          res.status(400).json({
            error: 'INCREMENTAL_OVERLAP',
            message: `Incoming trades overlap with existing data. Earliest incoming: ${incomingMinDate.toISOString().slice(0, 10)}, latest existing: ${lastImportedTrade.date.toISOString().slice(0, 10)}. Use "Replace All" to re-import full history, or export only dates after ${lastImportedTrade.date.toISOString().slice(0, 10)}.`,
            existingMaxDate: lastImportedTrade.date.toISOString().slice(0, 10),
            incomingMinDate: incomingMinDate.toISOString().slice(0, 10),
          });
          return;
        }
      }

      // 3. Dedup: fingerprint existing trades to skip re-uploads
      const existingTrades = await prisma.portfolioTrade.findMany({
        where: { userId: req.user!.userId },
        select: { date: true, ticker: true, type: true, shares: true, price: true, sourceBroker: true },
      });
      const existingFingerprints = new Set(
        existingTrades.map(t => `${t.date.toISOString().slice(0, 10)}|${t.ticker}|${t.type}|${t.shares}|${t.price}|${t.sourceBroker ?? ''}`)
      );
      const originalCount = tradeRecords.length;
      const dedupedTrades = tradeRecords.filter(t => {
        const fp = `${t.date.toISOString().slice(0, 10)}|${t.ticker}|${t.type}|${t.shares}|${t.price}|${t.sourceBroker ?? ''}`;
        return !existingFingerprints.has(fp);
      });
      skippedDuplicates = originalCount - dedupedTrades.length;
      if (skippedDuplicates > 0) {
        console.log(`[Import] Incremental dedup: skipped ${skippedDuplicates} duplicate trades`);
      }
      tradeRecords.splice(0, tradeRecords.length, ...dedupedTrades);

      // Dedup ledger events
      if (ledgerRecords.length > 0) {
        const existingLedger = await prisma.ledgerEvent.findMany({
          where: { userId: req.user!.userId },
          select: { effectiveDate: true, eventType: true, ticker: true, amount: true, sourceBroker: true },
        });
        const ledgerFingerprints = new Set(
          existingLedger.map(e => `${e.effectiveDate.toISOString().slice(0, 10)}|${e.eventType}|${e.ticker ?? ''}|${e.amount}|${e.sourceBroker ?? ''}`)
        );
        const originalLedgerCount = ledgerRecords.length;
        const dedupedLedger = ledgerRecords.filter(e => {
          const fp = `${e.effectiveDate.toISOString().slice(0, 10)}|${e.eventType}|${e.ticker ?? ''}|${e.amount}|${e.sourceBroker ?? ''}`;
          return !ledgerFingerprints.has(fp);
        });
        const ledgerDupCount = originalLedgerCount - dedupedLedger.length;
        if (ledgerDupCount > 0) {
          console.log(`[Import] Incremental dedup: skipped ${ledgerDupCount} duplicate ledger events`);
        }
        ledgerRecords.splice(0, ledgerRecords.length, ...dedupedLedger);
      }

      // 4. Strict oversell check — hard 400, no DB writes, no clamping
      const simPositions = new Map(
        [...existingMap.entries()].map(([ticker, pos]) => [ticker, { shares: pos.shares, averageCost: pos.averageCost }])
      );
      const sortedForValidation = [...tradeRecords].sort((a, b) => a.date.getTime() - b.date.getTime());
      const oversellErrors: string[] = [];

      for (const t of sortedForValidation) {
        const pos = simPositions.get(t.ticker) || { shares: 0, averageCost: 0 };
        if (t.type === 'buy') {
          pos.shares += t.shares;
        } else if (t.type === 'sell') {
          if (t.shares > pos.shares + 0.001) {
            oversellErrors.push(`Cannot sell ${t.shares} shares of ${t.ticker} (only ${pos.shares.toFixed(4)} held)`);
          }
          pos.shares -= t.shares;
        }
        simPositions.set(t.ticker, pos);
      }

      if (oversellErrors.length > 0) {
        res.status(400).json({
          error: 'OVERSELL_DETECTED',
          message: `Oversell detected: ${oversellErrors[0]}${oversellErrors.length > 1 ? ` (+${oversellErrors.length - 1} more)` : ''}`,
          details: oversellErrors,
        });
        return;
      }

      // If all trades were duplicates, nothing to do
      if (tradeRecords.length === 0 && ledgerRecords.length === 0) {
        res.json({ added: 0, updated: 0, removed: 0, skippedDuplicates });
        return;
      }
    }

    // --- Replace mode dedup: skip re-inserting identical trades ---
    if (mode === 'replace' && tradeRecords.length > 0) {
      const existingTrades = await prisma.portfolioTrade.findMany({
        where: { userId: req.user!.userId },
        select: { date: true, ticker: true, type: true, shares: true, price: true, sourceBroker: true },
      });
      const existingFingerprints = new Set(
        existingTrades.map(t => `${t.date.toISOString().slice(0, 10)}|${t.ticker}|${t.type}|${t.shares}|${t.price}|${t.sourceBroker ?? ''}`)
      );
      const originalCount = tradeRecords.length;
      const dedupedTrades = tradeRecords.filter(t => {
        const fp = `${t.date.toISOString().slice(0, 10)}|${t.ticker}|${t.type}|${t.shares}|${t.price}|${t.sourceBroker ?? ''}`;
        return !existingFingerprints.has(fp);
      });
      skippedDuplicates = originalCount - dedupedTrades.length;
      if (skippedDuplicates > 0) {
        console.log(`[Import] Replace dedup: skipped ${skippedDuplicates} duplicate trades`);
      }
      tradeRecords.splice(0, tradeRecords.length, ...dedupedTrades);
    }

    await prisma.$transaction(async (tx) => {
      if (mode === 'replace') {
        // Delete all holdings — will be re-created below
        await tx.holding.deleteMany({ where: { userId: req.user!.userId } });
      }

      // Determine import strategy
      const useTradeReplay = mode === 'incremental';
      // Replace All with trades but no positions: build holdings directly from trade data
      const useTradesAsPositions = mode === 'replace' && normalized.length === 0 && hasTradesToProcess;

      if (useTradesAsPositions) {
        // User uploaded a portfolio snapshot that was parsed as trades.
        // Build holdings directly from the trade data (ticker + shares + price = avg cost).
        const positionMap = new Map<string, { shares: number; totalCost: number }>();
        const rawTrades = Array.isArray(trades) ? trades : [];
        console.log(`[Import] useTradesAsPositions: ${rawTrades.length} raw trades`);
        for (const t of rawTrades) {
          const ticker = String(t.ticker || '').trim().toUpperCase();
          if (!isValidTicker(ticker)) {
            console.log(`[Import] skipped invalid ticker: '${ticker}'`);
            continue;
          }
          const shares = Number(t.shares) || 0;
          const price = Number(t.price) || 0;
          if (shares <= 0) {
            console.log(`[Import] skipped ${ticker}: shares=${t.shares} → ${shares}`);
            continue;
          }
          const existing = positionMap.get(ticker) || { shares: 0, totalCost: 0 };
          existing.shares += shares;
          existing.totalCost += shares * price;
          positionMap.set(ticker, existing);
        }
        console.log(`[Import] useTradesAsPositions: ${positionMap.size} tickers in positionMap`);

        for (const [ticker, pos] of positionMap) {
          const averageCost = pos.shares > 0 ? pos.totalCost / pos.shares : 0;
          await tx.holding.create({
            data: { userId: req.user!.userId, ticker, shares: pos.shares, averageCost },
          });
          added++;
        }

        // Save trade records (deduped) and ledger events
        if (tradeRecords.length > 0) {
          await tx.portfolioTrade.createMany({ data: tradeRecords });
        }
        if (ledgerRecords.length > 0) {
          await tx.ledgerEvent.createMany({ data: ledgerRecords });
        }
      } else if (useTradeReplay) {
        // Insert new (non-duplicate) trade records first
        if (tradeRecords.length > 0) {
          await tx.portfolioTrade.createMany({ data: tradeRecords });
        }
        if (ledgerRecords.length > 0) {
          await tx.ledgerEvent.createMany({ data: ledgerRecords });
        }

        // Apply NEW trades as deltas to current positions.
        // Start from existing holding (not zero) because the CSV may be partial
        // history — the user may hold shares acquired before the CSV period.
        const tickerTrades = new Map<string, typeof tradeRecords>();
        for (const t of tradeRecords) {
          const arr = tickerTrades.get(t.ticker) || [];
          arr.push(t);
          tickerTrades.set(t.ticker, arr);
        }

        for (const [ticker, trs] of tickerTrades) {
          const sorted = [...trs].sort((a, b) => {
            const d = a.date.getTime() - b.date.getTime();
            if (d !== 0) return d;
            return (a.rowIndex ?? 0) - (b.rowIndex ?? 0);
          });

          const existing = existingMap.get(ticker);
          let shares = existing?.shares ?? 0;
          let averageCost = existing?.averageCost ?? 0;

          for (const t of sorted) {
            if (t.type === 'buy') {
              const totalCostBefore = shares * averageCost;
              const newCost = t.shares * t.price;
              shares += t.shares;
              averageCost = shares > 0 ? (totalCostBefore + newCost) / shares : 0;
            } else if (t.type === 'sell') {
              shares -= t.shares;
              if (shares < 0.001) {
                shares = 0;
                averageCost = 0;
              }
            } else if (t.type === 'split' || t.type === 'transfer' || t.type === 'merger') {
              shares += t.shares;
            } else if (t.type === 'cancel') {
              shares -= t.shares;
              if (shares < 0.001) {
                shares = 0;
                averageCost = 0;
              }
            }
          }

          // Reconcile DB holding with updated position
          const hadHolding = existingSet.has(ticker);
          if (shares < 0.001) {
            if (hadHolding) {
              await tx.holding.deleteMany({ where: { userId: req.user!.userId, ticker } });
              removed++;
            }
          } else if (hadHolding) {
            await tx.holding.update({
              where: { userId_ticker: { userId: req.user!.userId, ticker } },
              data: { shares, averageCost },
            });
            updated++;
          } else {
            await tx.holding.create({
              data: { userId: req.user!.userId, ticker, shares, averageCost },
            });
            added++;
          }
        }

      } else {
        // Replace or Merge with position data: upsert from pre-calculated positions
        for (const h of normalized) {
          await tx.holding.upsert({
            where: { userId_ticker: { userId: req.user!.userId, ticker: h.ticker } },
            update: { shares: h.shares, averageCost: h.averageCost },
            create: {
              userId: req.user!.userId,
              ticker: h.ticker,
              shares: h.shares,
              averageCost: h.averageCost,
            },
          });
        }
      }

      // Insert trades/ledger (skip if already handled above)
      if (!useTradeReplay && !useTradesAsPositions) {
        if (tradeRecords.length > 0) {
          await tx.portfolioTrade.createMany({ data: tradeRecords });
        }
        if (ledgerRecords.length > 0) {
          await tx.ledgerEvent.createMany({ data: ledgerRecords });
        }
      }

      // Update margin debt if provided
      if (typeof marginDebt === 'number' && Number.isFinite(marginDebt) && marginDebt >= 0) {
        const rounded = Math.round(marginDebt * 100) / 100;
        await tx.userSettings.upsert({
          where: { userId: req.user!.userId },
          update: { marginDebt: rounded },
          create: { userId: req.user!.userId, marginDebt: rounded },
        });
      }
    });

    if (tradeRecords.length > 0) {
      console.log(`[Import] Saved ${tradeRecords.length} portfolio trades for user ${req.user!.userId}${sourceFileId ? ` (batch ${sourceFileId})` : ''}`);
    }
    if (ledgerRecords.length > 0) {
      console.log(`[Import] Saved ${ledgerRecords.length} ledger events for user ${req.user!.userId}${sourceFileId ? ` (batch ${sourceFileId})` : ''}`);
    }

    try {
      await recordCompositionChange(req.user!.userId, mode === 'replace' ? 'import_replace' : mode === 'incremental' ? 'import_incremental' : 'import_merge');
      await resetSnapshotsForCompositionChange(req.user!.userId);
    } catch (_err) {
      console.warn('[Snapshot] Reset failed after import confirm:');
    }

    res.json({ added, updated, removed, ...(skippedDuplicates > 0 ? { skippedDuplicates } : {}) });
  } catch (error) {
    if (error instanceof PlanLimitError) {
      res.status(403).json({ error: 'limit_reached', limit: error.limit, plan: error.plan });
      return;
    }
    console.error('Import confirm error:', error instanceof Error ? error.message : String(error));
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

    // Delete everything: holdings, trades, ledger events, snapshots (+ child holding snapshots)
    const userSnapshots = await prisma.portfolioSnapshot.findMany({
      where: { userId: req.user!.userId }, select: { id: true },
    });
    const snapshotIds = userSnapshots.map(s => s.id);
    const [deleted, tradesDeleted, ledgerDeleted, , snapshotsDeleted] = await prisma.$transaction([
      prisma.holding.deleteMany({ where: { userId: req.user!.userId } }),
      prisma.portfolioTrade.deleteMany({ where: { userId: req.user!.userId } }),
      prisma.ledgerEvent.deleteMany({ where: { userId: req.user!.userId } }),
      prisma.holdingSnapshot.deleteMany({ where: { snapshotId: { in: snapshotIds } } }),
      prisma.portfolioSnapshot.deleteMany({ where: { userId: req.user!.userId } }),
    ]);
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
    console.log(`[Clear] userId=${req.user!.userId.slice(0, 8)} holdings=${deleted.count} trades=${tradesDeleted.count} ledger=${ledgerDeleted.count} snapshots=${snapshotsDeleted.count}`);

    res.json({ cleared: true, holdingsRemoved: deleted.count, tradesRemoved: tradesDeleted.count, ledgerEventsRemoved: ledgerDeleted.count });
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

export async function getAccountHistoryHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 30, 1), 100);
    const cursor = req.query.cursor as string | undefined;
    const category = req.query.category as HistoryCategory | undefined;
    const ticker = req.query.ticker as string | undefined;

    // Validate category if provided
    if (category && !['trade', 'cash', 'adjustment'].includes(category)) {
      res.status(400).json({ error: 'Invalid category. Must be one of: trade, cash, adjustment' });
      return;
    }

    const result = await getAccountHistory({ userId, limit, cursor, category, ticker });
    res.json(result);
  } catch (_error) {
    console.error('Error fetching account history:');
    res.status(500).json({ error: 'Failed to fetch account history' });
  }
}

