import { Router } from 'express';
import {
  addDividendEvent,
  getEventsHandler,
  getUpcomingHandler,
  removeEvent,
  getCreditsHandler,
  getSummaryHandler,
  syncHandler,
} from '../controllers/dividend.controller';

const router = Router();

// Events
router.get('/events', getEventsHandler);
router.get('/events/upcoming', getUpcomingHandler);
router.post('/events', addDividendEvent);
router.delete('/events/:id', removeEvent);

// Credits (posted dividends)
router.get('/credits', getCreditsHandler);

// Summary
router.get('/summary', getSummaryHandler);

// Sync (trigger manual fetch from Yahoo)
router.post('/sync', syncHandler);

// Backward compat: GET / returns events, POST / adds event
router.get('/', getEventsHandler);
router.post('/', addDividendEvent);

export default router;
