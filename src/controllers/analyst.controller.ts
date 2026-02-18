import { Request, Response } from 'express';
import {
  getAnalystEvents,
  getUnreadAnalystCount,
  markAnalystEventRead,
  markAllAnalystEventsRead,
  getAnalystSnapshot,
} from '../services/analyst.service';

// GET /analyst/events?limit=N
export async function getAnalystEventsHandler(req: Request, res: Response): Promise<void> {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const ticker = req.query.ticker as string | undefined;
    const events = await getAnalystEvents(limit, ticker);
    res.json(events);
  } catch (_error) {
    console.error('Error getting analyst events:');
    res.status(500).json({ error: 'Failed to get analyst events' });
  }
}

// GET /analyst/events/unread-count
export async function getUnreadAnalystCountHandler(req: Request, res: Response): Promise<void> {
  try {
    const count = await getUnreadAnalystCount();
    res.json({ count });
  } catch (_error) {
    console.error('Error getting unread count:');
    res.status(500).json({ error: 'Failed to get unread count' });
  }
}

// POST /analyst/events/:id/read
export async function markAnalystEventReadHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await markAnalystEventRead(id);
    res.json({ ok: true });
  } catch (_error) {
    console.error('Error marking event read:');
    res.status(500).json({ error: 'Failed to mark event read' });
  }
}

// POST /analyst/events/read-all
export async function markAllAnalystEventsReadHandler(req: Request, res: Response): Promise<void> {
  try {
    await markAllAnalystEventsRead();
    res.json({ ok: true });
  } catch (_error) {
    console.error('Error marking all events read:');
    res.status(500).json({ error: 'Failed to mark all events read' });
  }
}

// GET /analyst/snapshot/:ticker
export async function getAnalystSnapshotHandler(req: Request, res: Response): Promise<void> {
  try {
    const { ticker } = req.params;
    const snapshot = await getAnalystSnapshot(ticker);
    if (!snapshot) {
      res.status(404).json({ error: 'No analyst data found for this ticker' });
      return;
    }
    res.json(snapshot);
  } catch (_error) {
    console.error('Error getting analyst snapshot:');
    res.status(500).json({ error: 'Failed to get analyst snapshot' });
  }
}
