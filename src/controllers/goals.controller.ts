import { Request, Response } from 'express';
import {
  getAllGoalsWithProgress,
  getGoalWithProgress,
  createGoal,
  updateGoal,
  deleteGoal,
} from '../services/goals.service';

export async function listGoalsHandler(req: Request, res: Response): Promise<void> {
  try {
    const goals = await getAllGoalsWithProgress();
    res.json(goals);
  } catch (error) {
    console.error('Error listing goals:');
    res.status(500).json({ error: 'Failed to list goals' });
  }
}

export async function getGoalHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const goal = await getGoalWithProgress(id);

    if (!goal) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }

    res.json(goal);
  } catch (error) {
    console.error('Error getting goal:');
    res.status(500).json({ error: 'Failed to get goal' });
  }
}

export async function createGoalHandler(req: Request, res: Response): Promise<void> {
  try {
    const { name, targetValue, monthlyContribution, deadline } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    if (typeof targetValue !== 'number' || targetValue <= 0) {
      res.status(400).json({ error: 'Target value must be a positive number' });
      return;
    }

    if (monthlyContribution !== undefined && (typeof monthlyContribution !== 'number' || monthlyContribution < 0)) {
      res.status(400).json({ error: 'Monthly contribution must be a non-negative number' });
      return;
    }

    if (deadline !== undefined && deadline !== null) {
      const deadlineDate = new Date(deadline);
      if (isNaN(deadlineDate.getTime())) {
        res.status(400).json({ error: 'Invalid deadline date format' });
        return;
      }
    }

    const goal = await createGoal({
      name: name.trim(),
      targetValue,
      monthlyContribution,
      deadline,
    });

    res.status(201).json(goal);
  } catch (error) {
    console.error('Error creating goal:');
    res.status(500).json({ error: 'Failed to create goal' });
  }
}

export async function updateGoalHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, targetValue, monthlyContribution, deadline } = req.body;

    // Validate inputs if provided
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      res.status(400).json({ error: 'Name must be a non-empty string' });
      return;
    }

    if (targetValue !== undefined && (typeof targetValue !== 'number' || targetValue <= 0)) {
      res.status(400).json({ error: 'Target value must be a positive number' });
      return;
    }

    if (monthlyContribution !== undefined && (typeof monthlyContribution !== 'number' || monthlyContribution < 0)) {
      res.status(400).json({ error: 'Monthly contribution must be a non-negative number' });
      return;
    }

    if (deadline !== undefined && deadline !== null) {
      const deadlineDate = new Date(deadline);
      if (isNaN(deadlineDate.getTime())) {
        res.status(400).json({ error: 'Invalid deadline date format' });
        return;
      }
    }

    const goal = await updateGoal(id, {
      name: name?.trim(),
      targetValue,
      monthlyContribution,
      deadline,
    });

    res.json(goal);
  } catch (error: any) {
    if (error?.code === 'P2025') {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }
    console.error('Error updating goal:');
    res.status(500).json({ error: 'Failed to update goal' });
  }
}

export async function deleteGoalHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await deleteGoal(id);
    res.status(204).send();
  } catch (error: any) {
    if (error?.code === 'P2025') {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }
    console.error('Error deleting goal:');
    res.status(500).json({ error: 'Failed to delete goal' });
  }
}
