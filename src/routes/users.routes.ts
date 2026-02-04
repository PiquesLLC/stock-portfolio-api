import { Router } from 'express';
import { getUsersHandler, getUserPortfolioHandler, getUserChartHandler, updateHoldingsVisibilityHandler } from '../controllers/users.controller';
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
} from '../controllers/social.controller';
import { getUserIntelligenceHandler } from '../controllers/portfolioIntelligence.controller';
import { requireAuth, optionalAuth } from '../middleware/auth.middleware';

const router = Router();

// Public endpoints
router.get('/', getUsersHandler);
router.get('/:userId/portfolio', optionalAuth, getUserPortfolioHandler);
router.get('/:userId/chart', optionalAuth, getUserChartHandler);
router.get('/:userId/profile', optionalAuth, getProfileHandler);
router.get('/:userId/is-following', optionalAuth, isFollowingHandler);
router.get('/:userId/followers', getFollowersHandler);
router.get('/:userId/following', getFollowingHandler);
router.get('/:userId/settings', optionalAuth, getUserSettingsHandler);
router.get('/:userId/intelligence', optionalAuth, getUserIntelligenceHandler);

// Protected endpoints (require authentication)
router.post('/:userId/follow', requireAuth, followHandler);
router.delete('/:userId/follow', requireAuth, unfollowHandler);
router.put('/:userId/region', requireAuth, updateRegionHandler);
router.put('/:userId/holdings-visibility', requireAuth, updateHoldingsVisibilityHandler);
router.put('/:userId/settings', requireAuth, updateUserSettingsHandler);

export default router;
