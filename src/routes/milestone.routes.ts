import { Router } from 'express';
import {
  getMilestoneEventsHandler,
  getUnreadMilestoneCountHandler,
  markMilestoneEventReadHandler,
  markAllMilestoneEventsReadHandler,
} from '../controllers/milestone.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

// All milestone routes require auth — userId derived from JWT
router.get('/events', requireAuth, getMilestoneEventsHandler);
router.get('/events/unread-count', requireAuth, getUnreadMilestoneCountHandler);
router.post('/events/:id/read', mutationLimiter, requireAuth, markMilestoneEventReadHandler);
router.post('/events/read-all', mutationLimiter, requireAuth, markAllMilestoneEventsReadHandler);

export default router;
