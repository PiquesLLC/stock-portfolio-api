import { Request, Response } from 'express';
import {
  getMilestoneEvents,
  getUnreadMilestoneCount,
  markMilestoneEventRead,
  markAllMilestoneEventsRead,
} from '../services/milestone.service';

// GET /milestones/events?limit=N
export async function getMilestoneEventsHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const events = await getMilestoneEvents(userId, limit);
    res.json(events);
  } catch (error) {
    console.error('Error getting milestone events:', error);
    res.status(500).json({ error: 'Failed to get milestone events' });
  }
}

// GET /milestones/events/unread-count?userId=X
export async function getUnreadMilestoneCountHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    const count = await getUnreadMilestoneCount(userId);
    res.json({ count });
  } catch (error) {
    console.error('Error getting unread count:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
}

// POST /milestones/events/:id/read
export async function markMilestoneEventReadHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await markMilestoneEventRead(id);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error marking event read:', error);
    res.status(500).json({ error: 'Failed to mark event read' });
  }
}

// POST /milestones/events/read-all?userId=X
export async function markAllMilestoneEventsReadHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.query.userId as string || req.body.userId;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    await markAllMilestoneEventsRead(userId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error marking all events read:', error);
    res.status(500).json({ error: 'Failed to mark all events read' });
  }
}
