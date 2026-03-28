import { Response } from 'express';
import { AuthRequest } from '../types/auth';
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

export async function addDividendEvent(req: AuthRequest, res: Response): Promise<void> {
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
  } catch (error: unknown) {
    console.error('Error adding dividend event:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to add dividend event' });
  }
}

export async function getEventsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { ticker, from, to } = req.query;
    const events = await getDividendEvents({
      ticker: ticker as string | undefined,
      fromDate: from ? new Date(from as string) : undefined,
      toDate: to ? new Date(to as string) : undefined,
      userId: req.user!.userId,
    });
    res.json(events);
  } catch (error: unknown) {
    console.error('Error fetching dividend events:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch dividend events' });
  }
}

export async function getUpcomingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const events = await getUpcomingDividendEvents(req.user!.userId);
    res.json(events);
  } catch (error: unknown) {
    console.error('Error fetching upcoming dividends:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch upcoming dividends' });
  }
}

export async function removeEvent(req: AuthRequest, res: Response): Promise<void> {
  try {
    await deleteDividendEvent(req.params.id);
    res.status(204).send();
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error) {
      const code = (error as { code?: string }).code;
      if (code === 'P2025') {
        res.status(404).json({ error: 'Dividend event not found' });
        return;
      }
      if (code === 'HAS_CREDITS') {
        res.status(409).json({ error: 'Cannot delete dividend event with posted credits' });
        return;
      }
    }
    console.error('Error removing dividend event:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to remove dividend event' });
  }
}

// --- Credits ---

export async function getCreditsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { ticker } = req.query;
    const credits = await getDividendCredits(
      req.user!.userId,
      ticker as string | undefined,
    );
    res.json(credits);
  } catch (error: unknown) {
    console.error('Error fetching dividend credits:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch dividend credits' });
  }
}

export async function getSummaryHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const summary = await getDividendSummary(req.user!.userId);
    res.json(summary);
  } catch (error: unknown) {
    console.error('Error fetching dividend summary:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch dividend summary' });
  }
}

// --- Sync ---

export async function syncHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { ticker } = req.body;
    if (ticker) {
      const count = await syncDividendEventsForTicker(ticker);
      const posted = await postDividendsForDate(new Date(), userId);
      const backfilled = await backfillMissedDividends(userId);
      res.json({ ticker, eventsUpserted: count, posted: posted.posted, backfilled: backfilled.totalPosted });
    } else {
      const result = await syncAllHeldTickers(userId);
      const posted = await postDividendsForDate(new Date(), userId);
      const backfilled = await backfillMissedDividends(userId);
      res.json({ ...result, posted: posted.posted, backfilled: backfilled.totalPosted });
    }
  } catch (error: unknown) {
    console.error('Error syncing dividends:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to sync dividends' });
  }
}

export async function backfillHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await backfillMissedDividends(req.user!.userId);
    res.json(result);
  } catch (error: unknown) {
    console.error('Error backfilling dividends:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to backfill dividends' });
  }
}

// --- DRIP (Dividend Reinvestment) ---

export async function getReinvestmentsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { ticker } = req.query;
    const reinvestments = await getReinvestments(
      req.user!.userId,
      ticker as string | undefined
    );
    res.json(reinvestments);
  } catch (error: unknown) {
    console.error('Error fetching reinvestments:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch reinvestments' });
  }
}

export async function getTimelineHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const timeline = await getDividendTimeline(id, req.user!.userId);
    res.json(timeline);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Dividend credit not found') {
      res.status(404).json({ error: 'Dividend credit not found' });
      return;
    }
    console.error('Error fetching dividend timeline:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch dividend timeline' });
  }
}

export async function reinvestHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    // Always use system user — never accept userId from body
    const result = await reinvestDividend(id, req.user!.userId);
    res.json(result);
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.message === 'Dividend credit not found') {
        res.status(404).json({ error: 'Dividend credit not found' });
        return;
      }
      if (error.message === 'Dividend already reinvested') {
        res.status(400).json({ error: 'Dividend already reinvested' });
        return;
      }
      if (error.message.includes('No holding found')) {
        res.status(400).json({ error: 'No holding found for this ticker' });
        return;
      }
    }
    console.error('Error reinvesting dividend:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to reinvest dividend' });
  }
}

export async function getDripSettingsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const settings = await getDripSettings(req.user!.userId);
    res.json(settings);
  } catch (error: unknown) {
    console.error('Error fetching DRIP settings:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch DRIP settings' });
  }
}

export async function updateDripSettingsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    // Always use system user — never accept userId from body
    await updateDripSettings(req.user!.userId, enabled);
    res.json({ enabled });
  } catch (error: unknown) {
    console.error('Error updating DRIP settings:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to update DRIP settings' });
  }
}
