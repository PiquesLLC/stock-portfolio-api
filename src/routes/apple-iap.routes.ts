import { Router } from 'express';
import express from 'express';
import {
  applePurchaseContextHandler,
  appleVerifyHandler,
  appleRestoreHandler,
  appleWebhookHandler,
} from '../controllers/apple-iap.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { billingMutationLimiter, billingWebhookLimiter } from '../middleware/rateLimiter';

const router = Router();

// Authenticated — purchase context, then verify/restore
//
// purchase-context is what the app calls BEFORE StoreKit: it returns the
// server-issued appAccountToken that later proves the purchase belongs to this
// account. Same auth + mutation rate limit as the other two.
router.post('/apple-purchase-context', billingMutationLimiter, requireAuth, applePurchaseContextHandler);
router.post('/apple-verify', billingMutationLimiter, requireAuth, appleVerifyHandler);
router.post('/apple-restore', billingMutationLimiter, requireAuth, appleRestoreHandler);

// Apple webhook — no auth, raw body for JWS verification
router.post('/apple-webhook', billingWebhookLimiter, express.raw({ type: 'application/json' }), appleWebhookHandler);

export default router;
