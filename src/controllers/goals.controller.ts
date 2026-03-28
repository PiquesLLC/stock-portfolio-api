import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import {
  getAllGoalsWithProgress,
  getGoalWithProgress,
  createGoal,
  updateGoal,
  deleteGoal,
} from '../services/goals.service';
import {
  createGoalSchema,
  goalIdParamSchema,
  updateGoalSchema,
} from '../validators/goals.validators';
import { validatePortfolioOwnership } from '../utils/validatePortfolioOwnership';

export async function listGoalsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const portfolioId = req.query.portfolioId as string | undefined;
    await validatePortfolioOwnership(portfolioId, req.user!.userId);
    const goals = await getAllGoalsWithProgress(req.user!.userId, portfolioId);
    res.json(goals);
  } catch (error: unknown) {
    console.error('Error listing goals:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to list goals' });
  }
}

export async function getGoalHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsedParams = goalIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const portfolioId = req.query.portfolioId as string | undefined;
    await validatePortfolioOwnership(portfolioId, req.user!.userId);

    const { id } = parsedParams.data;
    const goal = await getGoalWithProgress(id, req.user!.userId, portfolioId);

    if (!goal) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }

    res.json(goal);
  } catch (error: unknown) {
    console.error('Error getting goal:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to get goal' });
  }
}

export async function createGoalHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const portfolioId = req.query.portfolioId as string | undefined;
    await validatePortfolioOwnership(portfolioId, req.user!.userId);

    const parsed = createGoalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const { name, targetValue, monthlyContribution, deadline, currentValue } = parsed.data;
    const goal = await createGoal({
      name,
      targetValue,
      monthlyContribution,
      deadline,
      currentValue,
    }, req.user!.userId);

    res.status(201).json(goal);
  } catch (error: unknown) {
    console.error('Error creating goal:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to create goal' });
  }
}

export async function updateGoalHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const portfolioId = req.query.portfolioId as string | undefined;
    await validatePortfolioOwnership(portfolioId, req.user!.userId);

    const parsedParams = goalIdParamSchema.safeParse(req.params);
    const parsedBody = updateGoalSchema.safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const { id } = parsedParams.data;
    const { name, targetValue, monthlyContribution, deadline, currentValue } = parsedBody.data;
    const goal = await updateGoal(id, {
      name,
      targetValue,
      monthlyContribution,
      deadline,
      currentValue,
    }, req.user!.userId);

    res.json(goal);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'P2025') {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }
    console.error('Error updating goal:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to update goal' });
  }
}

export async function deleteGoalHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const portfolioId = req.query.portfolioId as string | undefined;
    await validatePortfolioOwnership(portfolioId, req.user!.userId);

    const parsedParams = goalIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const { id } = parsedParams.data;
    await deleteGoal(id, req.user!.userId);
    res.status(204).send();
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'P2025') {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }
    console.error('Error deleting goal:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to delete goal' });
  }
}
