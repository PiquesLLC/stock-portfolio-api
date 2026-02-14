import { Request, Response } from 'express';
import { generateDividendCalendar } from '../services/calendar.service';

export async function getCalendarICS(req: Request, res: Response): Promise<void> {
  try {
    const months = req.query.months ? Math.min(parseInt(String(req.query.months), 10) || 6, 24) : 6;
    const ticker = req.query.ticker ? String(req.query.ticker).toUpperCase() : undefined;

    const ical = await generateDividendCalendar({ months, ticker });

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="nala-dividends.ics"');
    res.send(ical);
  } catch (error) {
    console.error('[Calendar] Error generating ICS:', error);
    res.status(500).json({ error: 'Failed to generate calendar file' });
  }
}
