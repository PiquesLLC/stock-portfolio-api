import prisma from '../utils/prisma';
import { Goal, GoalInput, GoalWithProgress, TimeToGoalRange } from '../types';
import { getPortfolio } from './portfolio.service';
import { config } from '../config';



/**
 * Get all goals for a user
 */
export async function getAllGoals(userId: string): Promise<Goal[]> {
  const goals = await prisma.goal.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  return goals as Goal[];
}

/**
 * Get a single goal by ID (scoped to user)
 */
export async function getGoalById(id: string, userId: string): Promise<Goal | null> {
  const goal = await prisma.goal.findFirst({
    where: { id, userId },
  });
  return goal as Goal | null;
}

/**
 * Create a new goal
 */
export async function createGoal(input: GoalInput, userId: string): Promise<Goal> {
  const goal = await prisma.goal.create({
    data: {
      userId,
      name: input.name,
      targetValue: input.targetValue,
      currentValue: input.currentValue ?? null,
      monthlyContribution: input.monthlyContribution ?? 0,
      deadline: input.deadline ? new Date(input.deadline) : null,
    },
  });
  return goal as Goal;
}

/**
 * Update an existing goal (scoped to user)
 */
export async function updateGoal(id: string, input: Partial<GoalInput>, userId: string): Promise<Goal> {
  // Verify ownership before updating
  const existing = await prisma.goal.findFirst({ where: { id, userId } });
  if (!existing) {
    const err = new Error('Goal not found') as Error & { code: string };
    err.code = 'P2025';
    throw err;
  }

  const updateData: Record<string, unknown> = {};

  if (input.name !== undefined) {
    updateData.name = input.name;
  }
  if (input.targetValue !== undefined) {
    updateData.targetValue = input.targetValue;
  }
  if (input.currentValue !== undefined) {
    updateData.currentValue = input.currentValue;
  }
  if (input.monthlyContribution !== undefined) {
    updateData.monthlyContribution = input.monthlyContribution;
  }
  if (input.deadline !== undefined) {
    updateData.deadline = input.deadline ? new Date(input.deadline) : null;
  }

  const goal = await prisma.goal.update({
    where: { id },
    data: updateData,
  });
  return goal as Goal;
}

/**
 * Delete a goal (scoped to user)
 */
export async function deleteGoal(id: string, userId: string): Promise<void> {
  // Verify ownership before deleting
  const existing = await prisma.goal.findFirst({ where: { id, userId } });
  if (!existing) {
    const err = new Error('Goal not found') as Error & { code: string };
    err.code = 'P2025';
    throw err;
  }

  await prisma.goal.delete({
    where: { id },
  });
}

/**
 * Calculate time to goal in months given:
 * - current value
 * - target value
 * - monthly contribution
 * - annual growth rate
 */
function calculateTimeToGoalMonths(
  currentValue: number,
  targetValue: number,
  monthlyContribution: number,
  annualGrowthRate: number
): number | null {
  // Already achieved
  if (currentValue >= targetValue) {
    return 0;
  }

  // If no growth and no contributions, can never reach goal
  if (annualGrowthRate <= 0 && monthlyContribution <= 0) {
    return null;
  }

  const monthlyRate = Math.pow(1 + annualGrowthRate, 1 / 12) - 1;

  // If no contributions, calculate pure growth time
  if (monthlyContribution <= 0) {
    if (monthlyRate <= 0) return null;
    const months = Math.log(targetValue / currentValue) / Math.log(1 + monthlyRate);
    return Math.ceil(months);
  }

  // With contributions, use iterative calculation (binary search)
  let low = 1;
  let high = 1200; // 100 years max

  const calculateFV = (months: number): number => {
    const growthFactor = Math.pow(1 + monthlyRate, months);
    const portfolioGrowth = currentValue * growthFactor;
    const contributionGrowth = monthlyContribution * ((growthFactor - 1) / monthlyRate);
    return portfolioGrowth + contributionGrowth;
  };

  // Check if achievable within max time
  if (calculateFV(high) < targetValue) {
    return null;
  }

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const fv = calculateFV(mid);

    if (fv >= targetValue) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return low;
}

/**
 * Convert months to projected date
 */
function monthsToDate(months: number | null): string | null {
  if (months === null) return null;
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return date.toISOString().split('T')[0];
}

/**
 * Calculate time-to-goal range using simple return scenarios
 * (Avoids slow historical data fetch)
 */
function calculateTimeToGoalRange(
  currentValue: number,
  targetValue: number,
  monthlyContribution: number
): TimeToGoalRange {
  // Base case: use S&P 500 historical average (10%)
  const baseAnnualReturn = config.sp500CagrTotalReturn;

  // Optimistic case: 15% annual return (good market conditions)
  const optimisticReturn = 0.15;

  // Pessimistic case: 5% annual return (sluggish market)
  const pessimisticReturn = 0.05;

  const optimistic = calculateTimeToGoalMonths(
    currentValue,
    targetValue,
    monthlyContribution,
    optimisticReturn
  );

  const base = calculateTimeToGoalMonths(
    currentValue,
    targetValue,
    monthlyContribution,
    baseAnnualReturn
  );

  const pessimistic = calculateTimeToGoalMonths(
    currentValue,
    targetValue,
    monthlyContribution,
    pessimisticReturn
  );

  return { optimistic, base, pessimistic };
}

/**
 * Get all goals with progress calculations
 */
export async function getAllGoalsWithProgress(userId: string, portfolioId?: string): Promise<GoalWithProgress[]> {
  const goals = await getAllGoals(userId);
  const portfolio = await getPortfolio(userId, { portfolioId });
  const currentValue = portfolio.netEquity;

  return goals.map((goal) => {
    const goalCurrentValue = goal.currentValue != null ? goal.currentValue : currentValue;
    const progress = Math.min(100, (goalCurrentValue / goal.targetValue) * 100);
    const timeToGoal = calculateTimeToGoalRange(
      goalCurrentValue,
      goal.targetValue,
      goal.monthlyContribution
    );

    return {
      ...goal,
      currentProgress: Math.round(progress * 100) / 100,
      currentPortfolioValue: goalCurrentValue,
      timeToGoal,
      projectedDate: {
        optimistic: monthsToDate(timeToGoal.optimistic),
        base: monthsToDate(timeToGoal.base),
        pessimistic: monthsToDate(timeToGoal.pessimistic),
      },
    };
  });
}

/**
 * Get a single goal with progress
 */
export async function getGoalWithProgress(id: string, userId: string, portfolioId?: string): Promise<GoalWithProgress | null> {
  const goal = await getGoalById(id, userId);
  if (!goal) return null;

  const portfolio = await getPortfolio(userId, { portfolioId });
  const currentValue = portfolio.netEquity;

  const goalCurrentValue = goal.currentValue != null ? goal.currentValue : currentValue;
  const progress = Math.min(100, (goalCurrentValue / goal.targetValue) * 100);
  const timeToGoal = calculateTimeToGoalRange(
    goalCurrentValue,
    goal.targetValue,
    goal.monthlyContribution
  );

  return {
    ...goal,
    currentProgress: Math.round(progress * 100) / 100,
    currentPortfolioValue: goalCurrentValue,
    timeToGoal,
    projectedDate: {
      optimistic: monthsToDate(timeToGoal.optimistic),
      base: monthsToDate(timeToGoal.base),
      pessimistic: monthsToDate(timeToGoal.pessimistic),
    },
  };
}

