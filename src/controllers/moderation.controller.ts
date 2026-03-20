import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import prisma from '../utils/prisma';
import { CONTENT_POLICY } from '../utils/content-filter';

// ── User-facing endpoints ──────────────────────────────────────────

/**
 * POST /social/appeal
 * Submit an appeal for a content strike.
 * Body: { strikeId: string, reason: string }
 */
export async function submitAppealHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { strikeId, reason } = req.body;

    if (!strikeId || typeof strikeId !== 'string') {
      res.status(400).json({ error: 'strikeId is required' });
      return;
    }

    if (!reason || typeof reason !== 'string') {
      res.status(400).json({ error: 'reason is required' });
      return;
    }

    if (reason.length > 1000) {
      res.status(400).json({ error: 'reason must be 1000 characters or fewer' });
      return;
    }

    // Verify the strike exists and belongs to this user
    const strike = await prisma.contentStrike.findUnique({
      where: { id: strikeId },
      select: { id: true, userId: true, createdAt: true, appeal: { select: { id: true } } },
    });

    if (!strike) {
      res.status(404).json({ error: 'Strike not found' });
      return;
    }

    if (strike.userId !== userId) {
      res.status(403).json({ error: 'You can only appeal your own strikes' });
      return;
    }

    // Check if already appealed
    if (strike.appeal) {
      res.status(409).json({ error: 'This strike has already been appealed' });
      return;
    }

    // Check 30-day appeal window
    const appealWindowDays = CONTENT_POLICY.dueProcess.appealWindow;
    const windowEnd = new Date(strike.createdAt);
    windowEnd.setDate(windowEnd.getDate() + appealWindowDays);

    if (new Date() > windowEnd) {
      res.status(400).json({
        error: `Appeal window has expired. Appeals must be submitted within ${appealWindowDays} days of the strike.`,
      });
      return;
    }

    const appeal = await prisma.appeal.create({
      data: {
        strikeId,
        userId,
        reason,
      },
    });

    console.log(`[Moderation] User ${userId} submitted appeal ${appeal.id} for strike ${strikeId}`);

    res.status(201).json({
      id: appeal.id,
      strikeId: appeal.strikeId,
      reason: appeal.reason,
      status: appeal.status,
      createdAt: appeal.createdAt,
    });
  } catch (error: unknown) {
    console.error('[Moderation] Error submitting appeal:', error);
    res.status(500).json({ error: 'Failed to submit appeal' });
  }
}

/**
 * GET /social/my-strikes
 * Returns all strikes for the logged-in user, each with its appeal (if any).
 */
export async function getMyStrikesHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const strikes = await prisma.contentStrike.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        reason: true,
        details: true,
        createdAt: true,
        appeal: {
          select: {
            id: true,
            reason: true,
            status: true,
            adminNotes: true,
            resolvedAt: true,
            createdAt: true,
          },
        },
      },
    });

    // Calculate appeal window for each strike
    const appealWindowDays = CONTENT_POLICY.dueProcess.appealWindow;
    const strikesWithMeta = strikes.map((strike) => {
      const windowEnd = new Date(strike.createdAt);
      windowEnd.setDate(windowEnd.getDate() + appealWindowDays);
      const canAppeal = !strike.appeal && new Date() <= windowEnd;

      return {
        ...strike,
        canAppeal,
        appealWindowEnds: windowEnd.toISOString(),
      };
    });

    res.json({
      strikeCount: strikes.length,
      strikes: strikesWithMeta,
      policy: CONTENT_POLICY.dueProcess,
    });
  } catch (error: unknown) {
    console.error('[Moderation] Error fetching strikes:', error);
    res.status(500).json({ error: 'Failed to fetch strikes' });
  }
}

// ── Admin endpoints ────────────────────────────────────────────────

/**
 * GET /admin/moderation/dashboard
 * Full moderation overview with stats.
 */
export async function getModerationDashboardHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const [pendingAppeals, recentStrikes, suspendedUsers, totalStrikes, pendingCount, suspendedCount] = await Promise.all([
      prisma.appeal.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        include: {
          strike: { select: { reason: true, details: true, createdAt: true } },
          user: { select: { id: true, username: true, displayName: true } },
        },
      }),
      prisma.contentStrike.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          user: { select: { id: true, username: true, displayName: true, suspended: true } },
          appeal: { select: { id: true, status: true } },
        },
      }),
      prisma.user.findMany({
        where: { suspended: true },
        select: {
          id: true,
          username: true,
          displayName: true,
          suspendedAt: true,
          _count: { select: { contentStrikes: true } },
        },
      }),
      prisma.contentStrike.count(),
      prisma.appeal.count({ where: { status: 'pending' } }),
      prisma.user.count({ where: { suspended: true } }),
    ]);

    res.json({
      pendingAppeals,
      recentStrikes,
      suspendedUsers,
      stats: {
        totalStrikes,
        pendingAppeals: pendingCount,
        activelySuspended: suspendedCount,
      },
    });
  } catch (error: unknown) {
    console.error('[Moderation] Dashboard error:', error);
    res.status(500).json({ error: 'Failed to load moderation dashboard' });
  }
}

/**
 * GET /admin/moderation/appeals
 * List appeals with optional status filter.
 * Query: ?status=pending (default: pending)
 */
export async function getAppealsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const status = (req.query.status as string) || 'pending';
    const validStatuses = ['pending', 'reviewing', 'upheld', 'overturned'];

    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    const appeals = await prisma.appeal.findMany({
      where: { status },
      orderBy: { createdAt: 'asc' },
      include: {
        strike: { select: { id: true, reason: true, details: true, createdAt: true } },
        user: { select: { id: true, username: true, displayName: true, suspended: true } },
      },
    });

    res.json({ status, count: appeals.length, appeals });
  } catch (error: unknown) {
    console.error('[Moderation] Error listing appeals:', error);
    res.status(500).json({ error: 'Failed to list appeals' });
  }
}

/**
 * POST /admin/moderation/appeals/:appealId/resolve
 * Resolve an appeal.
 * Body: { decision: 'upheld' | 'overturned', adminNotes?: string }
 */
export async function resolveAppealHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { appealId } = req.params;
    const { decision, adminNotes } = req.body;
    const adminUserId = req.user?.userId;

    if (!adminUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!decision || !['upheld', 'overturned'].includes(decision)) {
      res.status(400).json({ error: 'decision must be "upheld" or "overturned"' });
      return;
    }

    const appeal = await prisma.appeal.findUnique({
      where: { id: appealId },
      include: {
        strike: { select: { id: true, userId: true } },
      },
    });

    if (!appeal) {
      res.status(404).json({ error: 'Appeal not found' });
      return;
    }

    if (appeal.status !== 'pending' && appeal.status !== 'reviewing') {
      res.status(400).json({ error: `Appeal already resolved with status: ${appeal.status}` });
      return;
    }

    if (decision === 'overturned') {
      // Overturn: mark appeal resolved, then delete strike (appeal cascades via ON DELETE CASCADE)
      await prisma.$transaction(async (tx) => {
        // Update appeal status first
        await tx.appeal.update({
          where: { id: appealId },
          data: {
            status: 'overturned',
            adminNotes: adminNotes || null,
            resolvedBy: adminUserId,
            resolvedAt: new Date(),
          },
        });

        // Delete the appeal (so FK doesn't block strike deletion)
        await tx.appeal.delete({ where: { id: appealId } });

        // Delete the strike
        await tx.contentStrike.delete({
          where: { id: appeal.strike.id },
        });

        // Count remaining strikes for the user
        const remainingStrikes = await tx.contentStrike.count({
          where: { userId: appeal.strike.userId },
        });

        // Unsuspend if below threshold (3 strikes)
        if (remainingStrikes < 3) {
          await tx.user.update({
            where: { id: appeal.strike.userId },
            data: { suspended: false, suspendedAt: null },
          });

          console.log(`[Moderation] User ${appeal.strike.userId} unsuspended — ${remainingStrikes} strikes remaining after appeal ${appealId} overturned`);
        }
      });

      console.log(`[Moderation] Admin ${adminUserId} overturned appeal ${appealId} — strike ${appeal.strike.id} deleted`);

      res.json({
        success: true,
        appealId,
        decision: 'overturned',
        strikeDeleted: true,
        message: 'Appeal overturned. Strike removed and suspension reconsidered.',
      });
    } else {
      // Upheld: just update the appeal status
      await prisma.appeal.update({
        where: { id: appealId },
        data: {
          status: 'upheld',
          adminNotes: adminNotes || null,
          resolvedBy: adminUserId,
          resolvedAt: new Date(),
        },
      });

      console.log(`[Moderation] Admin ${adminUserId} upheld appeal ${appealId} — strike remains`);

      res.json({
        success: true,
        appealId,
        decision: 'upheld',
        strikeDeleted: false,
        message: 'Appeal upheld. Strike remains in place.',
      });
    }
  } catch (error: unknown) {
    console.error('[Moderation] Error resolving appeal:', error);
    res.status(500).json({ error: 'Failed to resolve appeal' });
  }
}

/**
 * POST /admin/moderation/users/:userId/unsuspend
 * Manually unsuspend a user.
 */
export async function unsuspendUserHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const adminUserId = req.user?.userId;

    if (!adminUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, suspended: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (!user.suspended) {
      res.status(400).json({ error: 'User is not currently suspended' });
      return;
    }

    await prisma.user.update({
      where: { id: userId },
      data: { suspended: false, suspendedAt: null },
    });

    console.log(`[Moderation] Admin ${adminUserId} manually unsuspended user ${userId} (${user.username})`);

    res.json({
      success: true,
      userId,
      username: user.username,
      message: 'User unsuspended successfully.',
    });
  } catch (error: unknown) {
    console.error('[Moderation] Error unsuspending user:', error);
    res.status(500).json({ error: 'Failed to unsuspend user' });
  }
}
