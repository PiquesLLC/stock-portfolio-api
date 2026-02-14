import { Request, Response } from 'express';
import {
  createDividendEvent,
  getDividendEvents,
  getUpcomingDividendEvents,
  deleteDividendEvent,
} from '../services/dividend.service';
import { getDividendSummary, getDividendCredits, backfillMissedDividends, postDividendsForDate } from '../services/dividend-post.service';
import { syncDividendEventsForTicker, syncAllHeldTickers } from '../services/dividend-fetch.service';
import {
  getReinvestments,
  getDividendTimeline,
  reinvestDividend,
  getDripSettings,
  updateDripSettings,
} from '../services/drip.service';

// --- Events ---

export async function addDividendEvent(req: Request, res: Response): Promise<void> {
  try {
    const { ticker, exDate, payDate, amountPerShare, recordDate, dividendType } = req.body;

    if (!ticker || typeof ticker !== 'string') {
      res.status(400).json({ error: 'Missing or invalid ticker' });
      return;
    }
    if (!exDate || !payDate) {
      res.status(400).json({ error: 'Missing exDate or payDate' });
      return;
    }
    if (typeof amountPerShare !== 'number' || amountPerShare <= 0) {
      res.status(400).json({ error: 'Invalid amountPerShare' });
      return;
    }
    if (dividendType !== undefined) {
      const normalized = typeof dividendType === 'string' ? dividendType.toLowerCase() : '';
      const allowed = ['cash', 'drip', 'regular'];
      if (!allowed.includes(normalized)) {
        res.status(400).json({ error: 'Invalid dividendType. Must be cash, drip, or regular' });
        return;
      }
    }

    const event = await createDividendEvent({
      ticker,
      exDate,
      payDate,
      amountPerShare,
      recordDate,
      dividendType: typeof dividendType === 'string' ? dividendType.toLowerCase() : dividendType,
      source: 'manual',
    });
    res.status(201).json(event);
  } catch (error) {
    console.error('Error adding dividend event:', error);
    res.status(500).json({ error: 'Failed to add dividend event' });
  }
}

export async function getEventsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { ticker, from, to, userId } = req.query;
    const events = await getDividendEvents({
      ticker: ticker as string | undefined,
      fromDate: from ? new Date(from as string) : undefined,
      toDate: to ? new Date(to as string) : undefined,
      userId: userId as string | undefined ?? null,
    });
    res.json(events);
  } catch (error) {
    console.error('Error fetching dividend events:', error);
    res.status(500).json({ error: 'Failed to fetch dividend events' });
  }
}

export async function getUpcomingHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.query;
    const events = await getUpcomingDividendEvents(userId as string | undefined ?? null);
    res.json(events);
  } catch (error) {
    console.error('Error fetching upcoming dividends:', error);
    res.status(500).json({ error: 'Failed to fetch upcoming dividends' });
  }
}

export async function removeEvent(req: Request, res: Response): Promise<void> {
  try {
    await deleteDividendEvent(req.params.id);
    res.status(204).send();
  } catch (error: any) {
    if (error?.code === 'P2025') {
      res.status(404).json({ error: 'Dividend event not found' });
      return;
    }
    console.error('Error removing dividend event:', error);
    res.status(500).json({ error: 'Failed to remove dividend event' });
  }
}

// --- Credits ---

export async function getCreditsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId, ticker } = req.query;
    const credits = await getDividendCredits(
      userId as string | undefined ?? null,
      ticker as string | undefined,
    );
    res.json(credits);
  } catch (error) {
    console.error('Error fetching dividend credits:', error);
    res.status(500).json({ error: 'Failed to fetch dividend credits' });
  }
}

export async function getSummaryHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.query;
    const summary = await getDividendSummary(userId as string | undefined ?? null);
    res.json(summary);
  } catch (error) {
    console.error('Error fetching dividend summary:', error);
    res.status(500).json({ error: 'Failed to fetch dividend summary' });
  }
}

// --- Sync ---

export async function syncHandler(req: Request, res: Response): Promise<void> {
  try {
    const { ticker } = req.body;
    if (ticker) {
      const count = await syncDividendEventsForTicker(ticker);
      // After syncing new events, post any payable dividends + backfill missed ones
      const posted = await postDividendsForDate();
      const backfilled = await backfillMissedDividends();
      res.json({ ticker, eventsUpserted: count, posted: posted.posted, backfilled: backfilled.totalPosted });
    } else {
      const result = await syncAllHeldTickers();
      // After syncing, post any payable dividends + backfill missed ones
      const posted = await postDividendsForDate();
      const backfilled = await backfillMissedDividends();
      res.json({ ...result, posted: posted.posted, backfilled: backfilled.totalPosted });
    }
  } catch (error) {
    console.error('Error syncing dividends:', error);
    res.status(500).json({ error: 'Failed to sync dividends' });
  }
}

export async function backfillHandler(req: Request, res: Response): Promise<void> {
  try {
    const result = await backfillMissedDividends();
    res.json(result);
  } catch (error) {
    console.error('Error backfilling dividends:', error);
    res.status(500).json({ error: 'Failed to backfill dividends' });
  }
}

// --- DRIP (Dividend Reinvestment) ---

export async function getReinvestmentsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId, ticker } = req.query;
    const reinvestments = await getReinvestments(
      userId as string | undefined ?? null,
      ticker as string | undefined
    );
    res.json(reinvestments);
  } catch (error) {
    console.error('Error fetching reinvestments:', error);
    res.status(500).json({ error: 'Failed to fetch reinvestments' });
  }
}

export async function getTimelineHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const timeline = await getDividendTimeline(id);
    res.json(timeline);
  } catch (error: any) {
    if (error?.message === 'Dividend credit not found') {
      res.status(404).json({ error: 'Dividend credit not found' });
      return;
    }
    console.error('Error fetching dividend timeline:', error);
    res.status(500).json({ error: 'Failed to fetch dividend timeline' });
  }
}

export async function reinvestHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    const result = await reinvestDividend(id, userId ?? null);
    res.json(result);
  } catch (error: any) {
    if (error?.message === 'Dividend credit not found') {
      res.status(404).json({ error: 'Dividend credit not found' });
      return;
    }
    if (error?.message === 'Dividend already reinvested') {
      res.status(400).json({ error: 'Dividend already reinvested' });
      return;
    }
    if (error?.message?.includes('No holding found')) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Error reinvesting dividend:', error);
    res.status(500).json({ error: 'Failed to reinvest dividend' });
  }
}

export async function getDripSettingsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.query;
    const settings = await getDripSettings(userId as string | undefined ?? null);
    res.json(settings);
  } catch (error) {
    console.error('Error fetching DRIP settings:', error);
    res.status(500).json({ error: 'Failed to fetch DRIP settings' });
  }
}

export async function updateDripSettingsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId, enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    await updateDripSettings(userId ?? null, enabled);
    res.json({ enabled });
  } catch (error) {
    console.error('Error updating DRIP settings:', error);
    res.status(500).json({ error: 'Failed to update DRIP settings' });
  }
}
