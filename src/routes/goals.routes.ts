import { Router } from 'express';
import {
  listGoalsHandler,
  getGoalHandler,
  createGoalHandler,
  updateGoalHandler,
  deleteGoalHandler,
} from '../controllers/goals.controller';

const router = Router();

router.get('/', listGoalsHandler);
router.get('/:id', getGoalHandler);
router.post('/', createGoalHandler);
router.put('/:id', updateGoalHandler);
router.delete('/:id', deleteGoalHandler);

export default router;
