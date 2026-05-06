import { Router } from 'express';
import {
  startResearchHandler,
  getStatusHandler,
  getResultHandler,
  followUpHandler,
  cancelHandler,
  listJobsHandler,
  archiveHandler,
  unarchiveHandler,
  deleteHandler,
  clearFinishedHandler,
} from '../controllers/deep-research.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { heavyReadLimiter, aiLimiter, deepResearchLimiter, mutationLimiter } from '../middleware/rateLimiter';
import { requirePlan } from '../middleware/plan.middleware';

const router = Router();

// POST /start — Submit a new deep research job ($2-5 per run)
router.post('/start', deepResearchLimiter, requireAuth, requirePlan('premium'), startResearchHandler);

// GET / — List user's research jobs
router.get('/', heavyReadLimiter, requireAuth, requirePlan('premium'), listJobsHandler);

// DELETE /clear-finished — Bulk-delete all completed/failed/cancelled jobs.
// Must be declared BEFORE the `/:id` routes so Express doesn't treat
// "clear-finished" as a job ID and fail the UUID validator.
router.delete('/clear-finished', mutationLimiter, requireAuth, requirePlan('premium'), clearFinishedHandler);

// GET /:id/status — Check job status
router.get('/:id/status', heavyReadLimiter, requireAuth, requirePlan('premium'), getStatusHandler);

// GET /:id/result — Get completed job result
router.get('/:id/result', heavyReadLimiter, requireAuth, requirePlan('premium'), getResultHandler);

// POST /:id/followup — Submit a follow-up question ($2-5 per run)
router.post('/:id/followup', deepResearchLimiter, requireAuth, requirePlan('premium'), followUpHandler);

// POST /:id/cancel — Cancel an active job
router.post('/:id/cancel', aiLimiter, requireAuth, requirePlan('premium'), cancelHandler);

// POST /:id/archive — Soft-archive a finished job (hides from default list)
router.post('/:id/archive', mutationLimiter, requireAuth, requirePlan('premium'), archiveHandler);

// POST /:id/unarchive — Restore a previously archived job
router.post('/:id/unarchive', mutationLimiter, requireAuth, requirePlan('premium'), unarchiveHandler);

// DELETE /:id — Hard-delete a finished job (must be cancelled first if active)
router.delete('/:id', mutationLimiter, requireAuth, requirePlan('premium'), deleteHandler);

export default router;
