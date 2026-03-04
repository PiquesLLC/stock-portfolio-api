import { Router } from 'express';
import { subscribeHandler, unsubscribeHandler, getVapidKeyHandler, testPushHandler, registerDeviceHandler, unregisterDeviceHandler } from '../controllers/push.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

// Public — UI needs this before user subscribes
router.get('/vapid-key', getVapidKeyHandler);

// Authenticated — subscription management
router.post('/subscribe', mutationLimiter, requireAuth, subscribeHandler);
router.delete('/subscribe', mutationLimiter, requireAuth, unsubscribeHandler);

// Test endpoint — send a test push to yourself
router.post('/test', mutationLimiter, requireAuth, testPushHandler);

// Native device token management (APNs/FCM)
router.post('/device', mutationLimiter, requireAuth, registerDeviceHandler);
router.delete('/device', mutationLimiter, requireAuth, unregisterDeviceHandler);

export default router;
