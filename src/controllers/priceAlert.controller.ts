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
} from '../services/priceAlert.service';
import { PlanLimitError } from '../utils/plan-limit.error';
import { z } from 'zod';

const createPriceAlertSchema = z.object({
  ticker: z.string().trim().min(1).max(10).transform(s => s.toUpperCase()),
  condition: z.enum(['above', 'below', 'pct_up', 'pct_down']),
  targetPrice: z.number().positive().optional(),
  percentChange: z.number().positive().max(1000).optional(),
  referencePrice: z.number().positive().optional(),
  referencePriceType: z.enum(['current', 'open', 'avgCost']).optional(),
  repeatAlert: z.boolean().optional(),
  expiresAt: z.string().datetime().optional(),
});

// GET /price-alerts?ticker=X
export async function getPriceAlertsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const ticker = req.query.ticker as string | undefined;
    const alerts = await getPriceAlerts(req.user!.userId, ticker);
    res.json(alerts);
  } catch (_error) {
    console.error('Error getting price alerts:');
    res.status(500).json({ error: 'Failed to get price alerts' });
  }
}

// GET /price-alerts/:id
export async function getPriceAlertHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const alert = await getPriceAlertById(id, req.user!.userId);
    if (!alert) {
      res.status(404).json({ error: 'Price alert not found' });
      return;
    }
    res.json(alert);
  } catch (_error) {
    console.error('Error getting price alert:');
    res.status(500).json({ error: 'Failed to get price alert' });
  }
}

// POST /price-alerts
export async function createPriceAlertHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsed = createPriceAlertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((e) => e.message).join(', ') });
      return;
    }

    // Always use authenticated user's ID — never accept from body
    const alert = await createPriceAlert({
      ...parsed.data,
      userId: req.user!.userId,
    });

    res.status(201).json(alert);
  } catch (error) {
    if (error instanceof PlanLimitError) {
      res.status(403).json({ error: 'limit_reached', limit: error.limit, plan: error.plan });
      return;
    }
    console.error('Error creating price alert:');
    res.status(400).json({ error: 'Failed to create price alert' });
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
  } catch (_error) {
    console.error('Error updating price alert:');
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
  } catch (_error) {
    console.error('Error deleting price alert:');
    res.status(500).json({ error: 'Failed to delete price alert' });
  }
}

// GET /price-alerts/events
export async function getPriceAlertEventsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 200);
    const events = await getPriceAlertEvents(req.user!.userId, limit);
    res.json(events);
  } catch (_error) {
    console.error('Error getting price alert events:');
    res.status(500).json({ error: 'Failed to get price alert events' });
  }
}

// POST /price-alerts/events/:id/read
export async function markEventReadHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await markEventRead(id, req.user!.userId);
    res.json({ ok: true });
  } catch (_error) {
    console.error('Error marking event read:');
    res.status(500).json({ error: 'Failed to mark event read' });
  }
}

// GET /price-alerts/events/unread-count
export async function getUnreadCountHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const count = await getUnreadCount(req.user!.userId);
    res.json({ count });
  } catch (_error) {
    console.error('Error getting unread count:');
    res.status(500).json({ error: 'Failed to get unread count' });
  }
}
