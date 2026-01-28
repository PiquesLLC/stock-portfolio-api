import { Request, Response } from 'express';
import {
  getSettings,
  setBaseline,
  setBrokerLifetime,
  clearBrokerLifetime,
  getPerformanceSummary,
} from '../services/settings.service';
import { updateSettings } from '../services/portfolio.service';

export async function getSettingsHandler(req: Request, res: Response): Promise<void> {
  try {
    const settings = await getSettings();
    res.json({
      cashBalance: settings.cashBalance,
      marginDebt: settings.marginDebt ?? 0,
    });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
}

export async function updateSettingsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { cashBalance, marginDebt } = req.body;

    // Validate inputs if provided
    if (cashBalance !== undefined && (typeof cashBalance !== 'number' || cashBalance < 0)) {
      res.status(400).json({ error: 'Invalid cashBalance: must be a non-negative number' });
      return;
    }

    if (marginDebt !== undefined && (typeof marginDebt !== 'number' || marginDebt < 0)) {
      res.status(400).json({ error: 'Invalid marginDebt: must be a non-negative number' });
      return;
    }

    if (cashBalance === undefined && marginDebt === undefined) {
      res.status(400).json({ error: 'At least one of cashBalance or marginDebt must be provided' });
      return;
    }

    const settings = await updateSettings({ cashBalance, marginDebt });
    res.json({
      cashBalance: settings.cashBalance,
      marginDebt: settings.marginDebt ?? 0,
    });
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

export async function getSummaryHandler(req: Request, res: Response): Promise<void> {
  try {
    const summary = await getPerformanceSummary();
    res.json(summary);
  } catch (error) {
    console.error('Error fetching summary:', error);
    res.status(500).json({ error: 'Failed to fetch performance summary' });
  }
}
