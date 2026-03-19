import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import * as ctrl from '../controllers/billionaire.controller';

const router = Router();

router.get('/', requireAuth, ctrl.getLeaderboardHandler);
router.get('/movers', requireAuth, ctrl.getMoversHandler);
router.get('/wealth-context', requireAuth, ctrl.getWealthContextHandler);
router.get('/:slug', requireAuth, ctrl.getProfileHandler);
router.get('/:slug/chart', requireAuth, ctrl.getChartHandler);

export default router;
