import { Router } from 'express';
import {
  listGoalsHandler,
  getGoalHandler,
  createGoalHandler,
  updateGoalHandler,
  deleteGoalHandler,
} from '../controllers/goals.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

// GET endpoints public (for leaderboard display)
router.get('/', listGoalsHandler);
router.get('/:id', getGoalHandler);

// Mutations require authentication + rate limiting
router.post('/', mutationLimiter, requireAuth, createGoalHandler);
router.put('/:id', mutationLimiter, requireAuth, updateGoalHandler);
router.delete('/:id', mutationLimiter, requireAuth, deleteGoalHandler);

export default router;
