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
import { createSnapshotIfNeeded, createUserSnapshotIfNeeded, getAllSnapshots, getSnapshotsAfter, reconstructPortfolioHistory, reconstructPortfolioHistoryHiRes, resetSnapshotsForCompositionChange, recordCompositionChange, getLatestCompositionChangeAfter } from '../services/snapshot.service';
import { extractBestOcrForHoldings, parseHoldingsFromText } from '../services/screenshot-ocr.service';
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
import prisma from '../utils/prisma';
import { parse as parseCsv } from 'csv-parse/sync';
import {
  addHoldingSchema,
  removeHoldingParamsSchema,
  removeHoldingQuerySchema,
  setCashBalanceSchema,
} from '../validators/portfolio.validators';
import { PlanLimitError } from '../utils/plan-limit.error';

const SYSTEM_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

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
      await createSnapshotIfNeeded();
      portfolio = await getPortfolio();
    }

    // Calculate pace projections (uses totalAssets - assets only, no margin)
    const paceProjection = await getPaceProjection(portfolio.netEquity);

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
    const existingHoldings = await getHoldings();
    const existingHolding = existingHoldings.find(h => h.ticker === ticker.toUpperCase());

    const holding = await upsertHolding({ ticker, shares, averageCost });
    try {
      await recordCompositionChange('holding_update');
      await resetSnapshotsForCompositionChange();
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
          userId: req.user?.userId,
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
    const existingHoldings = await getHoldings();
    const existingHolding = existingHoldings.find(h => h.ticker === ticker);
    const costBasis = existingHolding ? existingHolding.shares * existingHolding.averageCost : 0;

    await deleteHolding(ticker);
    try {
      await recordCompositionChange('holding_remove');
      await resetSnapshotsForCompositionChange();
    } catch (_err) {
      console.warn('[Snapshot] Reset failed after holding removal:');
    }

    // Auto-create withdrawal transaction for TWR tracking
    if (!skipTransaction && costBasis >= 0.01) {
      await addTransaction({
        type: 'withdrawal',
        amount: costBasis,
        date: new Date().toISOString(),
      });
      console.log(`[Holding] Auto-created withdrawal for removing ${ticker}`);
    }

    // Fire activity event using authenticated user ID
    const authUserId = req.user?.userId;
    if (authUserId) {
      createActivityEvent(authUserId, 'holding_removed', { ticker }).catch(() => {});
    }

    res.status(204).send();
  } catch (error: any) {
    if (error?.code === 'P2025') {
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

    const settings = await updateCashBalance(cashBalance);
    res.json({ cashBalance: settings.cashBalance });
  } catch (_error) {
    console.error('Error updating cash balance:');
    res.status(500).json({ error: 'Failed to update cash balance' });
  }
}

export async function getHistory(req: Request, res: Response): Promise<void> {
  try {
    const snapshots = await getAllSnapshots();
    res.json(snapshots);
  } catch (_error) {
    console.error('Error fetching history:');
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
  } catch (_error) {
    console.error('Error calculating projections:');
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

      // Fill the gap between last Yahoo candle (~15min delayed) and now
      // using recent snapshots recorded every 60 seconds.
      // Cap at 4 hours to avoid bridging across overnight/weekend/holiday gaps —
      // Yahoo candles already contain the complete last trading session.
      if (points.length > 0) {
        const lastCandleTime = points[points.length - 1].time;
        const gapMs = now - lastCandleTime;
        if (gapMs > 5 * 60 * 1000 && gapMs < 4 * 3600000) {
          const snapshots = await getSnapshotsAfter(new Date(lastCandleTime));
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
      const rangeStart = new Date(now - 24 * 60 * 60 * 1000);
      const latestChange = await getLatestCompositionChangeAfter(rangeStart);
      if (latestChange) {
        const cutoff = latestChange.getTime();
        points = points.filter(p => p.time >= cutoff);
      }

      const periodStartValue = latestChange
        ? (points.length > 0 ? points[0].value : liveValue)
        : (previousCloseValue || (points.length > 0 ? points[0].value : liveValue));

      res.json({ points, periodStartValue, period: '1D' });
      return;
    }

    const holdings = await getHoldings();
    const now = Date.now();
    let points: { time: number; value: number }[];

    // Use high-resolution data for short periods (like Robinhood)
    if (period === '1W') {
      // 15-min candles for 5 days â†’ ~130 points per ticker
      points = await reconstructPortfolioHistoryHiRes(
        holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
        portfolio.cashBalance, portfolio.marginDebt, '5d', '15m',
      );
    } else if (period === '1M') {
      // 1-hour candles for 1 month â†’ ~150 points per ticker
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

    // Rebaseline to latest composition change within the window to avoid false jumps.
    if (points.length > 0) {
      const windowStart = new Date(points[0].time);
      const latestChange = await getLatestCompositionChangeAfter(windowStart);
      if (latestChange) {
        const cutoff = latestChange.getTime();
        points = points.filter(p => p.time >= cutoff);
      }
    }

    const periodStartValue = points.length > 0 ? points[0].value : portfolio.totalAssets;

    res.json({ points, periodStartValue, period });
  } catch (_error) {
    console.error('Error fetching chart data:');
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

    const result = await getPerformanceComparison(window, benchmark, userId || null);
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

function parseNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,]/g, '').trim();
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function isValidTicker(ticker: string): boolean {
  return /^[A-Z]{1,5}$/.test(ticker);
}

export async function importPortfolioCsvHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file || !file.buffer) {
      res.status(400).json({ error: 'CSV file is required (field name: file)' });
      return;
    }

    const csvText = file.buffer.toString('utf8');
    const data = parseCsv(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, unknown>[];
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

export async function confirmPortfolioImportHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { holdings, mode } = req.body as { holdings?: any[]; mode?: 'replace' | 'merge' };
    if (!Array.isArray(holdings) || holdings.length === 0) {
      res.status(400).json({ error: 'holdings must be a non-empty array' });
      return;
    }
    if (mode !== 'replace' && mode !== 'merge') {
      res.status(400).json({ error: 'mode must be replace or merge' });
      return;
    }

    const existingHoldings = await prisma.holding.findMany({
      where: { userId: SYSTEM_USER_ID },
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

      await prisma.holding.deleteMany({ where: { userId: SYSTEM_USER_ID } });
    } else {
      added = normalized.filter(h => !existingSet.has(h.ticker)).length;
      updated = normalized.filter(h => existingSet.has(h.ticker)).length;
    }

    for (const h of normalized) {
      await upsertHolding(
        { ticker: h.ticker, shares: h.shares, averageCost: h.averageCost },
        SYSTEM_USER_ID
      );
    }
    try {
      await recordCompositionChange(mode === 'replace' ? 'import_replace' : 'import_merge');
      await resetSnapshotsForCompositionChange();
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

    const deleted = await prisma.holding.deleteMany({ where: { userId: SYSTEM_USER_ID } });
    await prisma.userSettings.upsert({
      where: { userId: SYSTEM_USER_ID },
      update: { cashBalance: 0, marginDebt: 0 },
      create: { userId: SYSTEM_USER_ID, cashBalance: 0, marginDebt: 0 },
    });
    try {
      await recordCompositionChange('portfolio_clear');
      await resetSnapshotsForCompositionChange();
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

