import { Router, Request, Response } from 'express';
import { getBottlenecksData } from '../services/ai-bottlenecks.service';

const router = Router();

router.get('/bottlenecks', (_req: Request, res: Response) => {
  try {
    const data = getBottlenecksData();
    res.json(data);
  } catch (err) {
    console.error('[Discover] /bottlenecks failed:', err);
    res.status(500).json({ error: 'Failed to load bottlenecks catalog' });
  }
});

export default router;
