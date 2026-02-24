import { Router } from 'express';
import express from 'express';
import {
  createCheckoutHandler,
  createPortalHandler,
  getBillingStatusHandler,
  getPricesHandler,
  billingWebhookHandler,
} from '../controllers/billing.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { billingMutationLimiter, billingWebhookLimiter } from '../middleware/rateLimiter';

const router = Router();

router.get('/prices', getPricesHandler);
router.post('/checkout', billingMutationLimiter, requireAuth, createCheckoutHandler);
router.post('/portal', billingMutationLimiter, requireAuth, createPortalHandler);
router.get('/status', billingMutationLimiter, requireAuth, getBillingStatusHandler);
router.post('/webhook', billingWebhookLimiter, express.raw({ type: 'application/json' }), billingWebhookHandler);

export default router;
