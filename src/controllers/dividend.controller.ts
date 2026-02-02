import { Request, Response } from 'express';
import {
  createDividendEvent,
  getDividendEvents,
  getUpcomingDividendEvents,
  deleteDividendEvent,
} from '../services/dividend.service';
import { getDividendSummary, getDividendCredits, backfillMissedDividends } from '../services/dividend-post.service';
import { syncDividendEventsForTicker, syncAllHeldTickers } from '../services/dividend-fetch.service';

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

    const event = await createDividendEvent({
      ticker,
      exDate,
      payDate,
      amountPerShare,
      recordDate,
      dividendType,
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
      res.json({ ticker, eventsUpserted: count });
    } else {
      const result = await syncAllHeldTickers();
      res.json(result);
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
