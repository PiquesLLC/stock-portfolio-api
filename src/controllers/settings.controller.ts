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
import { updateSettings } from '../services/portfolio.service';
import { cleanupDuplicateSnapshots, getSnapshotCount } from '../services/snapshot.service';



export async function getSettingsHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.query.userId as string | undefined;

    if (userId) {
      // User-specific settings from UserSettings
      const userSettings = await prisma.userSettings.findUnique({ where: { userId } });
      res.json({
        cashBalance: Math.round((userSettings?.cashBalance ?? 0) * 100) / 100,
        marginDebt: Math.round((userSettings?.marginDebt ?? 0) * 100) / 100,
        cashInterestRate: Math.round((userSettings?.cashInterestRate ?? 0) * 100) / 100,
      });
    } else {
      // Legacy: global settings
      const settings = await getSettings();
      res.json({
        cashBalance: Math.round(settings.cashBalance * 100) / 100,
        marginDebt: Math.round((settings.marginDebt ?? 0) * 100) / 100,
        cashInterestRate: Math.round((settings.cashInterestRate ?? 0) * 100) / 100,
      });
    }
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({
      error: 'Failed to fetch settings',
      ...(process.env.NODE_ENV !== 'production' ? { details: (error as Error)?.message } : {}),
    });
  }
}

export async function updateSettingsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.query.userId as string | undefined;
    const { cashBalance, marginDebt, cashInterestRate } = req.body;

    console.log('[Settings Debug] updateSettings called:');
    console.log('[Settings Debug]   userId from query:', userId);
    console.log('[Settings Debug]   req.user?.userId:', req.user?.userId);
    console.log('[Settings Debug]   cashBalance:', cashBalance);
    console.log('[Settings Debug]   marginDebt:', marginDebt);
    console.log('[Settings Debug]   cashInterestRate:', cashInterestRate);

    // SECURITY: Verify ownership - user can only update their own settings
    if (userId && req.user?.userId !== userId) {
      console.log('[Settings Debug] ACCESS DENIED - userId mismatch');
      res.status(403).json({ error: 'Access denied. You can only update your own settings.' });
      return;
    }

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

    if (userId) {
      // User-specific settings
      console.log('[Settings Debug] Using USER-SPECIFIC path for userId:', userId);
      const updateData: Record<string, number> = {};
      if (roundedCash !== undefined) updateData.cashBalance = roundedCash;
      if (roundedMargin !== undefined) updateData.marginDebt = roundedMargin;
      if (roundedRate !== undefined) updateData.cashInterestRate = roundedRate;

      console.log('[Settings Debug] Update data:', updateData);

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

      console.log('[Settings Debug] Updated userSettings:', {
        cashBalance: userSettings.cashBalance,
        marginDebt: userSettings.marginDebt
      });

      res.json({
        cashBalance: Math.round(userSettings.cashBalance * 100) / 100,
        marginDebt: Math.round((userSettings.marginDebt ?? 0) * 100) / 100,
        cashInterestRate: Math.round((userSettings.cashInterestRate ?? 0) * 100) / 100,
      });
    } else {
      // Legacy: global settings
      const settings = await updateSettings({ cashBalance: roundedCash, marginDebt: roundedMargin, cashInterestRate: roundedRate });
      res.json({
        cashBalance: Math.round(settings.cashBalance * 100) / 100,
        marginDebt: Math.round((settings.marginDebt ?? 0) * 100) / 100,
        cashInterestRate: Math.round((settings.cashInterestRate ?? 0) * 100) / 100,
      });
    }
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
}

export async function setBaselineHandler(req: Request, res: Response): Promise<void> {
  try {
    const { type } = req.body;

    if (!type || !['fresh_start', 'existing_portfolio'].includes(type)) {
      res.status(400).json({
        error: 'Invalid type. Must be "fresh_start" or "existing_portfolio"',
      });
      return;
    }

    const settings = await setBaseline({ type });
    res.json({
      message: 'Baseline set successfully',
      trackingStartDate: settings.trackingStartDate,
      baselineTotalValue: settings.baselineTotalValue,
      baselineType: settings.baselineType,
    });
  } catch (error) {
    console.error('Error setting baseline:', error);
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
  } catch (error) {
    console.error('Error setting broker lifetime:', error);
    res.status(500).json({ error: 'Failed to set broker lifetime data' });
  }
}

export async function clearBrokerLifetimeHandler(req: Request, res: Response): Promise<void> {
  try {
    await clearBrokerLifetime();
    res.status(204).send();
  } catch (error) {
    console.error('Error clearing broker lifetime:', error);
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
  } catch (error) {
    console.error('Error fetching YTD settings:', error);
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
  } catch (error) {
    console.error('Error setting YTD data:', error);
    res.status(500).json({ error: 'Failed to set YTD data' });
  }
}

export async function clearYtdHandler(req: Request, res: Response): Promise<void> {
  try {
    await clearYtdData();
    res.status(204).send();
  } catch (error) {
    console.error('Error clearing YTD data:', error);
    res.status(500).json({ error: 'Failed to clear YTD data' });
  }
}

export async function getSummaryHandler(req: Request, res: Response): Promise<void> {
  try {
    const summary = await getPerformanceSummary();
    res.json(summary);
  } catch (error) {
    console.error('Error fetching summary:', error);
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
  } catch (error) {
    console.error('Error activating tracking:', error);
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
  } catch (error) {
    console.error('Error restarting tracking:', error);
    res.status(500).json({ error: 'Failed to restart tracking' });
  }
}

export async function cleanupSnapshotsHandler(req: Request, res: Response): Promise<void> {
  try {
    const countBefore = await getSnapshotCount();
    const deletedCount = await cleanupDuplicateSnapshots();
    const countAfter = await getSnapshotCount();

    res.json({
      message: 'Snapshot cleanup completed',
      snapshotsBefore: countBefore,
      snapshotsDeleted: deletedCount,
      snapshotsAfter: countAfter,
    });
  } catch (error) {
    console.error('Error cleaning up snapshots:', error);
    res.status(500).json({ error: 'Failed to cleanup snapshots' });
  }
}

export async function getCashInterestAccrualHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.query.userId as string | undefined;

    if (userId && req.user?.userId !== userId) {
      res.status(403).json({ error: 'Access denied. You can only view your own settings.' });
      return;
    }

    let cashBalance = 0;
    let cashInterestRate = 0;

    if (userId) {
      const userSettings = await prisma.userSettings.findUnique({ where: { userId } });
      cashBalance = userSettings?.cashBalance ?? 0;
      cashInterestRate = userSettings?.cashInterestRate ?? 0;
    } else {
      const settings = await getSettings();
      cashBalance = settings.cashBalance ?? 0;
      cashInterestRate = settings.cashInterestRate ?? 0;
    }

    const dailyAccrual = cashBalance * (cashInterestRate / 100) / 365;
    const annualAccrual = cashBalance * (cashInterestRate / 100);

    res.json({
      cashBalance: Math.round(cashBalance * 100) / 100,
      cashInterestRate: Math.round(cashInterestRate * 100) / 100,
      dailyAccrual: Math.round(dailyAccrual * 100) / 100,
      annualAccrual: Math.round(annualAccrual * 100) / 100,
      asOf: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error calculating cash interest accrual:', error);
    res.status(500).json({ error: 'Failed to calculate cash interest accrual' });
  }
}

