import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';
import * as ctrl from '../controllers/post.controller';

const router = Router();

router.post('/', requireAuth, mutationLimiter, ctrl.createPostHandler);
router.get('/feed', requireAuth, ctrl.getEnhancedFeedHandler);
router.get('/trending-tickers', requireAuth, ctrl.getTrendingTickersHandler);
router.get('/notifications', requireAuth, ctrl.getSocialNotificationsHandler);
router.get('/notifications/unread', requireAuth, ctrl.getUnreadSocialNotifCountHandler);
router.post('/notifications/:id/read', requireAuth, ctrl.markSocialNotifReadHandler);
router.post('/notifications/read-all', requireAuth, ctrl.markAllSocialNotifsReadHandler);
router.get('/:postId', requireAuth, ctrl.getPostHandler);
router.delete('/:postId', requireAuth, mutationLimiter, ctrl.deletePostHandler);
router.post('/:postId/comments', requireAuth, mutationLimiter, ctrl.createCommentHandler);
router.get('/:postId/comments', requireAuth, ctrl.getCommentsHandler);
router.delete('/comments/:commentId', requireAuth, mutationLimiter, ctrl.deleteCommentHandler);
router.post('/:postId/like', requireAuth, mutationLimiter, ctrl.toggleLikeHandler);
router.get('/user/:userId', requireAuth, ctrl.getUserPostsHandler);

export default router;
