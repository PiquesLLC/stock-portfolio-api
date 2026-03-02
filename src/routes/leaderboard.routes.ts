import { Router } from 'express';
import { getLeaderboardHandler } from '../controllers/leaderboard.controller';
import { heavyReadLimiter } from '../middleware/rateLimiter';

const router = Router();

router.get('/', heavyReadLimiter, getLeaderboardHandler);

export default router;
