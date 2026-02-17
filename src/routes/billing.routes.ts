import { Router } from 'express';
import {
  createCheckoutHandler,
  createPortalHandler,
  getBillingStatusHandler,
  billingWebhookHandler,
} from '../controllers/billing.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter, webhookLimiter } from '../middleware/rateLimiter';

const router = Router();

router.post('/checkout', mutationLimiter, requireAuth, createCheckoutHandler);
router.post('/portal', mutationLimiter, requireAuth, createPortalHandler);
router.get('/status', requireAuth, getBillingStatusHandler);
router.post('/webhook', webhookLimiter, billingWebhookHandler);

export default router;
