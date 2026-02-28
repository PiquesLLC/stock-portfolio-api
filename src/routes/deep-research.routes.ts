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
router.post('/start', mutationLimiter, requireAuth, requirePlan('elite'), startResearchHandler);

// GET / — List user's research jobs
router.get('/', heavyReadLimiter, requireAuth, requirePlan('elite'), listJobsHandler);

// GET /:id/status — Check job status
router.get('/:id/status', heavyReadLimiter, requireAuth, requirePlan('elite'), getStatusHandler);

// GET /:id/result — Get completed job result
router.get('/:id/result', heavyReadLimiter, requireAuth, requirePlan('elite'), getResultHandler);

// POST /:id/followup — Submit a follow-up question
router.post('/:id/followup', mutationLimiter, requireAuth, requirePlan('elite'), followUpHandler);

// POST /:id/cancel — Cancel an active job
router.post('/:id/cancel', mutationLimiter, requireAuth, requirePlan('elite'), cancelHandler);

export default router;
