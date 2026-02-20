import express, { Router } from 'express';
import { optionalAuth, requireAuth } from '../middleware/auth.middleware';
import { billingWebhookLimiter, heavyReadLimiter, mutationLimiter } from '../middleware/rateLimiter';
import { requireCreator } from '../middleware/creator.middleware';
import {
  applyCreatorHandler,
  cancelCreatorSubscriptionHandler,
  connectOnboardingHandler,
  creatorDashboardHandler,
  creatorStripeWebhookHandler,
  getCreatorEntitlementHandler,
  getCreatorLedgerHandler,
  getCreatorLockedContentHandler,
  getCreatorPayoutBalanceHandler,
  getCreatorProfileHandler,
  getMyCreatorSubscriptionsHandler,
  reportCreatorHandler,
  requestCreatorPayoutHandler,
  subscribeToCreatorHandler,
  updateCreatorSettingsHandler,
} from '../controllers/creator.controller';

const router = Router();

router.post('/webhooks/stripe', billingWebhookLimiter, express.raw({ type: 'application/json' }), creatorStripeWebhookHandler);

router.post('/apply', mutationLimiter, requireAuth, applyCreatorHandler);
router.get('/dashboard', heavyReadLimiter, requireAuth, requireCreator, creatorDashboardHandler);
router.patch('/settings', mutationLimiter, requireAuth, requireCreator, updateCreatorSettingsHandler);
router.post('/connect-onboarding', mutationLimiter, requireAuth, requireCreator, connectOnboardingHandler);
router.post('/payout', mutationLimiter, requireAuth, requireCreator, requestCreatorPayoutHandler);
router.get('/payout/balance', heavyReadLimiter, requireAuth, requireCreator, getCreatorPayoutBalanceHandler);
router.get('/ledger', heavyReadLimiter, requireAuth, requireCreator, getCreatorLedgerHandler);
router.get('/my-subscriptions', heavyReadLimiter, requireAuth, getMyCreatorSubscriptionsHandler);
router.get('/:userId', heavyReadLimiter, optionalAuth, getCreatorProfileHandler);
router.get('/:userId/entitlement', heavyReadLimiter, optionalAuth, getCreatorEntitlementHandler);
router.get('/:userId/locked-content', heavyReadLimiter, requireAuth, getCreatorLockedContentHandler);
router.post('/:userId/subscribe', mutationLimiter, requireAuth, subscribeToCreatorHandler);
router.delete('/:userId/subscribe', mutationLimiter, requireAuth, cancelCreatorSubscriptionHandler);
router.post('/:userId/report', mutationLimiter, requireAuth, reportCreatorHandler);

export default router;
