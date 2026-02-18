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

// Single-portfolio app: all data lives under the system user.
// Auth is for access control only — never use client-supplied userId for lookups.
const SYSTEM_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

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
  } catch (_error) {
    console.error('Error adding dividend event:');
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
      userId: SYSTEM_USER_ID,
    });
    res.json(events);
  } catch (_error) {
    console.error('Error fetching dividend events:');
    res.status(500).json({ error: 'Failed to fetch dividend events' });
  }
}

export async function getUpcomingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const events = await getUpcomingDividendEvents(SYSTEM_USER_ID);
    res.json(events);
  } catch (_error) {
    console.error('Error fetching upcoming dividends:');
    res.status(500).json({ error: 'Failed to fetch upcoming dividends' });
  }
}

export async function removeEvent(req: AuthRequest, res: Response): Promise<void> {
  try {
    await deleteDividendEvent(req.params.id);
    res.status(204).send();
  } catch (error: any) {
    if (error?.code === 'P2025') {
      res.status(404).json({ error: 'Dividend event not found' });
      return;
    }
    console.error('Error removing dividend event:');
    res.status(500).json({ error: 'Failed to remove dividend event' });
  }
}

// --- Credits ---

export async function getCreditsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { ticker } = req.query;
    const credits = await getDividendCredits(
      SYSTEM_USER_ID,
      ticker as string | undefined,
    );
    res.json(credits);
  } catch (_error) {
    console.error('Error fetching dividend credits:');
    res.status(500).json({ error: 'Failed to fetch dividend credits' });
  }
}

export async function getSummaryHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const summary = await getDividendSummary(SYSTEM_USER_ID);
    res.json(summary);
  } catch (_error) {
    console.error('Error fetching dividend summary:');
    res.status(500).json({ error: 'Failed to fetch dividend summary' });
  }
}

// --- Sync ---

export async function syncHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { ticker } = req.body;
    if (ticker) {
      const count = await syncDividendEventsForTicker(ticker);
      const posted = await postDividendsForDate();
      const backfilled = await backfillMissedDividends();
      res.json({ ticker, eventsUpserted: count, posted: posted.posted, backfilled: backfilled.totalPosted });
    } else {
      const result = await syncAllHeldTickers();
      const posted = await postDividendsForDate();
      const backfilled = await backfillMissedDividends();
      res.json({ ...result, posted: posted.posted, backfilled: backfilled.totalPosted });
    }
  } catch (_error) {
    console.error('Error syncing dividends:');
    res.status(500).json({ error: 'Failed to sync dividends' });
  }
}

export async function backfillHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await backfillMissedDividends();
    res.json(result);
  } catch (_error) {
    console.error('Error backfilling dividends:');
    res.status(500).json({ error: 'Failed to backfill dividends' });
  }
}

// --- DRIP (Dividend Reinvestment) ---

export async function getReinvestmentsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { ticker } = req.query;
    const reinvestments = await getReinvestments(
      SYSTEM_USER_ID,
      ticker as string | undefined
    );
    res.json(reinvestments);
  } catch (_error) {
    console.error('Error fetching reinvestments:');
    res.status(500).json({ error: 'Failed to fetch reinvestments' });
  }
}

export async function getTimelineHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const timeline = await getDividendTimeline(id);
    res.json(timeline);
  } catch (error: any) {
    if (error?.message === 'Dividend credit not found') {
      res.status(404).json({ error: 'Dividend credit not found' });
      return;
    }
    console.error('Error fetching dividend timeline:');
    res.status(500).json({ error: 'Failed to fetch dividend timeline' });
  }
}

export async function reinvestHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    // Always use system user — never accept userId from body
    const result = await reinvestDividend(id, SYSTEM_USER_ID);
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
      res.status(400).json({ error: 'No holding found for this ticker' });
      return;
    }
    console.error('Error reinvesting dividend:');
    res.status(500).json({ error: 'Failed to reinvest dividend' });
  }
}

export async function getDripSettingsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const settings = await getDripSettings(SYSTEM_USER_ID);
    res.json(settings);
  } catch (_error) {
    console.error('Error fetching DRIP settings:');
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
    await updateDripSettings(SYSTEM_USER_ID, enabled);
    res.json({ enabled });
  } catch (_error) {
    console.error('Error updating DRIP settings:');
    res.status(500).json({ error: 'Failed to update DRIP settings' });
  }
}
