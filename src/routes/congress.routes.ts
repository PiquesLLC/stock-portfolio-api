import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import {
  listCongressTradesHandler,
  portfolioCongressTradesHandler,
  tickerCongressTradesHandler,
  congressStatsHandler,
} from '../controllers/congress.controller';

const router = Router();

// Public — browse all recent trades
router.get('/', requireAuth, listCongressTradesHandler);

// Auth required — trades matching user's portfolio
router.get('/portfolio', requireAuth, portfolioCongressTradesHandler);

// Auth required — aggregate stats
router.get('/stats', requireAuth, congressStatsHandler);

// Auth required — trades for a specific ticker
router.get('/ticker/:ticker', requireAuth, tickerCongressTradesHandler);

export default router;
