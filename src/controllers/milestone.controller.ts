import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import {
  getMilestoneEvents,
  getUnreadMilestoneCount,
  markMilestoneEventRead,
  markAllMilestoneEventsRead,
} from '../services/milestone.service';

// GET /milestones/events?limit=N
export async function getMilestoneEventsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 200);
    const events = await getMilestoneEvents(req.user.userId, limit);
    res.json(events);
  } catch (error: unknown) {
    console.error('Error getting milestone events:');
    res.status(500).json({ error: 'Failed to get milestone events' });
  }
}

// GET /milestones/events/unread-count
export async function getUnreadMilestoneCountHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const count = await getUnreadMilestoneCount(req.user.userId);
    res.json({ count });
  } catch (error: unknown) {
    console.error('Error getting unread count:');
    res.status(500).json({ error: 'Failed to get unread count' });
  }
}

// POST /milestones/events/:id/read
export async function markMilestoneEventReadHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { id } = req.params;
    const result = await markMilestoneEventRead(id, req.user.userId);
    if (!result) {
      res.status(404).json({ error: 'Milestone event not found' });
      return;
    }
    res.json({ ok: true });
  } catch (error: unknown) {
    console.error('Error marking event read:');
    res.status(500).json({ error: 'Failed to mark event read' });
  }
}

// POST /milestones/events/read-all
export async function markAllMilestoneEventsReadHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    await markAllMilestoneEventsRead(req.user.userId);
    res.json({ ok: true });
  } catch (error: unknown) {
    console.error('Error marking all events read:');
    res.status(500).json({ error: 'Failed to mark all events read' });
  }
}
