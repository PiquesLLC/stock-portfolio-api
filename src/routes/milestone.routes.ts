import { Router } from 'express';
import {
  getMilestoneEventsHandler,
  getUnreadMilestoneCountHandler,
  markMilestoneEventReadHandler,
  markAllMilestoneEventsReadHandler,
} from '../controllers/milestone.controller';

const router = Router();

// Events
router.get('/events', getMilestoneEventsHandler);
router.get('/events/unread-count', getUnreadMilestoneCountHandler);
router.post('/events/:id/read', markMilestoneEventReadHandler);
router.post('/events/read-all', markAllMilestoneEventsReadHandler);

export default router;
