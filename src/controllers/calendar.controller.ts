import { Response } from 'express';
import { generateDividendCalendar } from '../services/calendar.service';
import { AuthRequest } from '../types/auth';

export async function getCalendarICS(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const months = req.query.months ? Math.min(parseInt(String(req.query.months), 10) || 6, 24) : 6;
    const ticker = req.query.ticker ? String(req.query.ticker).toUpperCase() : undefined;

    const ical = await generateDividendCalendar(userId, { months, ticker });

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="nala-dividends.ics"');
    res.send(ical);
  } catch (error: unknown) {
    console.error('[Calendar] Error generating ICS:');
    res.status(500).json({ error: 'Failed to generate calendar file' });
  }
}
