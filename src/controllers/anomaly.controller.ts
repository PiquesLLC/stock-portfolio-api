import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import prisma from '../utils/prisma';

export async function getAnomaliesHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const anomalies = await prisma.anomalyEvent.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json(anomalies);
  } catch (error: unknown) {
    console.error('Error fetching anomalies', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch anomalies' });
  }
}

export async function getUnreadAnomalyCountHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const count = await prisma.anomalyEvent.count({
      where: { userId: req.user!.userId, read: false },
    });
    res.json({ count });
  } catch (error: unknown) {
    console.error('Error fetching unread anomaly count', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to get unread count' });
  }
}

export async function markAnomalyReadHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    // Verify the anomaly belongs to the authenticated user before updating
    const anomaly = await prisma.anomalyEvent.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!anomaly) {
      res.status(404).json({ error: 'Anomaly not found' });
      return;
    }
    await prisma.anomalyEvent.update({
      where: { id: req.params.id },
      data: { read: true },
    });
    res.json({ success: true });
  } catch (error: unknown) {
    console.error('Error marking anomaly read', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to mark anomaly as read' });
  }
}

export async function markAllAnomaliesReadHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    await prisma.anomalyEvent.updateMany({
      where: { userId: req.user!.userId, read: false },
      data: { read: true },
    });
    res.json({ success: true });
  } catch (error: unknown) {
    console.error('Error marking all anomalies read', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to mark all anomalies as read' });
  }
}
