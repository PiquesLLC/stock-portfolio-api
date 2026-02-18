import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import {
  getUserAlerts,
  updateAlert,
  getAlertEvents,
  getUnreadCount,
  markEventRead,
  markAllRead,
} from '../services/alert.service';

// GET /alerts — uses authenticated user
export async function getAlertsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const alerts = await getUserAlerts(req.user.userId);
    res.json(alerts);
  } catch (_error) {
    console.error('Error getting alerts:');
    res.status(500).json({ error: 'Failed to get alerts' });
  }
}

// PUT /alerts/:id — ownership-scoped
export async function updateAlertHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { threshold, enabled } = req.body;

    const data: { threshold?: number | null; enabled?: boolean } = {};
    if (threshold !== undefined) data.threshold = threshold;
    if (typeof enabled === 'boolean') data.enabled = enabled;

    const alert = await updateAlert(id, data, req.user!.userId);
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    res.json(alert);
  } catch (_error) {
    console.error('Error updating alert:');
    res.status(500).json({ error: 'Failed to update alert' });
  }
}

// GET /alerts/events — uses authenticated user
export async function getEventsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const events = await getAlertEvents(req.user.userId);
    res.json(events);
  } catch (_error) {
    console.error('Error getting alert events:');
    res.status(500).json({ error: 'Failed to get alert events' });
  }
}

// GET /alerts/events/unread-count — uses authenticated user
export async function getUnreadCountHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const count = await getUnreadCount(req.user.userId);
    res.json({ count });
  } catch (_error) {
    console.error('Error getting unread count:');
    res.status(500).json({ error: 'Failed to get unread count' });
  }
}

// POST /alerts/events/:id/read — ownership-scoped
export async function markReadHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    await markEventRead(req.params.id, req.user!.userId);
    res.json({ ok: true });
  } catch (_error) {
    console.error('Error marking event read:');
    res.status(500).json({ error: 'Failed to mark event read' });
  }
}

// POST /alerts/events/read-all — uses authenticated user
export async function markAllReadHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    await markAllRead(req.user!.userId);
    res.json({ ok: true });
  } catch (_error) {
    console.error('Error marking all read:');
    res.status(500).json({ error: 'Failed to mark all read' });
  }
}
