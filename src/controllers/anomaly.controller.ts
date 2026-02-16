import { Request, Response } from 'express';
import prisma from '../utils/prisma';

const SYSTEM_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

export async function getAnomaliesHandler(req: Request, res: Response): Promise<void> {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const anomalies = await prisma.anomalyEvent.findMany({
      where: { userId: SYSTEM_USER_ID },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json(anomalies);
  } catch (error: any) {
    console.error('Error fetching anomalies');
    res.status(500).json({ error: 'Failed to fetch anomalies' });
  }
}

export async function getUnreadAnomalyCountHandler(req: Request, res: Response): Promise<void> {
  try {
    const count = await prisma.anomalyEvent.count({
      where: { userId: SYSTEM_USER_ID, read: false },
    });
    res.json({ count });
  } catch (error: any) {
    console.error('Error fetching unread anomaly count');
    res.status(500).json({ error: 'Failed to get unread count' });
  }
}

export async function markAnomalyReadHandler(req: Request, res: Response): Promise<void> {
  try {
    await prisma.anomalyEvent.update({
      where: { id: req.params.id },
      data: { read: true },
    });
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error marking anomaly read');
    res.status(500).json({ error: 'Failed to mark anomaly as read' });
  }
}

export async function markAllAnomaliesReadHandler(req: Request, res: Response): Promise<void> {
  try {
    await prisma.anomalyEvent.updateMany({
      where: { userId: SYSTEM_USER_ID, read: false },
      data: { read: true },
    });
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error marking all anomalies read');
    res.status(500).json({ error: 'Failed to mark all anomalies as read' });
  }
}
