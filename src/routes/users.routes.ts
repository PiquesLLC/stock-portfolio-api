import { Router } from 'express';
import { getUsersHandler, getUserPortfolioHandler, getUserChartHandler, updateHoldingsVisibilityHandler, getUserByUsernameHandler } from '../controllers/users.controller';
import {
  followHandler,
  unfollowHandler,
  isFollowingHandler,
  getFollowersHandler,
  getFollowingHandler,
  getProfileHandler,
  updateRegionHandler,
  getUserSettingsHandler,
  updateUserSettingsHandler,
  reportUserHandler,
} from '../controllers/social.controller';
import { getUserIntelligenceHandler } from '../controllers/portfolioIntelligence.controller';
import { requireAuth, optionalAuth } from '../middleware/auth.middleware';
import { mutationLimiter, enumerationLimiter } from '../middleware/rateLimiter';

const router = Router();

// Username lookup — MUST be before /:userId routes to avoid conflict
// optionalAuth needed so getUserByUsernameHandler can check if requester is the profile owner
router.get('/by-username/:username', enumerationLimiter, optionalAuth, getUserByUsernameHandler);

// Public endpoints (optionalAuth for privacy-respecting endpoints)
router.get('/', optionalAuth, getUsersHandler); // Only shows public profiles
router.get('/:userId/portfolio', optionalAuth, getUserPortfolioHandler); // Respects profilePublic
router.get('/:userId/chart', optionalAuth, getUserChartHandler);
router.get('/:userId/profile', optionalAuth, getProfileHandler); // Respects profilePublic
router.get('/:userId/is-following', optionalAuth, isFollowingHandler);
router.get('/:userId/followers', optionalAuth, getFollowersHandler);
router.get('/:userId/following', optionalAuth, getFollowingHandler);
router.get('/:userId/settings', requireAuth, getUserSettingsHandler); // Owner only
router.get('/:userId/intelligence', optionalAuth, getUserIntelligenceHandler);

// Protected endpoints (require authentication)
router.post('/:userId/follow', mutationLimiter, requireAuth, followHandler);
router.delete('/:userId/follow', mutationLimiter, requireAuth, unfollowHandler);
router.put('/:userId/region', mutationLimiter, requireAuth, updateRegionHandler);
router.put('/:userId/holdings-visibility', mutationLimiter, requireAuth, updateHoldingsVisibilityHandler);
router.put('/:userId/settings', mutationLimiter, requireAuth, updateUserSettingsHandler);
router.post('/:userId/report', mutationLimiter, requireAuth, reportUserHandler);

export default router;
