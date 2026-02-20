import { Request, Response } from 'express';
import { generateShareCard } from '../services/share-card.service';

export async function getShareCardHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    const pngBuffer = await generateShareCard(userId);
    if (!pngBuffer) {
      res.status(404).json({ error: 'User not found or profile is private' });
      return;
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=3600'); // 30min client, 1hr CDN
    res.send(pngBuffer);
  } catch (err) {
    console.error('Share card generation failed:', err);
    res.status(500).json({ error: 'Failed to generate share card' });
  }
}
