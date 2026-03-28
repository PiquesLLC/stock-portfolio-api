import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types/auth';
import {
  getTrackingSettings,
  setBaseline,
  setBrokerLifetime,
  clearBrokerLifetime,
  setYtdData,
  clearYtdData,
  getPerformanceSummary,
  activateTracking,
  restartTracking,
} from '../services/settings.service';
import { cleanupDuplicateSnapshots, getSnapshotCount } from '../services/snapshot.service';
import { validatePortfolioOwnership } from '../utils/validatePortfolioOwnership';



export async function getSettingsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const userSettings = await prisma.userSettings.findUnique({ where: { userId } });
    res.json({
      cashBalance: Math.round((userSettings?.cashBalance ?? 0) * 100) / 100,
      marginDebt: Math.round((userSettings?.marginDebt ?? 0) * 100) / 100,
      cashInterestRate: Math.round((userSettings?.cashInterestRate ?? 0) * 100) / 100,
    });
  } catch (error: unknown) {
    console.error('Error fetching settings:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
}

export async function updateSettingsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const userId = req.user.userId;
    const { cashBalance, marginDebt, cashInterestRate } = req.body;

    // Validate inputs if provided
    if (cashBalance !== undefined && (typeof cashBalance !== 'number' || cashBalance < 0)) {
      res.status(400).json({ error: 'Invalid cashBalance: must be a non-negative number' });
      return;
    }

    if (marginDebt !== undefined && (typeof marginDebt !== 'number' || marginDebt < 0)) {
      res.status(400).json({ error: 'Invalid marginDebt: must be a non-negative number' });
      return;
    }
    if (cashInterestRate !== undefined && (typeof cashInterestRate !== 'number' || cashInterestRate < 0 || cashInterestRate > 100)) {
      res.status(400).json({ error: 'Invalid cashInterestRate: must be between 0 and 100' });
      return;
    }

    if (cashBalance === undefined && marginDebt === undefined && cashInterestRate === undefined) {
      res.status(400).json({ error: 'At least one of cashBalance, marginDebt, or cashInterestRate must be provided' });
      return;
    }

    const roundedCash = cashBalance !== undefined ? Math.round(cashBalance * 100) / 100 : undefined;
    const roundedMargin = marginDebt !== undefined ? Math.round(marginDebt * 100) / 100 : undefined;
    const roundedRate = cashInterestRate !== undefined ? Math.round(cashInterestRate * 100) / 100 : undefined;

    const updateData: Record<string, number> = {};
    if (roundedCash !== undefined) updateData.cashBalance = roundedCash;
    if (roundedMargin !== undefined) updateData.marginDebt = roundedMargin;
    if (roundedRate !== undefined) updateData.cashInterestRate = roundedRate;

    const userSettings = await prisma.userSettings.upsert({
      where: { userId },
      update: updateData,
      create: {
        userId,
        cashBalance: roundedCash ?? 0,
        marginDebt: roundedMargin ?? 0,
        cashInterestRate: roundedRate ?? 0,
      },
    });

    // Also update the default Portfolio record (multi-portfolio reads from Portfolio table)
    if (roundedCash !== undefined || roundedMargin !== undefined) {
      const defaultPortfolio = await prisma.portfolio.findFirst({
        where: { userId, isDefault: true },
      });
      if (defaultPortfolio) {
        const portfolioUpdate: Record<string, number> = {};
        if (roundedCash !== undefined) portfolioUpdate.cashBalance = roundedCash;
        if (roundedMargin !== undefined) portfolioUpdate.marginDebt = roundedMargin;
        await prisma.portfolio.update({
          where: { id: defaultPortfolio.id },
          data: portfolioUpdate,
        });
      }
    }

    res.json({
      cashBalance: Math.round(userSettings.cashBalance * 100) / 100,
      marginDebt: Math.round((userSettings.marginDebt ?? 0) * 100) / 100,
      cashInterestRate: Math.round((userSettings.cashInterestRate ?? 0) * 100) / 100,
    });
  } catch (error: unknown) {
    console.error('Error updating settings:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to update settings' });
  }
}

export async function setBaselineHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { type } = req.body;

    if (!type || !['fresh_start', 'existing_portfolio'].includes(type)) {
      res.status(400).json({
        error: 'Invalid type. Must be "fresh_start" or "existing_portfolio"',
      });
      return;
    }

    const settings = await setBaseline(userId, { type });
    res.json({
      message: 'Baseline set successfully',
      trackingStartDate: settings.trackingStartDate,
      baselineTotalValue: settings.baselineTotalValue,
      baselineType: settings.baselineType,
    });
  } catch (error: unknown) {
    console.error('Error setting baseline:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to set baseline' });
  }
}

export async function setBrokerLifetimeHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { deposits, withdrawals, currentValue } = req.body;

    if (typeof deposits !== 'number' || deposits < 0) {
      res.status(400).json({ error: 'Invalid deposits: must be a non-negative number' });
      return;
    }

    if (withdrawals !== undefined && (typeof withdrawals !== 'number' || withdrawals < 0)) {
      res.status(400).json({ error: 'Invalid withdrawals: must be a non-negative number' });
      return;
    }

    if (typeof currentValue !== 'number' || currentValue < 0) {
      res.status(400).json({ error: 'Invalid currentValue: must be a non-negative number' });
      return;
    }

    const settings = await setBrokerLifetime(userId, {
      deposits,
      withdrawals: withdrawals ?? 0,
      currentValue,
    });

    res.json({
      message: 'Broker lifetime data saved',
      brokerLifetimeDeposits: settings.brokerLifetimeDeposits,
      brokerLifetimeWithdrawals: settings.brokerLifetimeWithdrawals,
      brokerLifetimeValue: settings.brokerLifetimeValue,
      brokerLifetimeAsOf: settings.brokerLifetimeAsOf,
    });
  } catch (error: unknown) {
    console.error('Error setting broker lifetime:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to set broker lifetime data' });
  }
}

export async function clearBrokerLifetimeHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    await clearBrokerLifetime(userId);
    res.status(204).send();
  } catch (error: unknown) {
    console.error('Error clearing broker lifetime:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to clear broker lifetime data' });
  }
}

export async function getYtdHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const settings = await getTrackingSettings(userId);
    res.json({
      ytdStartEquity: settings?.ytdStartEquity ?? null,
      ytdNetContributions: settings?.ytdNetContributions ?? null,
    });
  } catch (error: unknown) {
    console.error('Error fetching YTD settings:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch YTD settings' });
  }
}

export async function setYtdHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { ytdStartEquity, netContributionsYTD } = req.body;

    if (typeof ytdStartEquity !== 'number' || ytdStartEquity <= 0) {
      res.status(400).json({ error: 'Invalid ytdStartEquity: must be a positive number' });
      return;
    }

    if (netContributionsYTD !== undefined && typeof netContributionsYTD !== 'number') {
      res.status(400).json({ error: 'Invalid netContributionsYTD: must be a number' });
      return;
    }

    const settings = await setYtdData(userId, { ytdStartEquity, netContributionsYTD });
    res.json({
      message: 'YTD data saved',
      ytdStartEquity: settings.ytdStartEquity,
      ytdNetContributions: settings.ytdNetContributions,
    });
  } catch (error: unknown) {
    console.error('Error setting YTD data:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to set YTD data' });
  }
}

export async function clearYtdHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    await clearYtdData(userId);
    res.status(204).send();
  } catch (error: unknown) {
    console.error('Error clearing YTD data:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to clear YTD data' });
  }
}

export async function getSummaryHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const portfolioId = req.query.portfolioId as string | undefined;
    await validatePortfolioOwnership(portfolioId, userId);
    const summary = await getPerformanceSummary(userId, portfolioId);
    res.json(summary);
  } catch (error: unknown) {
    const status = (error as any)?.status;
    if (status === 404) {
      res.status(404).json({ error: 'Portfolio not found' });
      return;
    }
    console.error('Error fetching summary:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch performance summary' });
  }
}

export async function activateTrackingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const settings = await activateTracking(userId);
    res.json({
      message: 'Tracking activated',
      trackingStartDate: settings.trackingStartDate,
    });
  } catch (error: unknown) {
    console.error('Error activating tracking:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to activate tracking' });
  }
}

export async function restartTrackingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const settings = await restartTracking(userId);
    res.json({
      message: 'Tracking restarted',
      trackingStartDate: settings.trackingStartDate,
    });
  } catch (error: unknown) {
    console.error('Error restarting tracking:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to restart tracking' });
  }
}

export async function cleanupSnapshotsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const countBefore = await getSnapshotCount(userId);
    const deletedCount = await cleanupDuplicateSnapshots(userId);
    const countAfter = await getSnapshotCount(userId);

    res.json({
      message: 'Snapshot cleanup completed',
      snapshotsBefore: countBefore,
      snapshotsDeleted: deletedCount,
      snapshotsAfter: countAfter,
    });
  } catch (error: unknown) {
    console.error('Error cleaning up snapshots:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to cleanup snapshots' });
  }
}

export async function getCashInterestAccrualHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const userSettings = await prisma.userSettings.findUnique({ where: { userId } });
    const cashBalance = userSettings?.cashBalance ?? 0;
    const cashInterestRate = userSettings?.cashInterestRate ?? 0;

    const dailyAccrual = cashBalance * (cashInterestRate / 100) / 365;
    const annualAccrual = cashBalance * (cashInterestRate / 100);

    res.json({
      cashBalance: Math.round(cashBalance * 100) / 100,
      cashInterestRate: Math.round(cashInterestRate * 100) / 100,
      dailyAccrual: Math.round(dailyAccrual * 100) / 100,
      annualAccrual: Math.round(annualAccrual * 100) / 100,
      asOf: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error('Error calculating cash interest accrual:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to calculate cash interest accrual' });
  }
}
