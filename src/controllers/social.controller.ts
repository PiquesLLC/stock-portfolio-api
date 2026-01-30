import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import {
  followUser,
  unfollowUser,
  isFollowing,
  getFollowers,
  getFollowing,
  getFollowCounts,
} from '../services/follow.service';
import { getFeed, getUserActivity } from '../services/activity.service';
import { getPerformanceComparison } from '../services/benchmark.service';

const prisma = new PrismaClient();

// POST /users/:userId/follow
export async function followHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const { followerId } = req.body;
    if (!followerId) {
      res.status(400).json({ error: 'followerId is required' });
      return;
    }
    await followUser(followerId, userId);
    res.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to follow';
    res.status(400).json({ error: message });
  }
}

// DELETE /users/:userId/follow
export async function unfollowHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const { followerId } = req.body;
    if (!followerId) {
      res.status(400).json({ error: 'followerId is required' });
      return;
    }
    await unfollowUser(followerId, userId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error unfollowing:', error);
    res.status(500).json({ error: 'Failed to unfollow' });
  }
}

// GET /users/:userId/is-following?followerId=X
export async function isFollowingHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const followerId = req.query.followerId as string;
    if (!followerId) {
      res.status(400).json({ error: 'followerId query param is required' });
      return;
    }
    const following = await isFollowing(followerId, userId);
    res.json({ following });
  } catch (error) {
    console.error('Error checking follow:', error);
    res.status(500).json({ error: 'Failed to check follow status' });
  }
}

// GET /users/:userId/followers
export async function getFollowersHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const followers = await getFollowers(userId);
    res.json(followers);
  } catch (error) {
    console.error('Error getting followers:', error);
    res.status(500).json({ error: 'Failed to get followers' });
  }
}

// GET /users/:userId/following
export async function getFollowingHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const following = await getFollowing(userId);
    res.json(following);
  } catch (error) {
    console.error('Error getting following:', error);
    res.status(500).json({ error: 'Failed to get following' });
  }
}

// GET /users/:userId/profile
export async function getProfileHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const viewerId = req.query.viewerId as string | undefined;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        createdAt: true,
        profilePublic: true,
        trackingActive: true,
        leaderboardEligible: true,
        region: true,
        showRegion: true,
        holdingsVisibility: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const counts = await getFollowCounts(userId);
    const viewerFollowing = viewerId ? await isFollowing(viewerId, userId) : false;
    const activity = user.profilePublic ? await getUserActivity(userId, 10) : [];

    // Fetch performance stats for the profile (1M window, SPY benchmark)
    let performance = null;
    if (user.profilePublic) {
      try {
        performance = await getPerformanceComparison('1M', 'SPY', userId);
      } catch {
        // Performance data is optional
      }
    }

    res.json({
      ...user,
      createdAt: user.createdAt.toISOString(),
      followerCount: counts.followers,
      followingCount: counts.following,
      viewerIsFollowing: viewerFollowing,
      recentActivity: activity,
      performance,
    });
  } catch (error) {
    console.error('Error getting profile:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
}

// PUT /users/:userId/region
export async function updateRegionHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const { region, showRegion } = req.body;

    const VALID_REGIONS = ['NA', 'EU', 'APAC'];
    if (region !== undefined && region !== null && !VALID_REGIONS.includes(region)) {
      res.status(400).json({ error: `Invalid region. Must be one of: ${VALID_REGIONS.join(', ')}` });
      return;
    }

    const data: Record<string, unknown> = {};
    if (region !== undefined) data.region = region;
    if (typeof showRegion === 'boolean') data.showRegion = showRegion;

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, region: true, showRegion: true },
    });

    res.json(user);
  } catch (error) {
    console.error('Error updating region:', error);
    res.status(500).json({ error: 'Failed to update region' });
  }
}

// GET /feed?userId=X&before=ISO
export async function getFeedHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.query.userId as string;
    const before = req.query.before as string | undefined;
    if (!userId) {
      res.status(400).json({ error: 'userId query param is required' });
      return;
    }
    const events = await getFeed(userId, 50, before);
    res.json({ events });
  } catch (error) {
    console.error('Error getting feed:', error);
    res.status(500).json({ error: 'Failed to get feed' });
  }
}
