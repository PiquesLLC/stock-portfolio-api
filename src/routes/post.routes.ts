import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireNotSuspended } from '../middleware/suspension.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';
import * as ctrl from '../controllers/post.controller';

const router = Router();

// Write operations: require not suspended
router.post('/', requireAuth, requireNotSuspended, mutationLimiter, ctrl.createPostHandler);

// Read operations: no suspension check
router.get('/feed', requireAuth, ctrl.getEnhancedFeedHandler);
router.get('/trending-tickers', requireAuth, ctrl.getTrendingTickersHandler);
router.get('/community-trades', requireAuth, ctrl.getCommunityTradesHandler);
router.get('/notifications', requireAuth, ctrl.getSocialNotificationsHandler);
router.get('/notifications/unread', requireAuth, ctrl.getUnreadSocialNotifCountHandler);
router.post('/notifications/:id/read', requireAuth, ctrl.markSocialNotifReadHandler);
router.post('/notifications/read-all', requireAuth, ctrl.markAllSocialNotifsReadHandler);
router.get('/:postId', requireAuth, ctrl.getPostHandler);

// Write operations: require not suspended
router.delete('/:postId', requireAuth, requireNotSuspended, mutationLimiter, ctrl.deletePostHandler);
router.post('/:postId/comments', requireAuth, requireNotSuspended, mutationLimiter, ctrl.createCommentHandler);
router.get('/:postId/comments', requireAuth, ctrl.getCommentsHandler);
router.delete('/comments/:commentId', requireAuth, requireNotSuspended, mutationLimiter, ctrl.deleteCommentHandler);
router.post('/:postId/like', requireAuth, requireNotSuspended, mutationLimiter, ctrl.toggleLikeHandler);

// Read operations: no suspension check
router.get('/user/:userId', requireAuth, ctrl.getUserPostsHandler);

export default router;
