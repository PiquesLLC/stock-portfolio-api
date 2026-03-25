import prisma from '../utils/prisma';
import { sendPushToUser, sendNativePushToUser } from './push.service';
import { sanitizeContent, filterContent } from '../utils/content-filter';
import { getBlockedUserIds } from './block.service';

// ── Social Notifications ──────────────────────────────────────

export async function createSocialNotification(
  recipientId: string,
  actorId: string,
  type: string,
  postId: string | null,
  message: string
): Promise<void> {
  if (recipientId === actorId) return;

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // 1hr dedup check — use explicit null filter (not undefined which Prisma ignores)
  const dedupWhere: Record<string, unknown> = {
    userId: recipientId,
    actorId,
    type,
    createdAt: { gte: oneHourAgo },
  };
  if (postId != null) {
    dedupWhere.postId = postId;
  } else {
    dedupWhere.postId = null;
  }
  const recent = await prisma.socialNotification.findFirst({ where: dedupWhere });
  if (recent) return;

  // Anti-spam: max 5 notifications of same type from same actor per hour
  const recentCount = await prisma.socialNotification.count({
    where: { userId: recipientId, actorId, type, createdAt: { gte: oneHourAgo } },
  });
  if (recentCount >= 5) return;

  // Cross-type anti-spam: max 10 total notifications from same actor per hour
  const totalFromActor = await prisma.socialNotification.count({
    where: { userId: recipientId, actorId, createdAt: { gte: oneHourAgo } },
  });
  if (totalFromActor >= 10) return;

  await prisma.socialNotification.create({
    data: { userId: recipientId, actorId, type, postId, message },
  });

  // Fire-and-forget push (truncate body for APNs 4KB limit)
  const payload = { title: 'Nala', body: message.slice(0, 200), tag: `social-${type}`, data: { type: 'social', url: '/' } };
  sendPushToUser(recipientId, payload).catch(() => {});
  sendNativePushToUser(recipientId, payload).catch(() => {});
}

// ── Post CRUD ─────────────────────────────────────────────────

export async function createPost(userId: string, content: string, ticker?: string, type?: string, attachmentType?: string, attachmentData?: Record<string, unknown>) {
  // Content moderation — reject before persisting
  const filterResult = filterContent(content);
  if (!filterResult.allowed) {
    throw Object.assign(
      new Error('Your post was blocked by our content policy. Please review our community guidelines.'),
      { status: 400, code: 'content_policy_violation', reason: filterResult.reason, severity: filterResult.severity },
    );
  }

  return prisma.post.create({
    data: {
      userId,
      content: sanitizeContent(content.slice(0, 1000)),
      ticker: ticker?.toUpperCase() || null,
      type: type || 'thought',
      attachmentType: attachmentType || null,
      attachmentData: attachmentData ? JSON.stringify(attachmentData) : null,
    },
  });
}

export async function getPost(postId: string, viewerUserId?: string) {
  const post = await prisma.post.findFirst({
    where: { id: postId, deleted: false },
    include: {
      user: { select: { id: true, username: true, displayName: true, avatarUrl: true, profilePublic: true } },
      _count: { select: { comments: { where: { deleted: false } }, likes: true } },
    },
  });
  if (!post) return null;

  // Privacy: don't expose posts from private profiles to non-owners
  if (!post.user.profilePublic && post.userId !== viewerUserId) return null;

  let viewerLiked = false;
  if (viewerUserId) {
    const like = await prisma.like.findUnique({
      where: { postId_userId: { postId, userId: viewerUserId } },
    });
    viewerLiked = !!like;
  }

  // Strip internal fields before returning
  const { _count, user: { profilePublic: _pp, ...safeUser }, ...rest } = post;
  return {
    ...rest,
    user: safeUser,
    likeCount: _count.likes,
    commentCount: _count.comments,
    viewerLiked,
  };
}

export async function deletePost(userId: string, postId: string): Promise<boolean> {
  const post = await prisma.post.findFirst({ where: { id: postId, userId } });
  if (!post) return false;
  await prisma.post.update({ where: { id: postId }, data: { deleted: true } });
  return true;
}

export async function getUserPosts(userId: string, limit = 20, before?: string, viewerUserId?: string) {
  const where: any = { userId, deleted: false };
  if (before) where.createdAt = { lt: new Date(before) };

  let posts = await prisma.post.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      _count: { select: { comments: { where: { deleted: false } }, likes: true } },
    },
  });

  // Filter out trade-bearing posts from paid creators if viewer isn't subscribed
  if (viewerUserId !== userId) {
    const creator = await prisma.creator.findUnique({
      where: { userId },
      select: { status: true, pricingCents: true },
    });
    if (creator?.status === 'active' && creator.pricingCents > 0) {
      const now = new Date();
      const sub = viewerUserId
        ? await prisma.creatorSubscription.findFirst({
            where: {
              subscriberUserId: viewerUserId,
              creatorUserId: userId,
              status: { in: ['active', 'canceled', 'trialing', 'past_due'] },
              OR: [
                { trialEnd: { gt: now } },
                { currentPeriodEnd: null, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
                { currentPeriodEnd: { gt: now } },
              ],
            },
          })
        : null;
      if (!sub) {
        posts = posts.filter(p => p.attachmentType !== 'trade');
      }
    }
  }

  return posts.map(p => ({
    ...p,
    likeCount: p._count.likes,
    commentCount: p._count.comments,
  }));
}

// ── Comments ──────────────────────────────────────────────────

export async function createComment(userId: string, postId: string, content: string) {
  // Content moderation — reject before persisting
  const filterResult = filterContent(content);
  if (!filterResult.allowed) {
    throw Object.assign(
      new Error('Your comment was blocked by our content policy. Please review our community guidelines.'),
      { status: 400, code: 'content_policy_violation', reason: filterResult.reason, severity: filterResult.severity },
    );
  }

  const post = await prisma.post.findFirst({
    where: { id: postId, deleted: false },
    include: { user: { select: { profilePublic: true } } },
  });
  if (!post) throw Object.assign(new Error('Post not found'), { status: 404 });
  if (!post.user.profilePublic && post.userId !== userId) {
    throw Object.assign(new Error('Post not found'), { status: 404 });
  }

  // Block check: prevent commenting on posts by users who blocked the commenter, or vice versa
  const block = await prisma.userBlock.findFirst({
    where: {
      OR: [
        { blockerId: post.userId, blockedId: userId },
        { blockerId: userId, blockedId: post.userId },
      ],
    },
  });
  if (block) throw Object.assign(new Error('Post not found'), { status: 404 });

  const comment = await prisma.comment.create({
    data: {
      postId,
      userId,
      content: sanitizeContent(content.slice(0, 500)),
    },
    include: {
      user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
    },
  });

  // Notify post author
  const actor = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
  await createSocialNotification(
    post.userId,
    userId,
    'comment',
    postId,
    `${actor?.displayName || 'Someone'} commented on your post`
  );

  return comment;
}

export async function getComments(postId: string, viewerUserId: string, limit = 50, before?: string) {
  // Privacy: verify the post's author has a public profile (or viewer is author)
  const post = await prisma.post.findFirst({
    where: { id: postId, deleted: false },
    select: { userId: true, user: { select: { profilePublic: true } } },
  });
  if (!post) return [];
  if (!post.user.profilePublic && post.userId !== viewerUserId) return [];

  // Exclude comments from blocked users
  const blockedIds = await getBlockedUserIds(viewerUserId);

  const where: any = { postId, deleted: false };
  if (before) where.createdAt = { lt: new Date(before) };
  if (blockedIds.length > 0) {
    where.userId = { notIn: blockedIds };
  }

  return prisma.comment.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: limit,
    include: {
      user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
    },
  });
}

export async function deleteComment(userId: string, commentId: string): Promise<boolean> {
  const comment = await prisma.comment.findFirst({ where: { id: commentId, userId } });
  if (!comment) return false;
  await prisma.comment.update({ where: { id: commentId }, data: { deleted: true } });
  return true;
}

// ── Likes ─────────────────────────────────────────────────────

export async function toggleLike(userId: string, postId: string): Promise<{ liked: boolean; likeCount: number }> {
  const post = await prisma.post.findFirst({
    where: { id: postId, deleted: false },
    include: { user: { select: { profilePublic: true } } },
  });
  if (!post) throw Object.assign(new Error('Post not found'), { status: 404 });
  if (!post.user.profilePublic && post.userId !== userId) {
    throw Object.assign(new Error('Post not found'), { status: 404 });
  }

  // Block check: prevent liking posts by users who blocked the liker, or vice versa
  const block = await prisma.userBlock.findFirst({
    where: {
      OR: [
        { blockerId: post.userId, blockedId: userId },
        { blockerId: userId, blockedId: post.userId },
      ],
    },
  });
  if (block) throw Object.assign(new Error('Post not found'), { status: 404 });

  const existing = await prisma.like.findUnique({
    where: { postId_userId: { postId, userId } },
  });

  let liked: boolean;
  if (existing) {
    await prisma.like.delete({ where: { id: existing.id } }).catch(() => {});
    liked = false;
  } else {
    try {
      await prisma.like.create({ data: { postId, userId } });
      liked = true;
      // Notify post author on like (fire-and-forget)
      const actor = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
      createSocialNotification(
        post.userId,
        userId,
        'like',
        postId,
        `${actor?.displayName || 'Someone'} liked your post`
      ).catch(() => {});
    } catch {
      // Unique constraint violation — concurrent like request, treat as already liked
      liked = true;
    }
  }

  const likeCount = await prisma.like.count({ where: { postId } });
  return { liked, likeCount };
}

// ── Enhanced Feed ─────────────────────────────────────────────

export async function getEnhancedFeed(userId: string, limit = 30, before?: string) {
  // Get followed user IDs (only public profiles) + include self
  const follows = await prisma.follow.findMany({
    where: {
      followerId: userId,
      following: { profilePublic: true },
    },
    select: { followingId: true },
  });

  // Exclude blocked users from the feed
  const blockedIds = await getBlockedUserIds(userId);
  const blockedSet = new Set(blockedIds);
  const followedIds = [...new Set([userId, ...follows.map(f => f.followingId)])].filter(id => !blockedSet.has(id));

  const beforeDate = before ? new Date(before) : new Date();

  // Fetch posts from followed users
  const posts = await prisma.post.findMany({
    where: {
      userId: { in: followedIds },
      deleted: false,
      createdAt: { lt: beforeDate },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      _count: { select: { comments: { where: { deleted: false } }, likes: true } },
    },
  });

  // Check viewer likes
  const postIds = posts.map(p => p.id);
  const viewerLikes = postIds.length > 0
    ? await prisma.like.findMany({ where: { postId: { in: postIds }, userId } })
    : [];
  const likedSet = new Set(viewerLikes.map(l => l.postId));

  // Apply trade delay + subscription gate for creator content
  const MINIMUM_DELAY_HOURS = 24;
  const creators = await prisma.creator.findMany({
    where: { userId: { in: followedIds }, status: 'active' },
    select: { userId: true, pricingCents: true, visibility: { select: { tradeDelayHours: true } } },
  });
  const creatorDelayMap = new Map<string, number>();
  const paidCreatorIds = new Set<string>();
  for (const c of creators) {
    const configured = c.visibility?.tradeDelayHours ?? MINIMUM_DELAY_HOURS;
    creatorDelayMap.set(c.userId, Math.max(configured, MINIMUM_DELAY_HOURS));
    if (c.pricingCents > 0) paidCreatorIds.add(c.userId);
  }

  // Check which paid creators the viewer is subscribed to
  const subscribedCreatorIds = new Set<string>();
  if (paidCreatorIds.size > 0) {
    const now = new Date();
    const subs = await prisma.creatorSubscription.findMany({
      where: {
        subscriberUserId: userId,
        creatorUserId: { in: [...paidCreatorIds] },
        status: { in: ['active', 'canceled', 'trialing', 'past_due'] },
        OR: [
          { trialEnd: { gt: now } },
          { currentPeriodEnd: null, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
          { currentPeriodEnd: { gt: now } },
        ],
      },
      select: { creatorUserId: true },
    });
    for (const s of subs) subscribedCreatorIds.add(s.creatorUserId);
  }

  // Fetch activity events from followed users
  const activities = await prisma.activityEvent.findMany({
    where: {
      userId: { in: followedIds },
      createdAt: { lt: beforeDate },
    },
    orderBy: { createdAt: 'desc' },
    take: limit * 2,
    include: {
      user: { select: { id: true, username: true, displayName: true } },
    },
  });

  // Filter activities: trade delay + paid creator subscription gate
  const nowMs = Date.now();
  const delayedActivities = activities.filter(a => {
    // Paid creator whose trades are behind a subscription — hide from non-subscribers
    if (paidCreatorIds.has(a.userId) && !subscribedCreatorIds.has(a.userId)) return false;

    const delayHours = creatorDelayMap.get(a.userId);
    if (delayHours == null) return true; // Non-creator: no delay
    const cutoff = nowMs - delayHours * 60 * 60 * 1000;
    return a.createdAt.getTime() <= cutoff;
  }).slice(0, limit);

  // Filter posts: trade-attachment posts from paid creators are hidden from non-subscribers
  const filteredPosts = posts.filter(p => {
    if (
      p.attachmentType === 'trade' &&
      paidCreatorIds.has(p.userId) &&
      !subscribedCreatorIds.has(p.userId) &&
      p.userId !== userId // never filter own posts
    ) {
      return false;
    }
    return true;
  });

  // Merge and sort by createdAt
  const feedItems = [
    ...filteredPosts.map(p => ({
      kind: 'post' as const,
      id: p.id,
      createdAt: p.createdAt.toISOString(),
      post: {
        ...p,
        likeCount: p._count.likes,
        commentCount: p._count.comments,
        viewerLiked: likedSet.has(p.id),
      },
    })),
    ...delayedActivities.map(a => {
      let payload = {};
      try { payload = JSON.parse(a.payload); } catch { /* malformed payload */ }
      return {
        kind: 'activity' as const,
        id: a.id,
        createdAt: a.createdAt.toISOString(),
        activity: {
          id: a.id,
          userId: a.userId,
          username: a.user.username,
          displayName: a.user.displayName,
          type: a.type,
          payload,
          createdAt: a.createdAt.toISOString(),
        },
      };
    }),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);

  return feedItems;
}

// ── Social Notifications ──────────────────────────────────────

export async function getSocialNotifications(userId: string, limit = 50) {
  // Exclude notifications from blocked users
  const blockedIds = await getBlockedUserIds(userId);

  const where: any = { userId };
  if (blockedIds.length > 0) {
    where.actorId = { notIn: blockedIds };
  }

  return prisma.socialNotification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      actor: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
    },
  });
}

export async function getUnreadSocialNotifCount(userId: string): Promise<number> {
  return prisma.socialNotification.count({
    where: { userId, read: false },
  });
}

export async function markSocialNotifRead(userId: string, id: string): Promise<boolean> {
  const notif = await prisma.socialNotification.findFirst({ where: { id, userId } });
  if (!notif) return false;
  await prisma.socialNotification.update({ where: { id }, data: { read: true } });
  return true;
}

export async function markAllSocialNotifsRead(userId: string): Promise<void> {
  await prisma.socialNotification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
}

// ── Trending Tickers ──────────────────────────────────────────

export async function getTrendingTickers(hours = 24, limit = 10, viewerUserId?: string) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  // Identify paid creators the viewer is NOT subscribed to — their trade posts should be excluded
  const excludedCreatorIds = new Set<string>();
  const paidCreators = await prisma.creator.findMany({
    where: { status: 'active', pricingCents: { gt: 0 } },
    select: { userId: true },
  });
  if (paidCreators.length > 0) {
    const paidIds = paidCreators.map(c => c.userId);
    const subscribedIds = new Set<string>();
    if (viewerUserId) {
      const now = new Date();
      const subs = await prisma.creatorSubscription.findMany({
        where: {
          subscriberUserId: viewerUserId,
          creatorUserId: { in: paidIds },
          status: { in: ['active', 'canceled', 'trialing', 'past_due'] },
          OR: [
            { trialEnd: { gt: now } },
            { currentPeriodEnd: null, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
            { currentPeriodEnd: { gt: now } },
          ],
        },
        select: { creatorUserId: true },
      });
      for (const s of subs) subscribedIds.add(s.creatorUserId);
    }
    for (const c of paidCreators) {
      if (!subscribedIds.has(c.userId) && c.userId !== viewerUserId) {
        excludedCreatorIds.add(c.userId);
      }
    }
  }

  // Get all qualifying posts then filter in JS (SQLite doesn't support NOT IN with dynamic lists well via raw query)
  const results = await prisma.$queryRaw<{ ticker: string; count: number; userId: string }[]>`
    SELECT ticker, COUNT(*) as count FROM Post
    WHERE ticker IS NOT NULL AND deleted = 0 AND createdAt >= ${since}
    GROUP BY ticker ORDER BY count DESC LIMIT ${limit * 3}`;

  if (excludedCreatorIds.size === 0) {
    return results.slice(0, limit);
  }

  // Re-query with per-post data to filter out trade posts from excluded creators
  const posts = await prisma.post.findMany({
    where: {
      ticker: { not: null },
      deleted: false,
      createdAt: { gte: since },
    },
    select: { ticker: true, userId: true, type: true, attachmentType: true },
  });

  const tickerCounts = new Map<string, number>();
  for (const p of posts) {
    if (!p.ticker) continue;
    // Exclude trade-type posts from paid creators viewer isn't subscribed to
    if (p.attachmentType === 'trade' && excludedCreatorIds.has(p.userId)) continue;
    tickerCounts.set(p.ticker, (tickerCounts.get(p.ticker) || 0) + 1);
  }

  return [...tickerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([ticker, count]) => ({ ticker, count }));
}

// ── Community Trade Activity ─────────────────────────────────

export async function getCommunityTradeActivity(hours = 168, limit = 6, viewerUserId?: string) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  // Identify paid creators the viewer is NOT subscribed to
  const excludedCreatorIds = new Set<string>();
  const paidCreators = await prisma.creator.findMany({
    where: { status: 'active', pricingCents: { gt: 0 } },
    select: { userId: true },
  });
  if (paidCreators.length > 0) {
    const paidIds = paidCreators.map(c => c.userId);
    const subscribedIds = new Set<string>();
    if (viewerUserId) {
      const now = new Date();
      const subs = await prisma.creatorSubscription.findMany({
        where: {
          subscriberUserId: viewerUserId,
          creatorUserId: { in: paidIds },
          status: { in: ['active', 'canceled', 'trialing', 'past_due'] },
          OR: [
            { trialEnd: { gt: now } },
            { currentPeriodEnd: null, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
            { currentPeriodEnd: { gt: now } },
          ],
        },
        select: { creatorUserId: true },
      });
      for (const s of subs) subscribedIds.add(s.creatorUserId);
    }
    for (const c of paidCreators) {
      if (!subscribedIds.has(c.userId) && c.userId !== viewerUserId) {
        excludedCreatorIds.add(c.userId);
      }
    }
  }

  const events = await prisma.activityEvent.findMany({
    where: { createdAt: { gte: since } },
    select: { type: true, payload: true, userId: true },
  });

  const buys = new Map<string, number>();
  const sells = new Map<string, number>();

  for (const e of events) {
    // Filter out events from paid creators the viewer isn't subscribed to
    if (excludedCreatorIds.has(e.userId)) continue;

    let payload: { ticker?: string };
    try { payload = JSON.parse(e.payload); } catch { continue; }
    if (!payload.ticker || /^[0-9a-f]{8}-/i.test(payload.ticker)) continue;

    const ticker = payload.ticker.toUpperCase();
    if (e.type === 'holding_added') {
      buys.set(ticker, (buys.get(ticker) || 0) + 1);
    } else if (e.type === 'holding_removed') {
      sells.set(ticker, (sells.get(ticker) || 0) + 1);
    }
  }

  const sortedBuys = [...buys.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([ticker, count]) => ({ ticker, count }));
  const sortedSells = [...sells.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([ticker, count]) => ({ ticker, count }));

  return { mostBought: sortedBuys, mostSold: sortedSells };
}
