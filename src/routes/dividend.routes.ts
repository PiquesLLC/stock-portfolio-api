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

const router = Router();

// Events
router.get('/events', getEventsHandler);
router.get('/events/upcoming', getUpcomingHandler);
router.post('/events', addDividendEvent);
router.delete('/events/:id', removeEvent);

// Credits (posted dividends)
router.get('/credits', getCreditsHandler);
router.get('/credits/:id/timeline', getTimelineHandler);
router.post('/credits/:id/reinvest', reinvestHandler);

// Reinvestments
router.get('/reinvestments', getReinvestmentsHandler);

// Summary
router.get('/summary', getSummaryHandler);

// DRIP Settings
router.get('/drip', getDripSettingsHandler);
router.put('/drip', updateDripSettingsHandler);

// Sync (trigger manual fetch from Yahoo)
router.post('/sync', syncHandler);

// Backfill missed dividend postings
router.post('/backfill', backfillHandler);

// Backward compat: GET / returns events, POST / adds event
router.get('/', getEventsHandler);
router.post('/', addDividendEvent);

export default router;
