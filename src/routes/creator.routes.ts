import express, { Router } from 'express';
import { optionalAuth, requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';
import { requireCreator } from '../middleware/creator.middleware';
import {
  applyCreatorHandler,
  cancelCreatorSubscriptionHandler,
  connectOnboardingHandler,
  creatorDashboardHandler,
  creatorStripeWebhookHandler,
  getCreatorEntitlementHandler,
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

router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), creatorStripeWebhookHandler);

router.post('/apply', mutationLimiter, requireAuth, applyCreatorHandler);
router.get('/dashboard', requireAuth, requireCreator, creatorDashboardHandler);
router.patch('/settings', mutationLimiter, requireAuth, requireCreator, updateCreatorSettingsHandler);
router.post('/connect-onboarding', mutationLimiter, requireAuth, requireCreator, connectOnboardingHandler);
router.post('/payout', mutationLimiter, requireAuth, requireCreator, requestCreatorPayoutHandler);
router.get('/payout/balance', requireAuth, requireCreator, getCreatorPayoutBalanceHandler);
router.get('/my-subscriptions', requireAuth, getMyCreatorSubscriptionsHandler);
router.get('/:userId', optionalAuth, getCreatorProfileHandler);
router.get('/:userId/entitlement', optionalAuth, getCreatorEntitlementHandler);
router.get('/:userId/locked-content', requireAuth, getCreatorLockedContentHandler);
router.post('/:userId/subscribe', mutationLimiter, requireAuth, subscribeToCreatorHandler);
router.delete('/:userId/subscribe', mutationLimiter, requireAuth, cancelCreatorSubscriptionHandler);
router.post('/:userId/report', mutationLimiter, requireAuth, reportCreatorHandler);

export default router;
