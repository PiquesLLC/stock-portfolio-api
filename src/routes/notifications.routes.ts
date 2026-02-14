import { Router } from 'express';
import { getNotificationStatusHandler } from '../controllers/notifications.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/status', requireAuth, getNotificationStatusHandler);

export default router;
