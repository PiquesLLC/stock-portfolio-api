import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { getJobStats, getDeadLetterEntries, resolveDeadLetterEntry, pruneOldJobRuns } from '../services/job-runner.service';
import { config } from '../config';

const router = Router();

function isAdmin(userId: string): boolean {
  return config.waitlistAdminUserIds.includes(userId) ||
    config.creatorAdminUserIds.includes(userId);
}

// GET /admin/jobs/stats - Job run statistics (last 24h)
router.get('/jobs/stats', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!isAdmin(userId)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const jobName = req.query.jobName as string | undefined;
    const stats = await getJobStats(jobName);

    const totalRuns = stats.reduce((a, s) => a + s.total, 0);
    const totalFailed = stats.reduce((a, s) => a + s.failed, 0);
    const totalDeadLettered = stats.reduce((a, s) => a + s.deadLettered, 0);

    res.json({
      summary: {
        totalJobs: stats.length,
        totalRuns,
        totalFailed,
        totalDeadLettered,
        failureRate: totalRuns > 0 ? ((totalFailed + totalDeadLettered) / totalRuns * 100).toFixed(1) + '%' : '0%',
      },
      jobs: stats,
    });
  } catch (error: unknown) {
    console.error('[JobAdmin] stats error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch job stats' });
  }
});

// GET /admin/jobs/dead-letter - Dead letter queue
router.get('/jobs/dead-letter', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!isAdmin(userId)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const showResolved = req.query.resolved === 'true';
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 50, 200));
    const entries = await getDeadLetterEntries(showResolved, limit);

    res.json({ entries, count: entries.length });
  } catch (error: unknown) {
    console.error('[JobAdmin] dead-letter error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch dead letter entries' });
  }
});

// POST /admin/jobs/dead-letter/:id/resolve - Resolve a dead letter entry
router.post('/jobs/dead-letter/:id/resolve', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!isAdmin(userId)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const entry = await resolveDeadLetterEntry(req.params.id, userId);
    res.json({ entry });
  } catch (error: unknown) {
    const isPrismaNotFound = error instanceof Error && 'code' in error && (error as { code?: string }).code === 'P2025';
    if (isPrismaNotFound) {
      res.status(404).json({ error: 'Dead letter entry not found' });
    } else {
      console.error('[JobAdmin] resolve error:', error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: 'Failed to resolve dead letter entry' });
    }
  }
});

// POST /admin/jobs/prune - Clean up old job runs (>7 days)
router.post('/jobs/prune', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!isAdmin(userId)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const deleted = await pruneOldJobRuns();
    res.json({ deleted, message: `Pruned ${deleted} job runs older than 7 days` });
  } catch (error: unknown) {
    console.error('[JobAdmin] prune error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to prune job runs' });
  }
});

export default router;
