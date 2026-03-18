import { Router, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { config } from '../config';
import { AuthRequest } from '../types/auth';
import prisma from '../utils/prisma';

const router = Router();

// Only Jon's account can access admin endpoints
const ADMIN_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

function requireAdmin(req: AuthRequest, res: Response, next: Function): void {
  if (!req.user || req.user.userId !== ADMIN_USER_ID) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

// POST /admin/set-plan { userId, plan }
router.post('/set-plan', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { userId, plan } = req.body;
  const validPlans = ['free', 'pro', 'premium', 'elite'];

  if (!userId || !plan || !validPlans.includes(plan)) {
    res.status(400).json({ error: 'Requires userId and plan (free|pro|premium|elite)' });
    return;
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { plan },
    select: { id: true, username: true, plan: true },
  });

  res.json({ success: true, user });
});

// GET /admin/user/:userId — view any user's info
router.get('/user/:userId', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.userId },
    select: { id: true, username: true, email: true, plan: true, createdAt: true },
  });

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json(user);
});

// POST /admin/cleanup-db — prune old snapshots, expired tokens, old job runs
// TEMPORARY endpoint for production disk cleanup. Remove after use.
router.post('/cleanup-db', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  if (req.body?.confirm !== 'cleanup-db') {
    res.status(400).json({ error: 'Missing confirmation token' });
    return;
  }

  const log: string[] = [];
  try {
    // Step 1: Small tables
    const rt = await prisma.$executeRawUnsafe(`DELETE FROM "RefreshToken" WHERE "expiresAt" < CURRENT_TIMESTAMP OR "revokedAt" IS NOT NULL`);
    log.push(`RefreshToken: deleted ${rt}`);

    const jk = await prisma.$executeRawUnsafe(`DELETE FROM "JobIdempotencyKey" WHERE "expiresAt" < CURRENT_TIMESTAMP`);
    log.push(`JobIdempotencyKey: deleted ${jk}`);

    const jr = await prisma.$executeRawUnsafe(`DELETE FROM "BackgroundJobRun" WHERE "startedAt" < datetime('now', '-7 days')`);
    log.push(`BackgroundJobRun: deleted ${jr}`);

    const ae = await prisma.$executeRawUnsafe(`DELETE FROM "AnalyticsEvent" WHERE "createdAt" < datetime('now', '-90 days')`);
    log.push(`AnalyticsEvent: deleted ${ae}`);

    const al = await prisma.$executeRawUnsafe(`DELETE FROM "ApiUsageLog" WHERE "createdAt" < datetime('now', '-90 days')`);
    log.push(`ApiUsageLog: deleted ${al}`);

    // Step 2: HoldingSnapshot > 30 days in chunks
    let totalHs = 0;
    let chunk = 0;
    while (true) {
      const deleted = await prisma.$executeRawUnsafe(
        `DELETE FROM "HoldingSnapshot" WHERE rowid IN (SELECT rowid FROM "HoldingSnapshot" WHERE "timestamp" < datetime('now', '-30 days') LIMIT 5000)`
      );
      totalHs += deleted;
      chunk++;
      log.push(`HoldingSnapshot chunk ${chunk}: deleted ${deleted}`);
      if (deleted < 5000) break;
    }
    log.push(`HoldingSnapshot total: deleted ${totalHs}`);

    // Step 3: WAL checkpoint
    await prisma.$executeRawUnsafe(`PRAGMA wal_checkpoint(TRUNCATE)`);
    log.push('WAL checkpoint: done');

    // Step 4: VACUUM (may fail if still tight)
    try {
      await prisma.$executeRawUnsafe(`VACUUM`);
      log.push('VACUUM: done');
    } catch (e: unknown) {
      log.push(`VACUUM: skipped (${e instanceof Error ? e.message : String(e)})`);
    }

    res.json({ success: true, log });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e), log });
  }
});

export default router;
