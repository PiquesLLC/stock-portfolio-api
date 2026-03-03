import { Router } from 'express';
import {
  startResearchHandler,
  getStatusHandler,
  getResultHandler,
  followUpHandler,
  cancelHandler,
  listJobsHandler,
} from '../controllers/deep-research.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter, heavyReadLimiter } from '../middleware/rateLimiter';
import { requirePlan } from '../middleware/plan.middleware';

const router = Router();

// POST /start — Submit a new deep research job
router.post('/start', mutationLimiter, requireAuth, requirePlan('premium'), startResearchHandler);

// GET / — List user's research jobs
router.get('/', heavyReadLimiter, requireAuth, requirePlan('premium'), listJobsHandler);

// GET /:id/status — Check job status
router.get('/:id/status', heavyReadLimiter, requireAuth, requirePlan('premium'), getStatusHandler);

// GET /:id/result — Get completed job result
router.get('/:id/result', heavyReadLimiter, requireAuth, requirePlan('premium'), getResultHandler);

// POST /:id/followup — Submit a follow-up question
router.post('/:id/followup', mutationLimiter, requireAuth, requirePlan('premium'), followUpHandler);

// POST /:id/cancel — Cancel an active job
router.post('/:id/cancel', mutationLimiter, requireAuth, requirePlan('premium'), cancelHandler);

export default router;
