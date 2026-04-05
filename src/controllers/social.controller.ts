import { Response } from 'express';
import prisma from '../utils/prisma';
import {
  followUser,
  unfollowUser,
  isFollowing,
  getFollowers,
  getFollowing,
  getFollowCounts,
} from '../services/follow.service';
import { getFeed, getUserActivity, deleteActivityEvent, ActivityEventResponse } from '../services/activity.service';
import { getPerformanceComparison } from '../services/benchmark.service';
import { AuthRequest } from '../types/auth';
import { getCreatorProfile } from '../services/creator.service';
import { reportUser } from '../services/report.service';
import { reportUserBodySchema } from '../validators/report.validators';
import { getProfileStats } from '../services/profile-stats.service';
import { filterContent } from '../utils/content-filter';

// IANA timezone validation — cache the allowed-list once at module load.
// Falls back to try/catch with Intl.DateTimeFormat if supportedValuesOf isn't available.
const SUPPORTED_TIMEZONES: Set<string> | null = (() => {
  try {
    const values = (Intl as any).supportedValuesOf?.('timeZone');
    // Require non-empty array — an empty set would reject every timezone.
    return Array.isArray(values) && values.length > 0 ? new Set<string>(values) : null;
  } catch {
    return null;
  }
})();

export function isValidTimezone(tz: string): boolean {
  // Fast path: canonical IANA names from the tzdata bundle.
  if (SUPPORTED_TIMEZONES?.has(tz)) return true;
  // Fallback: some canonical names (e.g., "UTC") aren't in supportedValuesOf
  // but are still accepted by DateTimeFormat. Throws RangeError if invalid.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}



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
    console.error('Error following user:', error instanceof Error ? error.message : String(error));
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
  } catch (error: unknown) {
    console.error('Error unfollowing:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to unfollow' });
  }
}

// GET /users/:userId/is-following — uses authenticated user as followerId
export async function isFollowingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const followerId = req.user?.userId;
    if (!followerId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const following = await isFollowing(followerId, userId);
    res.json({ following });
  } catch (error: unknown) {
    console.error('Error checking follow:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to check follow status' });
  }
}

// GET /users/:userId/followers
export async function getFollowersHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const viewerId = req.user?.userId;
    const isOwner = viewerId === userId;

    // Privacy check: respect profilePublic for non-owners
    if (!isOwner) {
      const targetUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { profilePublic: true },
      });
      if (!targetUser || !targetUser.profilePublic) {
        res.json([]);
        return;
      }
    }

    const followers = await getFollowers(userId);
    res.json(followers);
  } catch (error: unknown) {
    console.error('Error getting followers:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to get followers' });
  }
}

// GET /users/:userId/following
export async function getFollowingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const viewerId = req.user?.userId;
    const isOwner = viewerId === userId;

    // Privacy check: respect profilePublic for non-owners
    if (!isOwner) {
      const targetUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { profilePublic: true },
      });
      if (!targetUser || !targetUser.profilePublic) {
        res.json([]);
        return;
      }
    }

    const following = await getFollowing(userId);
    res.json(following);
  } catch (error: unknown) {
    console.error('Error getting following:', error instanceof Error ? error.message : String(error));
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
        plan: true,
        planStartedAt: true,
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
    const holdingsHidden = !isOwner && user.holdingsVisibility !== 'all';
    let activity: ActivityEventResponse[] = user.profilePublic ? await getUserActivity(userId, 10) : [];

    // Holdings-private gate: hide all activity if holdings are not public
    if (!isOwner && holdingsHidden && activity.length > 0) {
      activity = [];
    }

    // Trade delay + subscription gate: filter activity for non-owner viewers
    if (!isOwner && activity.length > 0) {
      const creator = await prisma.creator.findUnique({
        where: { userId },
        select: { status: true, pricingCents: true, visibility: { select: { tradeDelayHours: true } } },
      });
      if (creator?.status === 'active') {
        // Paid creator — hide trades from non-subscribers entirely
        if (creator.pricingCents > 0 && viewerId) {
          const now = new Date();
          const sub = await prisma.creatorSubscription.findFirst({
            where: {
              subscriberUserId: viewerId,
              creatorUserId: userId,
              status: { in: ['active', 'canceled', 'trialing', 'past_due'] },
              OR: [
                { trialEnd: { gt: now } },
                { currentPeriodEnd: null, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
                { currentPeriodEnd: { gt: now } },
              ],
            },
            select: { id: true },
          });
          if (!sub) activity = []; // Not subscribed — hide all trades
        } else if (creator.pricingCents > 0 && !viewerId) {
          activity = []; // Unauthenticated viewer — hide paid creator trades
        }
        // Apply trade delay for trades that pass the subscription check
        if (activity.length > 0 && creator.visibility?.tradeDelayHours) {
          const cutoff = Date.now() - creator.visibility.tradeDelayHours * 60 * 60 * 1000;
          activity = activity.filter(e => new Date(e.createdAt).getTime() <= cutoff);
        }
      }
    }

    // Fetch performance stats for the profile (1M window, SPY benchmark)
    let performance = null;
    if ((user.profilePublic || isOwner) && !holdingsHidden) {
      try {
        performance = await getPerformanceComparison('1M', 'SPY', userId);
      } catch {
        // Performance data is optional
      }
    }

    const creatorProfile = await getCreatorProfile(userId, viewerId).catch(() => null);

    // Trade stats + badges: only show if holdings are visible (same gate as performance)
    let tradeStats = null;
    let badges: { badge: string; window: string; earnedAt: Date }[] = [];
    if (!holdingsHidden || isOwner) {
      try {
        const profileData = await getProfileStats(userId);
        if (profileData.stats && (profileData.stats.totalTrades ?? 0) > 0) {
          tradeStats = {
            winRate: profileData.stats.winRate,
            totalTrades: profileData.stats.totalTrades,
            avgHoldDays: profileData.stats.avgHoldDays,
            profitFactor: profileData.stats.profitFactor,
          };
        }
        badges = profileData.badges;
      } catch {}
    }

    res.json({
      ...user,
      planStartedAt: isOwner ? user.planStartedAt : undefined,
      holdingsVisibility: isOwner ? user.holdingsVisibility : (user.holdingsVisibility !== 'all'),
      createdAt: user.createdAt.toISOString(),
      followerCount: counts.followers,
      followingCount: counts.following,
      viewerIsFollowing: viewerFollowing,
      recentActivity: activity,
      performance,
      tradeStats,
      badges,
      kycVerified: false,
      creator: creatorProfile,
      viewerAccessLevel: creatorProfile?.accessLevel ?? 'public',
    });
  } catch (error: unknown) {
    console.error('Error getting profile:', error instanceof Error ? error.message : String(error));
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
  } catch (error: unknown) {
    console.error('Error updating region:', error instanceof Error ? error.message : String(error));
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
        timezone: true,
        holdingsVisibility: true,
        createdAt: true,
        settings: {
          select: {
            dripEnabled: true,
            ytdBaselineValue: true,
            cashInterestRate: true,
            marginDebt: true,
            annualSalary: true,
            priceSpikePct: true,
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
      timezone: user.timezone,
      holdingsVisibility: user.holdingsVisibility,
      dripEnabled: user.settings?.dripEnabled ?? false,
      ytdBaselineValue: user.settings?.ytdBaselineValue ?? null,
      cashInterestRate: user.settings?.cashInterestRate ?? null,
      marginDebt: user.settings?.marginDebt ?? null,
      annualSalary: user.settings?.annualSalary ?? null,
      priceSpikePct: user.settings?.priceSpikePct ?? 3.0,
      createdAt: user.createdAt.toISOString(),
    });
  } catch (error: unknown) {
    console.error('Error getting user settings:', error instanceof Error ? error.message : String(error));
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
      timezone,
      holdingsVisibility,
      dripEnabled,
      bio,
      ytdBaselineValue,
      cashInterestRate,
      marginDebt,
      annualSalary,
      priceSpikePct,
    } = req.body;

    // Validate inputs
    const VALID_REGIONS = ['NA', 'EU', 'APAC', null];
    if (region !== undefined && !VALID_REGIONS.includes(region)) {
      res.status(400).json({ error: `Invalid region. Must be one of: NA, EU, APAC, or null` });
      return;
    }

    if (timezone !== undefined && timezone !== null) {
      if (typeof timezone !== 'string' || !isValidTimezone(timezone)) {
        res.status(400).json({ error: 'timezone must be a valid IANA timezone name or null' });
        return;
      }
    }

    const VALID_VISIBILITY = ['all', 'top5', 'sectors', 'hidden'];
    if (holdingsVisibility !== undefined && !VALID_VISIBILITY.includes(holdingsVisibility)) {
      res.status(400).json({ error: `Invalid holdingsVisibility. Must be one of: ${VALID_VISIBILITY.join(', ')}` });
      return;
    }

    if (ytdBaselineValue !== undefined && ytdBaselineValue !== null) {
      if (typeof ytdBaselineValue !== 'number' || !Number.isFinite(ytdBaselineValue) || ytdBaselineValue <= 0) {
        res.status(400).json({ error: 'ytdBaselineValue must be a positive number or null' });
        return;
      }
    }

    if (cashInterestRate !== undefined && cashInterestRate !== null) {
      if (typeof cashInterestRate !== 'number' || !Number.isFinite(cashInterestRate) || cashInterestRate < 0 || cashInterestRate > 20) {
        res.status(400).json({ error: 'cashInterestRate must be a number between 0 and 20, or null' });
        return;
      }
    }

    if (marginDebt !== undefined && marginDebt !== null) {
      if (typeof marginDebt !== 'number' || !Number.isFinite(marginDebt) || marginDebt < 0) {
        res.status(400).json({ error: 'marginDebt must be a non-negative number or null' });
        return;
      }
    }

    if (annualSalary !== undefined && annualSalary !== null) {
      if (typeof annualSalary !== 'number' || !Number.isFinite(annualSalary) || annualSalary < 0) {
        res.status(400).json({ error: 'annualSalary must be a non-negative number or null' });
        return;
      }
    }

    if (priceSpikePct !== undefined) {
      if (typeof priceSpikePct !== 'number' || !Number.isFinite(priceSpikePct) || priceSpikePct < 1 || priceSpikePct > 25) {
        res.status(400).json({ error: 'priceSpikePct must be a number between 1 and 25' });
        return;
      }
    }

    // Build update data for User model
    const userData: Record<string, unknown> = {};
    if (displayName !== undefined) {
      if (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > 50) {
        res.status(400).json({ error: 'displayName must be a string, max 50 chars' });
        return;
      }
      const dnFilter = filterContent(displayName);
      if (!dnFilter.allowed) {
        res.status(400).json({ error: 'Display name violates our content policy.', code: 'content_policy_violation', reason: dnFilter.reason });
        return;
      }
      userData.displayName = displayName.trim();
    }
    if (profilePublic !== undefined) {
      if (typeof profilePublic !== 'boolean') {
        res.status(400).json({ error: 'profilePublic must be a boolean' });
        return;
      }
      userData.profilePublic = profilePublic;
    }
    if (region !== undefined) userData.region = region;
    if (showRegion !== undefined) userData.showRegion = showRegion;
    if (timezone !== undefined) userData.timezone = timezone;
    if (holdingsVisibility !== undefined) userData.holdingsVisibility = holdingsVisibility;
    if (bio !== undefined) {
      if (typeof bio === 'string' && bio.trim().length > 0) {
        const bioFilter = filterContent(bio);
        if (!bioFilter.allowed) {
          res.status(400).json({ error: 'Bio violates our content policy.', code: 'content_policy_violation', reason: bioFilter.reason });
          return;
        }
      }
      userData.bio = typeof bio === 'string' ? bio.slice(0, 80) : null;
    }

    // Audit log: capture privacy-sensitive fields BEFORE update
    if (userData.profilePublic !== undefined || userData.holdingsVisibility !== undefined) {
      const before = await prisma.user.findUnique({
        where: { id: userId },
        select: { profilePublic: true, holdingsVisibility: true },
      });
      if (before) {
        const changes: string[] = [];
        if (userData.profilePublic !== undefined && before.profilePublic !== userData.profilePublic) {
          changes.push(`profilePublic: ${before.profilePublic} → ${userData.profilePublic}`);
        }
        if (userData.holdingsVisibility !== undefined && before.holdingsVisibility !== userData.holdingsVisibility) {
          changes.push(`holdingsVisibility: ${before.holdingsVisibility} → ${userData.holdingsVisibility}`);
        }
        if (changes.length > 0) {
          console.log(`[Privacy Audit] user=${userId} changed: ${changes.join(', ')}`);
        }
      }
    }

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
        timezone: true,
        holdingsVisibility: true,
        bio: true,
      },
    });

    // Update UserSettings if dripEnabled, ytdBaselineValue, cashInterestRate, marginDebt, or annualSalary is provided
    let dripEnabledResult = false;
    let ytdBaselineResult: number | null = null;
    let cashInterestRateResult: number | null = null;
    let marginDebtResult: number | null = null;
    let annualSalaryResult: number | null = null;
    let priceSpikePctResult = 3.0;
    const hasSettingsUpdate = dripEnabled !== undefined || ytdBaselineValue !== undefined || cashInterestRate !== undefined || marginDebt !== undefined || annualSalary !== undefined || priceSpikePct !== undefined;
    if (hasSettingsUpdate) {
      const settingsUpdate: { dripEnabled?: boolean; ytdBaselineValue?: number | null; cashInterestRate?: number; marginDebt?: number; annualSalary?: number | null; priceSpikePct?: number } = {};
      const settingsCreate: { userId: string; dripEnabled?: boolean; ytdBaselineValue?: number | null; cashInterestRate?: number; marginDebt?: number; annualSalary?: number | null; priceSpikePct?: number } = { userId };
      if (dripEnabled !== undefined) {
        settingsUpdate.dripEnabled = dripEnabled;
        settingsCreate.dripEnabled = dripEnabled;
      }
      if (ytdBaselineValue !== undefined) {
        settingsUpdate.ytdBaselineValue = ytdBaselineValue;
        settingsCreate.ytdBaselineValue = ytdBaselineValue;
      }
      if (cashInterestRate !== undefined) {
        const rateVal = cashInterestRate == null ? 0 : Math.round(cashInterestRate * 100) / 100;
        settingsUpdate.cashInterestRate = rateVal;
        settingsCreate.cashInterestRate = rateVal;
      }
      if (marginDebt !== undefined) {
        const debtVal = marginDebt == null ? 0 : Math.round(marginDebt * 100) / 100;
        settingsUpdate.marginDebt = debtVal;
        settingsCreate.marginDebt = debtVal;
      }
      if (annualSalary !== undefined) {
        settingsUpdate.annualSalary = annualSalary;
        settingsCreate.annualSalary = annualSalary;
      }
      if (priceSpikePct !== undefined) {
        settingsUpdate.priceSpikePct = Math.round(priceSpikePct * 10) / 10;
        settingsCreate.priceSpikePct = Math.round(priceSpikePct * 10) / 10;
      }
      const userSettings = await prisma.userSettings.upsert({
        where: { userId },
        update: settingsUpdate,
        create: settingsCreate,
        select: { dripEnabled: true, ytdBaselineValue: true, cashInterestRate: true, marginDebt: true, annualSalary: true, priceSpikePct: true },
      });
      dripEnabledResult = userSettings.dripEnabled;
      ytdBaselineResult = userSettings.ytdBaselineValue;
      cashInterestRateResult = userSettings.cashInterestRate ?? null;
      marginDebtResult = userSettings.marginDebt ?? null;
      annualSalaryResult = userSettings.annualSalary ?? null;
      priceSpikePctResult = userSettings.priceSpikePct ?? 3.0;
    } else {
      const existing = await prisma.userSettings.findUnique({
        where: { userId },
        select: { dripEnabled: true, ytdBaselineValue: true, cashInterestRate: true, marginDebt: true, annualSalary: true, priceSpikePct: true },
      });
      dripEnabledResult = existing?.dripEnabled ?? false;
      ytdBaselineResult = existing?.ytdBaselineValue ?? null;
      cashInterestRateResult = existing?.cashInterestRate ?? null;
      marginDebtResult = existing?.marginDebt ?? null;
      annualSalaryResult = existing?.annualSalary ?? null;
      priceSpikePctResult = existing?.priceSpikePct ?? 3.0;
    }

    res.json({
      ...user,
      dripEnabled: dripEnabledResult,
      ytdBaselineValue: ytdBaselineResult,
      cashInterestRate: cashInterestRateResult,
      marginDebt: marginDebtResult,
      annualSalary: annualSalaryResult,
      priceSpikePct: priceSpikePctResult,
    });
  } catch (error: unknown) {
    console.error('Error updating user settings:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to update user settings' });
  }
}

// POST /users/:userId/report
export async function reportUserHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const reporterUserId = req.user?.userId;
    if (!reporterUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { userId: reportedUserId } = req.params;
    const parsed = reportUserBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { reason, description, context } = parsed.data;
    const report = await reportUser(reporterUserId, reportedUserId, reason, description, context);
    res.status(201).json(report);
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message || 'Failed to submit report' });
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
  } catch (error: unknown) {
    console.error('Error getting feed:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to get feed' });
  }
}

// DELETE /activity/:id
export async function deleteActivityEventHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const deleted = await deleteActivityEvent(userId, req.params.id);
    if (!deleted) { res.status(404).json({ error: 'Event not found' }); return; }
    res.status(204).send();
  } catch (error: unknown) {
    console.error('Error deleting activity event:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to delete activity event' });
  }
}
