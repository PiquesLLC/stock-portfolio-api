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
  discoverCreatorsHandler,
  getCreatorEntitlementHandler,
  getCreatorLedgerHandler,
  getCreatorLockedContentHandler,
  getCreatorPayoutBalanceHandler,
  getCreatorProfileHandler,
  getCreatorSetupStatusHandler,
  getMyCreatorSubscriptionsHandler,
  reportCreatorHandler,
  requestCreatorPayoutHandler,
  selfActivateCreatorHandler,
  subscribeToCreatorHandler,
  updateCreatorSettingsHandler,
} from '../controllers/creator.controller';

const router = Router();

router.post('/webhooks/stripe', billingWebhookLimiter, express.raw({ type: 'application/json' }), creatorStripeWebhookHandler);

router.get('/discover', heavyReadLimiter, optionalAuth, discoverCreatorsHandler);
router.get('/setup-status', heavyReadLimiter, requireAuth, getCreatorSetupStatusHandler);
router.post('/self-activate', mutationLimiter, requireAuth, selfActivateCreatorHandler);
router.post('/apply', mutationLimiter, requireAuth, applyCreatorHandler);
router.get('/dashboard', heavyReadLimiter, requireAuth, creatorDashboardHandler);
router.patch('/settings', mutationLimiter, requireAuth, updateCreatorSettingsHandler);
router.post('/connect-onboarding', mutationLimiter, requireAuth, connectOnboardingHandler);
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
