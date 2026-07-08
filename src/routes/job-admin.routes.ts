import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import {
  getJobStats,
  resolveDeadLetterEntry,
  pruneOldJobRuns,
  healStuckJobs,
  detectStuckJobs,
  getJobRunnerAlertSummary,
  getJobRunHistory,
  getDeadLetterEntriesPaginated,
  retryDeadLetterEntry,
} from '../services/job-runner.service';
import { getSnapshotHealth } from '../services/snapshot.service';
import { healSnapshot } from '../services/snapshot-heal.service';
import { config } from '../config';

const router = Router();

function isAdmin(userId?: string): boolean {
  if (!userId) return false;
  return config.waitlistAdminUserIds.includes(userId) ||
    config.creatorAdminUserIds.includes(userId);
}

// GET /admin/jobs/summary - Dashboard job summary per job
router.get('/jobs/summary', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!isAdmin(userId)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const stats = await getJobStats();
    const jobs = stats.map(s => ({
      jobName: s.jobName,
      runCount: s.total,
      successCount: s.success,
      failureCount: s.failed + s.deadLettered,
      failRatePercent: s.failureRate,
      lastRun: s.lastRun,
      alertStatus: s.alertSeverity,
      alertThresholds: s.alertThresholds,
      avgDurationMs: s.avgDurationMs,
      lastError: s.lastError,
    }));

    res.json({
      generatedAt: new Date().toISOString(),
      totalJobs: jobs.length,
      jobs,
    });
  } catch (error: unknown) {
    console.error('[JobAdmin] summary error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch job summary' });
  }
});

// GET /admin/jobs/:jobName/history - Recent runs for a specific job (max 50)
router.get('/jobs/:jobName/history', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!isAdmin(userId)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const jobName = req.params.jobName;
    const runs = await getJobRunHistory(jobName, 50);
    res.json({ jobName, count: runs.length, runs });
  } catch (error: unknown) {
    console.error('[JobAdmin] history error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch job history' });
  }
});

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
    const alert = getJobRunnerAlertSummary(stats);

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
        alert,
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
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.max(1, Math.min(parseInt(req.query.pageSize as string) || 25, 200));
    const result = await getDeadLetterEntriesPaginated({
      resolved: showResolved,
      page,
      pageSize,
    });

    res.json(result);
  } catch (error: unknown) {
    console.error('[JobAdmin] dead-letter error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch dead letter entries' });
  }
});

// POST /admin/jobs/dead-letter/:id/retry - Retry a dead-lettered job
router.post('/jobs/dead-letter/:id/retry', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!isAdmin(userId)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const result = await retryDeadLetterEntry(req.params.id, userId);
    if (!result.ok) {
      if (result.code === 'NOT_FOUND') {
        res.status(404).json({ error: 'Dead letter entry not found' });
        return;
      }
      if (result.code === 'ALREADY_RESOLVED') {
        res.status(409).json({ error: 'Dead letter entry is already resolved', entry: result.entry });
        return;
      }
      if (result.code === 'HANDLER_NOT_REGISTERED') {
        res.status(409).json({ error: `Retry handler not registered for job ${result.entry.jobName}`, entry: result.entry });
        return;
      }
      if (result.code === 'RETRY_FAILED') {
        res.status(500).json({ error: 'Dead letter retry failed', category: result.category, details: result.error, entry: result.entry });
        return;
      }
      res.status(500).json({ error: 'Dead letter retry unavailable' });
      return;
    }

    res.json({ retried: true, entry: result.entry });
  } catch (error: unknown) {
    console.error('[JobAdmin] retry error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to retry dead letter entry' });
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

// POST /admin/jobs/heal - Snapshot heal (supports dry-run) or stuck job heal via target
router.post('/jobs/heal', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!isAdmin(userId)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const target = typeof req.body?.target === 'string' ? req.body.target : 'snapshots';
    const dryRun = req.body?.dryRun === true;

    if (target === 'orphaned_jobs' || target === 'stuck_jobs') {
      const thresholdMinutes = Math.max(1, parseInt(req.body?.thresholdMinutes) || 30);
      if (dryRun) {
        const stuck = await detectStuckJobs(thresholdMinutes);
        res.json({
          target: 'stuck_jobs',
          dryRun: true,
          thresholdMinutes,
          wouldHeal: stuck.length,
          details: stuck.map(job => ({
            id: job.id,
            jobName: job.jobName,
            action: 'would_mark_failed',
          })),
          message: `Dry run: ${stuck.length} stuck job(s) would be healed`,
        });
        return;
      }

      const healed = await healStuckJobs(thresholdMinutes);
      res.json({
        target: 'stuck_jobs',
        dryRun: false,
        thresholdMinutes,
        healed: healed.length,
        details: healed,
        message: `Healed ${healed.length} stuck job(s)`,
      });
      return;
    }

    const SYSTEM_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';
    const result = await healSnapshot(SYSTEM_USER_ID, { dryRun });
    res.json({
      target: 'snapshots',
      dryRun,
      result,
      message: dryRun ? 'Dry-run completed. No snapshot data was written.' : 'Snapshot heal completed.',
    });
  } catch (error: unknown) {
    console.error('[JobAdmin] heal error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to execute heal operation' });
  }
});

// GET /admin/jobs/stuck - Detect stuck jobs (running > threshold)
router.get('/jobs/stuck', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!isAdmin(userId)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const thresholdMinutes = Math.max(1, parseInt(req.query.thresholdMinutes as string) || 30);
    const stuck = await detectStuckJobs(thresholdMinutes);
    res.json({ stuck, count: stuck.length, thresholdMinutes });
  } catch (error: unknown) {
    console.error('[JobAdmin] stuck error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to detect stuck jobs' });
  }
});

// GET /admin/jobs/snapshot-health - Snapshot integrity checks per user
router.get('/jobs/snapshot-health', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!isAdmin(userId)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const reports = await getSnapshotHealth();

    const summary = {
      totalUsers: reports.length,
      healthy: reports.filter(r => r.status === 'healthy').length,
      stale: reports.filter(r => r.status === 'stale').length,
      gaps: reports.filter(r => r.status === 'gaps').length,
      critical: reports.filter(r => r.status === 'critical').length,
    };

    res.json({ summary, reports });
  } catch (error: unknown) {
    console.error('[JobAdmin] snapshot-health error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to check snapshot health' });
  }
});

export default router;
