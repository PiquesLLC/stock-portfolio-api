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
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

// Events (GET public, mutations require auth + rate limiting)
router.get('/events', getEventsHandler);
router.get('/events/upcoming', getUpcomingHandler);
router.post('/events', mutationLimiter, requireAuth, addDividendEvent);
router.delete('/events/:id', mutationLimiter, requireAuth, removeEvent);

// Credits (posted dividends)
router.get('/credits', getCreditsHandler);
router.get('/credits/:id/timeline', getTimelineHandler);
router.post('/credits/:id/reinvest', mutationLimiter, requireAuth, reinvestHandler);

// Reinvestments
router.get('/reinvestments', getReinvestmentsHandler);

// Summary
router.get('/summary', getSummaryHandler);

// Growth rates
router.get('/growth-rates', getDividendGrowthRatesHandler);

// DRIP Settings (GET public, PUT requires auth)
router.get('/drip', getDripSettingsHandler);
router.put('/drip', mutationLimiter, requireAuth, updateDripSettingsHandler);

// Sync (trigger manual fetch from Yahoo) - requires auth
router.post('/sync', mutationLimiter, requireAuth, syncHandler);

// Backfill missed dividend postings - requires auth
router.post('/backfill', mutationLimiter, requireAuth, backfillHandler);

// Backward compat: GET / returns events, POST / adds event
router.get('/', getEventsHandler);
router.post('/', mutationLimiter, requireAuth, addDividendEvent);

export default router;
