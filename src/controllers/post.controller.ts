import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import prisma from '../utils/prisma';
import { createPostBodySchema, createCommentBodySchema } from '../validators/post.validators';
import {
  createPost,
  getPost,
  deletePost,
  getUserPosts,
  getEnhancedFeed,
  createComment,
  getComments,
  deleteComment,
  toggleLike,
  getSocialNotifications,
  getUnreadSocialNotifCount,
  markSocialNotifRead,
  markAllSocialNotifsRead,
  getTrendingTickers,
  getCommunityTradeActivity,
} from '../services/post.service';

function isValidDateParam(value: string | undefined): boolean {
  if (!value) return true;
  return !isNaN(new Date(value).getTime());
}

export async function createPostHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

    const parsed = createPostBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { content, ticker, type, attachmentType, attachmentData } = parsed.data;
    const post = await createPost(userId, content, ticker, type, attachmentType, attachmentData as Record<string, unknown>);
    res.status(201).json(post);
  } catch (error: any) {
    const status = error.status || 500;
    console.error('Error creating post:', error.message || error, error.code || '', error.reason || '');
    // Only return specific error messages for known app errors (status < 500)
    // Generic message for unexpected errors to avoid leaking internals
    res.status(status).json({
      error: status < 500 ? (error.message || 'Failed to create post') : 'Failed to create post',
      code: status < 500 ? error.code : undefined,
    });
  }
}

export async function getPostHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

    const post = await getPost(req.params.postId, userId);
    if (!post) { res.status(404).json({ error: 'Post not found' }); return; }
    res.json(post);
  } catch (error: unknown) {
    console.error('Error getting post:');
    res.status(500).json({ error: 'Failed to get post' });
  }
}

export async function deletePostHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

    const deleted = await deletePost(userId, req.params.postId);
    if (!deleted) { res.status(404).json({ error: 'Post not found' }); return; }
    res.status(204).send();
  } catch (error: unknown) {
    console.error('Error deleting post:');
    res.status(500).json({ error: 'Failed to delete post' });
  }
}

export async function getEnhancedFeedHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

    const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
    const before = req.query.before as string | undefined;
    if (!isValidDateParam(before)) { res.status(400).json({ error: 'Invalid before date' }); return; }
    const items = await getEnhancedFeed(userId, limit, before);
    res.json({ items });
  } catch (error: unknown) {
    console.error('Error getting feed:');
    res.status(500).json({ error: 'Failed to get feed' });
  }
}

export async function getUserPostsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

    const targetUserId = req.params.userId;

    // Privacy check: don't return posts for private profiles (unless owner)
    if (targetUserId !== userId) {
      const targetUser = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { profilePublic: true },
      });
      if (!targetUser || !targetUser.profilePublic) {
        res.json({ posts: [] });
        return;
      }
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const before = req.query.before as string | undefined;
    if (!isValidDateParam(before)) { res.status(400).json({ error: 'Invalid before date' }); return; }
    const posts = await getUserPosts(targetUserId, limit, before, userId);
    res.json({ posts });
  } catch (error: unknown) {
    console.error('Error getting user posts:');
    res.status(500).json({ error: 'Failed to get user posts' });
  }
}

export async function createCommentHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

    const parsed = createCommentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const comment = await createComment(userId, req.params.postId, parsed.data.content);
    res.status(201).json(comment);
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message || 'Failed to create comment' });
  }
}

export async function getCommentsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const before = req.query.before as string | undefined;
    if (!isValidDateParam(before)) { res.status(400).json({ error: 'Invalid before date' }); return; }
    const comments = await getComments(req.params.postId, userId, limit, before);
    res.json({ comments });
  } catch (error: unknown) {
    console.error('Error getting comments:');
    res.status(500).json({ error: 'Failed to get comments' });
  }
}

export async function deleteCommentHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

    const deleted = await deleteComment(userId, req.params.commentId);
    if (!deleted) { res.status(404).json({ error: 'Comment not found' }); return; }
    res.status(204).send();
  } catch (error: unknown) {
    console.error('Error deleting comment:');
    res.status(500).json({ error: 'Failed to delete comment' });
  }
}

export async function toggleLikeHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

    const result = await toggleLike(userId, req.params.postId);
    res.json(result);
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message || 'Failed to toggle like' });
  }
}

export async function getSocialNotificationsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const notifications = await getSocialNotifications(userId, limit);
    res.json({ notifications });
  } catch {
    // Table may not exist yet — return empty
    res.json({ notifications: [] });
  }
}

export async function getUnreadSocialNotifCountHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

    const count = await getUnreadSocialNotifCount(userId);
    res.json({ count });
  } catch {
    // Table may not exist yet (migration pending) — return 0 instead of 500
    res.json({ count: 0 });
  }
}

export async function markSocialNotifReadHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

    const ok = await markSocialNotifRead(userId, req.params.id);
    if (!ok) { res.status(404).json({ error: 'Notification not found' }); return; }
    res.json({ ok: true });
  } catch (error: unknown) {
    console.error('Error marking notification read:');
    res.status(500).json({ error: 'Failed to mark notification read' });
  }
}

export async function markAllSocialNotifsReadHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

    await markAllSocialNotifsRead(userId);
    res.json({ ok: true });
  } catch (error: unknown) {
    console.error('Error marking all notifications read:');
    res.status(500).json({ error: 'Failed to mark all notifications read' });
  }
}

export async function getTrendingTickersHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const hours = Math.min(parseInt(req.query.hours as string) || 24, 168);
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const tickers = await getTrendingTickers(hours, limit);
    res.json({ tickers });
  } catch (error: unknown) {
    console.error('Error getting trending tickers:');
    res.status(500).json({ error: 'Failed to get trending tickers' });
  }
}

export async function getCommunityTradesHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const hours = Math.min(parseInt(req.query.hours as string) || 24, 168);
    const data = await getCommunityTradeActivity(hours);
    res.json(data);
  } catch (error: unknown) {
    console.error('Error getting community trades:');
    res.status(500).json({ error: 'Failed to get community trades' });
  }
}
