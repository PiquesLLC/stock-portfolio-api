import { Router } from 'express';
import express from 'express';
import { appleVerifyHandler, appleRestoreHandler, appleWebhookHandler } from '../controllers/apple-iap.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { billingMutationLimiter, billingWebhookLimiter } from '../middleware/rateLimiter';

const router = Router();

// Authenticated — verify/restore purchases
router.post('/apple-verify', billingMutationLimiter, requireAuth, appleVerifyHandler);
router.post('/apple-restore', billingMutationLimiter, requireAuth, appleRestoreHandler);

// Apple webhook — no auth, raw body for JWS verification
router.post('/apple-webhook', billingWebhookLimiter, express.raw({ type: 'application/json' }), appleWebhookHandler);

export default router;
