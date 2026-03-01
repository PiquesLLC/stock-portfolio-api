import { Router } from 'express';
import { subscribeHandler, unsubscribeHandler, getVapidKeyHandler } from '../controllers/push.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

// Public — UI needs this before user subscribes
router.get('/vapid-key', getVapidKeyHandler);

// Authenticated — subscription management
router.post('/subscribe', mutationLimiter, requireAuth, subscribeHandler);
router.delete('/subscribe', mutationLimiter, requireAuth, unsubscribeHandler);

export default router;
