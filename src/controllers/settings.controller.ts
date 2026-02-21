import { Request, Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types/auth';
import {
  getSettings,
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
  } catch (_error) {
    console.error('Error fetching settings:');
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

    res.json({
      cashBalance: Math.round(userSettings.cashBalance * 100) / 100,
      marginDebt: Math.round((userSettings.marginDebt ?? 0) * 100) / 100,
      cashInterestRate: Math.round((userSettings.cashInterestRate ?? 0) * 100) / 100,
    });
  } catch (_error) {
    console.error('Error updating settings:');
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
  } catch (_error) {
    console.error('Error setting baseline:');
    res.status(500).json({ error: 'Failed to set baseline' });
  }
}

export async function setBrokerLifetimeHandler(req: Request, res: Response): Promise<void> {
  try {
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

    const settings = await setBrokerLifetime({
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
  } catch (_error) {
    console.error('Error setting broker lifetime:');
    res.status(500).json({ error: 'Failed to set broker lifetime data' });
  }
}

export async function clearBrokerLifetimeHandler(req: Request, res: Response): Promise<void> {
  try {
    await clearBrokerLifetime();
    res.status(204).send();
  } catch (_error) {
    console.error('Error clearing broker lifetime:');
    res.status(500).json({ error: 'Failed to clear broker lifetime data' });
  }
}

export async function getYtdHandler(req: Request, res: Response): Promise<void> {
  try {
    const settings = await getSettings();
    res.json({
      ytdStartEquity: settings.ytdStartEquity ?? null,
      ytdNetContributions: settings.ytdNetContributions ?? null,
    });
  } catch (_error) {
    console.error('Error fetching YTD settings:');
    res.status(500).json({ error: 'Failed to fetch YTD settings' });
  }
}

export async function setYtdHandler(req: Request, res: Response): Promise<void> {
  try {
    const { ytdStartEquity, netContributionsYTD } = req.body;

    if (typeof ytdStartEquity !== 'number' || ytdStartEquity <= 0) {
      res.status(400).json({ error: 'Invalid ytdStartEquity: must be a positive number' });
      return;
    }

    if (netContributionsYTD !== undefined && typeof netContributionsYTD !== 'number') {
      res.status(400).json({ error: 'Invalid netContributionsYTD: must be a number' });
      return;
    }

    const settings = await setYtdData({ ytdStartEquity, netContributionsYTD });
    res.json({
      message: 'YTD data saved',
      ytdStartEquity: settings.ytdStartEquity,
      ytdNetContributions: settings.ytdNetContributions,
    });
  } catch (_error) {
    console.error('Error setting YTD data:');
    res.status(500).json({ error: 'Failed to set YTD data' });
  }
}

export async function clearYtdHandler(req: Request, res: Response): Promise<void> {
  try {
    await clearYtdData();
    res.status(204).send();
  } catch (_error) {
    console.error('Error clearing YTD data:');
    res.status(500).json({ error: 'Failed to clear YTD data' });
  }
}

export async function getSummaryHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const summary = await getPerformanceSummary(userId);
    res.json(summary);
  } catch (_error) {
    console.error('Error fetching summary:');
    res.status(500).json({ error: 'Failed to fetch performance summary' });
  }
}

export async function activateTrackingHandler(req: Request, res: Response): Promise<void> {
  try {
    const settings = await activateTracking();
    res.json({
      message: 'Tracking activated',
      trackingStartDate: settings.trackingStartDate,
    });
  } catch (_error) {
    console.error('Error activating tracking:');
    res.status(500).json({ error: 'Failed to activate tracking' });
  }
}

export async function restartTrackingHandler(req: Request, res: Response): Promise<void> {
  try {
    const settings = await restartTracking();
    res.json({
      message: 'Tracking restarted',
      trackingStartDate: settings.trackingStartDate,
    });
  } catch (_error) {
    console.error('Error restarting tracking:');
    res.status(500).json({ error: 'Failed to restart tracking' });
  }
}

export async function cleanupSnapshotsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const countBefore = await getSnapshotCount(userId);
    const deletedCount = await cleanupDuplicateSnapshots();
    const countAfter = await getSnapshotCount(userId);

    res.json({
      message: 'Snapshot cleanup completed',
      snapshotsBefore: countBefore,
      snapshotsDeleted: deletedCount,
      snapshotsAfter: countAfter,
    });
  } catch (_error) {
    console.error('Error cleaning up snapshots:');
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
  } catch (_error) {
    console.error('Error calculating cash interest accrual:');
    res.status(500).json({ error: 'Failed to calculate cash interest accrual' });
  }
}

