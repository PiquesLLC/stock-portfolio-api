import { Request, Response } from 'express';
import {
  getUserAlerts,
  updateAlert,
  getAlertEvents,
  getUnreadCount,
  markEventRead,
  markAllRead,
} from '../services/alert.service';

// GET /alerts?userId=X
export async function getAlertsHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    const alerts = await getUserAlerts(userId);
    res.json(alerts);
  } catch (error) {
    console.error('Error getting alerts:', error);
    res.status(500).json({ error: 'Failed to get alerts' });
  }
}

// PUT /alerts/:id
export async function updateAlertHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { threshold, enabled } = req.body;

    const data: { threshold?: number | null; enabled?: boolean } = {};
    if (threshold !== undefined) data.threshold = threshold;
    if (typeof enabled === 'boolean') data.enabled = enabled;

    const alert = await updateAlert(id, data);
    res.json(alert);
  } catch (error) {
    console.error('Error updating alert:', error);
    res.status(500).json({ error: 'Failed to update alert' });
  }
}

// GET /alerts/events?userId=X
export async function getEventsHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    const events = await getAlertEvents(userId);
    res.json(events);
  } catch (error) {
    console.error('Error getting alert events:', error);
    res.status(500).json({ error: 'Failed to get alert events' });
  }
}

// GET /alerts/events/unread-count?userId=X
export async function getUnreadCountHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    const count = await getUnreadCount(userId);
    res.json({ count });
  } catch (error) {
    console.error('Error getting unread count:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
}

// POST /alerts/events/:id/read
export async function markReadHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await markEventRead(id);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error marking event read:', error);
    res.status(500).json({ error: 'Failed to mark event read' });
  }
}

// POST /alerts/events/read-all?userId=X
export async function markAllReadHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    await markAllRead(userId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error marking all read:', error);
    res.status(500).json({ error: 'Failed to mark all read' });
  }
}
