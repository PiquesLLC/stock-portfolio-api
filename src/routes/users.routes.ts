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
} from '../controllers/social.controller';
import { getUserIntelligenceHandler } from '../controllers/portfolioIntelligence.controller';

const router = Router();

router.get('/', getUsersHandler);
router.get('/:userId/portfolio', getUserPortfolioHandler);
router.get('/:userId/chart', getUserChartHandler);
router.get('/:userId/profile', getProfileHandler);
router.post('/:userId/follow', followHandler);
router.delete('/:userId/follow', unfollowHandler);
router.get('/:userId/is-following', isFollowingHandler);
router.get('/:userId/followers', getFollowersHandler);
router.get('/:userId/following', getFollowingHandler);
router.put('/:userId/region', updateRegionHandler);
router.put('/:userId/holdings-visibility', updateHoldingsVisibilityHandler);
router.get('/:userId/intelligence', getUserIntelligenceHandler);

export default router;
