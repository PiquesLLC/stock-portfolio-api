import { Request, Response } from 'express';
import prisma from '../utils/prisma';
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
import { AuthRequest } from '../types/auth';



// POST /users/:userId/follow
// Uses authenticated user as follower (no body required)
export async function followHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const followerId = req.user?.userId;

    if (!followerId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (followerId === userId) {
      res.status(400).json({ error: 'Cannot follow yourself' });
      return;
    }

    await followUser(followerId, userId);
    res.json({ ok: true });
  } catch (error: unknown) {
    console.error('Error following user:');
    res.status(400).json({ error: 'Failed to follow user' });
  }
}

// DELETE /users/:userId/follow
// Uses authenticated user as follower (no body required)
export async function unfollowHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const followerId = req.user?.userId;

    if (!followerId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    await unfollowUser(followerId, userId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error unfollowing:');
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
    console.error('Error checking follow:');
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
    console.error('Error getting followers:');
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
    console.error('Error getting following:');
    res.status(500).json({ error: 'Failed to get following' });
  }
}

// GET /users/:userId/profile
// IDOR Protection: Private profiles can only be viewed by owner
export async function getProfileHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const viewerId = req.user?.userId; // Get from auth context

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
        bio: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const isOwner = viewerId === userId;

    // IDOR Protection: If profile is private and viewer is not owner, deny access
    if (!user.profilePublic && !isOwner) {
      res.status(403).json({ error: 'This profile is private' });
      return;
    }

    const counts = await getFollowCounts(userId);
    const viewerFollowing = viewerId ? await isFollowing(viewerId, userId) : false;
    const activity = user.profilePublic ? await getUserActivity(userId, 10) : [];

    // Fetch performance stats for the profile (1M window, SPY benchmark)
    let performance = null;
    if (user.profilePublic || isOwner) {
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
    console.error('Error getting profile:');
    res.status(500).json({ error: 'Failed to get profile' });
  }
}

// PUT /users/:userId/region
// IDOR Protection: Only owner can update their region
export async function updateRegionHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const authUserId = req.user?.userId;

    // Verify ownership
    if (!authUserId || authUserId !== userId) {
      res.status(403).json({ error: 'Access denied. You can only update your own settings.' });
      return;
    }

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
    console.error('Error updating region:');
    res.status(500).json({ error: 'Failed to update region' });
  }
}

// GET /users/:userId/settings
// IDOR Protection: Only the owner can view their own settings
export async function getUserSettingsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const viewerId = req.user?.userId;

    // Only allow users to view their own settings
    if (!viewerId || viewerId !== userId) {
      res.status(403).json({ error: 'Access denied. You can only view your own settings.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        profilePublic: true,
        region: true,
        showRegion: true,
        holdingsVisibility: true,
        createdAt: true,
        settings: {
          select: {
            dripEnabled: true,
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      profilePublic: user.profilePublic,
      region: user.region,
      showRegion: user.showRegion,
      holdingsVisibility: user.holdingsVisibility,
      dripEnabled: user.settings?.dripEnabled ?? false,
      createdAt: user.createdAt.toISOString(),
    });
  } catch (error) {
    console.error('Error getting user settings:');
    res.status(500).json({ error: 'Failed to get user settings' });
  }
}

// PUT /users/:userId/settings
// IDOR Protection: Only owner can update their settings
export async function updateUserSettingsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const authUserId = req.user?.userId;

    // Verify ownership
    if (!authUserId || authUserId !== userId) {
      res.status(403).json({ error: 'Access denied. You can only update your own settings.' });
      return;
    }

    const {
      displayName,
      profilePublic,
      region,
      showRegion,
      holdingsVisibility,
      dripEnabled,
      bio,
    } = req.body;

    // Validate inputs
    const VALID_REGIONS = ['NA', 'EU', 'APAC', null];
    if (region !== undefined && !VALID_REGIONS.includes(region)) {
      res.status(400).json({ error: `Invalid region. Must be one of: NA, EU, APAC, or null` });
      return;
    }

    const VALID_VISIBILITY = ['all', 'top5', 'sectors', 'hidden'];
    if (holdingsVisibility !== undefined && !VALID_VISIBILITY.includes(holdingsVisibility)) {
      res.status(400).json({ error: `Invalid holdingsVisibility. Must be one of: ${VALID_VISIBILITY.join(', ')}` });
      return;
    }

    // Build update data for User model
    const userData: Record<string, unknown> = {};
    if (displayName !== undefined) userData.displayName = displayName;
    if (profilePublic !== undefined) userData.profilePublic = profilePublic;
    if (region !== undefined) userData.region = region;
    if (showRegion !== undefined) userData.showRegion = showRegion;
    if (holdingsVisibility !== undefined) userData.holdingsVisibility = holdingsVisibility;
    if (bio !== undefined) userData.bio = typeof bio === 'string' ? bio.slice(0, 80) : null;

    // Update User
    const user = await prisma.user.update({
      where: { id: userId },
      data: userData,
      select: {
        id: true,
        username: true,
        displayName: true,
        profilePublic: true,
        region: true,
        showRegion: true,
        holdingsVisibility: true,
        bio: true,
      },
    });

    // Update UserSettings if dripEnabled is provided
    let dripEnabledResult = false;
    if (dripEnabled !== undefined) {
      const userSettings = await prisma.userSettings.upsert({
        where: { userId },
        update: { dripEnabled },
        create: { userId, dripEnabled },
        select: { dripEnabled: true },
      });
      dripEnabledResult = userSettings.dripEnabled;
    } else {
      const existing = await prisma.userSettings.findUnique({
        where: { userId },
        select: { dripEnabled: true },
      });
      dripEnabledResult = existing?.dripEnabled ?? false;
    }

    res.json({
      ...user,
      dripEnabled: dripEnabledResult,
    });
  } catch (error) {
    console.error('Error updating user settings:');
    res.status(500).json({ error: 'Failed to update user settings' });
  }
}

// GET /feed?before=ISO
export async function getFeedHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const userId = req.user.userId;
    const before = req.query.before as string | undefined;
    const events = await getFeed(userId, 50, before);
    res.json({ events });
  } catch (error) {
    console.error('Error getting feed:');
    res.status(500).json({ error: 'Failed to get feed' });
  }
}

