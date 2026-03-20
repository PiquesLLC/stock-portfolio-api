import prisma from '../utils/prisma';
import { createSocialNotification } from './post.service';



export async function followUser(followerId: string, followingId: string): Promise<void> {
  if (followerId === followingId) {
    throw new Error('Cannot follow yourself');
  }

  // Verify both users exist
  const [follower, following] = await Promise.all([
    prisma.user.findUnique({ where: { id: followerId }, select: { id: true } }),
    prisma.user.findUnique({ where: { id: followingId }, select: { id: true } }),
  ]);
  if (!follower) throw new Error('Follower user not found');
  if (!following) throw new Error('User to follow not found');

  await prisma.follow.upsert({
    where: {
      followerId_followingId: { followerId, followingId },
    },
    update: {},
    create: { followerId, followingId },
  });

  const actor = await prisma.user.findUnique({ where: { id: followerId }, select: { displayName: true } });
  createSocialNotification(
    followingId,
    followerId,
    'new_follower',
    null,
    `${actor?.displayName || 'Someone'} started following you`
  ).catch(err => console.error('[Follow] Notification failed:', err?.message || err));
}

export async function unfollowUser(followerId: string, followingId: string): Promise<void> {
  await prisma.follow.deleteMany({
    where: { followerId, followingId },
  });
}

export async function isFollowing(followerId: string, followingId: string): Promise<boolean> {
  const follow = await prisma.follow.findUnique({
    where: {
      followerId_followingId: { followerId, followingId },
    },
  });
  return !!follow;
}

export async function getFollowers(userId: string): Promise<{ id: string; username: string; displayName: string }[]> {
  const follows = await prisma.follow.findMany({
    where: { followingId: userId },
    include: {
      follower: {
        select: { id: true, username: true, displayName: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return follows.map((f) => f.follower);
}

export async function getFollowing(userId: string): Promise<{ id: string; username: string; displayName: string }[]> {
  const follows = await prisma.follow.findMany({
    where: { followerId: userId },
    include: {
      following: {
        select: { id: true, username: true, displayName: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return follows.map((f) => f.following);
}

export async function getFollowCounts(userId: string): Promise<{ followers: number; following: number }> {
  const [followers, following] = await Promise.all([
    prisma.follow.count({ where: { followingId: userId } }),
    prisma.follow.count({ where: { followerId: userId } }),
  ]);
  return { followers, following };
}

export async function getFollowingIds(userId: string): Promise<string[]> {
  const follows = await prisma.follow.findMany({
    where: { followerId: userId },
    select: { followingId: true },
  });
  return follows.map((f) => f.followingId);
}

