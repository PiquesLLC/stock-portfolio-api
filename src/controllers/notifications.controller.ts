import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { getNotificationStatus } from '../services/notifications.service';

export async function getNotificationStatusHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const status = await getNotificationStatus(userId);
    res.json(status);
  } catch (error) {
    console.error('Error fetching notification status:', error);
    res.status(500).json({ error: 'Failed to fetch notification status' });
  }
}
