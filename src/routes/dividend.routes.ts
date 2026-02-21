import { Router } from 'express';
import {
  addDividendEvent,
  getEventsHandler,
  getUpcomingHandler,
  removeEvent,
  getCreditsHandler,
  getSummaryHandler,
  syncHandler,
  backfillHandler,
  getReinvestmentsHandler,
  getTimelineHandler,
  reinvestHandler,
  getDripSettingsHandler,
  updateDripSettingsHandler,
} from '../controllers/dividend.controller';
import { getDividendGrowthRatesHandler } from '../controllers/dividend-growth.controller';
import { getCalendarICS } from '../controllers/calendar.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

// Events — all require auth (user-scoped data)
router.get('/events', requireAuth, getEventsHandler);
router.get('/events/upcoming', requireAuth, getUpcomingHandler);
router.post('/events', mutationLimiter, requireAuth, addDividendEvent);
router.delete('/events/:id', mutationLimiter, requireAuth, removeEvent);

// Credits (posted dividends) — require auth
router.get('/credits', requireAuth, getCreditsHandler);
router.get('/credits/:id/timeline', requireAuth, getTimelineHandler);
router.post('/credits/:id/reinvest', mutationLimiter, requireAuth, reinvestHandler);

// Reinvestments — require auth
router.get('/reinvestments', requireAuth, getReinvestmentsHandler);

// Summary — require auth
router.get('/summary', requireAuth, getSummaryHandler);

// Growth rates — require auth (user-scoped analytics)
router.get('/growth-rates', requireAuth, getDividendGrowthRatesHandler);

// DRIP Settings — require auth
router.get('/drip', requireAuth, getDripSettingsHandler);
router.put('/drip', mutationLimiter, requireAuth, updateDripSettingsHandler);

// Sync (trigger manual fetch from Yahoo) — requires auth
router.post('/sync', mutationLimiter, requireAuth, syncHandler);

// Backfill missed dividend postings — requires auth
router.post('/backfill', mutationLimiter, requireAuth, backfillHandler);

// Calendar export (iCal)
router.get('/calendar.ics', requireAuth, getCalendarICS);

// Backward compat: GET / returns events, POST / adds event
router.get('/', requireAuth, getEventsHandler);
router.post('/', mutationLimiter, requireAuth, addDividendEvent);

export default router;
