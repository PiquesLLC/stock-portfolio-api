import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import {
  createPriceAlert,
  getPriceAlerts,
  getPriceAlertById,
  updatePriceAlert,
  deletePriceAlert,
  getPriceAlertEvents,
  markEventRead,
  getUnreadCount,
  PriceAlertCondition,
} from '../services/priceAlert.service';

// GET /price-alerts?ticker=X
export async function getPriceAlertsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const ticker = req.query.ticker as string | undefined;
    const userId = req.user?.userId;
    const alerts = await getPriceAlerts(ticker, userId);
    res.json(alerts);
  } catch (error) {
    console.error('Error getting price alerts:', error);
    res.status(500).json({ error: 'Failed to get price alerts' });
  }
}

// GET /price-alerts/:id
export async function getPriceAlertHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const alert = await getPriceAlertById(id, req.user?.userId);
    if (!alert) {
      res.status(404).json({ error: 'Price alert not found' });
      return;
    }
    res.json(alert);
  } catch (error) {
    console.error('Error getting price alert:', error);
    res.status(500).json({ error: 'Failed to get price alert' });
  }
}

// POST /price-alerts
export async function createPriceAlertHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { ticker, condition, targetPrice, percentChange, referencePrice, referencePriceType, repeatAlert, expiresAt } = req.body;

    if (!ticker || !condition) {
      res.status(400).json({ error: 'ticker and condition are required' });
      return;
    }

    const validConditions: PriceAlertCondition[] = ['above', 'below', 'pct_up', 'pct_down'];
    if (!validConditions.includes(condition)) {
      res.status(400).json({ error: `condition must be one of: ${validConditions.join(', ')}` });
      return;
    }

    // Always use authenticated user's ID — never accept from body
    const alert = await createPriceAlert({
      ticker,
      condition,
      targetPrice,
      percentChange,
      referencePrice,
      referencePriceType,
      repeatAlert,
      expiresAt,
      userId: req.user!.userId,
    });

    res.status(201).json(alert);
  } catch (error) {
    console.error('Error creating price alert:', error);
    const message = error instanceof Error ? error.message : 'Failed to create price alert';
    res.status(400).json({ error: message });
  }
}

// PUT /price-alerts/:id
export async function updatePriceAlertHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { targetPrice, percentChange, enabled } = req.body;

    const data: { targetPrice?: number; percentChange?: number; enabled?: boolean } = {};
    if (targetPrice !== undefined) data.targetPrice = targetPrice;
    if (percentChange !== undefined) data.percentChange = percentChange;
    if (typeof enabled === 'boolean') data.enabled = enabled;

    // Ownership-scoped update
    const alert = await updatePriceAlert(id, data, req.user!.userId);
    if (!alert) {
      res.status(404).json({ error: 'Price alert not found' });
      return;
    }
    res.json(alert);
  } catch (error) {
    console.error('Error updating price alert:', error);
    res.status(500).json({ error: 'Failed to update price alert' });
  }
}

// DELETE /price-alerts/:id
export async function deletePriceAlertHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    // Ownership-scoped delete
    const deleted = await deletePriceAlert(id, req.user!.userId);
    if (!deleted) {
      res.status(404).json({ error: 'Price alert not found' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting price alert:', error);
    res.status(500).json({ error: 'Failed to delete price alert' });
  }
}

// GET /price-alerts/events
export async function getPriceAlertEventsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const events = await getPriceAlertEvents(limit, userId);
    res.json(events);
  } catch (error) {
    console.error('Error getting price alert events:', error);
    res.status(500).json({ error: 'Failed to get price alert events' });
  }
}

// POST /price-alerts/events/:id/read
export async function markEventReadHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await markEventRead(id, req.user!.userId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error marking event read:', error);
    res.status(500).json({ error: 'Failed to mark event read' });
  }
}

// GET /price-alerts/events/unread-count
export async function getUnreadCountHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    const count = await getUnreadCount(userId);
    res.json({ count });
  } catch (error) {
    console.error('Error getting unread count:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
}
