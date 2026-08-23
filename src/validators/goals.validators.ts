import { z } from 'zod';

export const goalIdParamSchema = z.object({
  id: z.string().min(1),
});

const optionalDateString = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), 'Invalid date');

// L-4: cap the free-text name (SQLite does not constrain a Prisma `String`) and
// give the money fields the same ~$1T fat-finger ceiling used for cash balances
// in portfolio.validators.ts, so goal projections can't be fed absurd inputs.
const MAX_GOAL_VALUE = 1e12;

export const createGoalSchema = z.object({
  name: z.string().trim().min(1).max(100),
  targetValue: z.number().positive().max(MAX_GOAL_VALUE),
  currentValue: z.number().min(0).max(MAX_GOAL_VALUE).nullable().optional(),
  monthlyContribution: z.number().min(0).max(MAX_GOAL_VALUE).optional(),
  deadline: optionalDateString.nullable().optional(),
});

export const updateGoalSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    targetValue: z.number().positive().max(MAX_GOAL_VALUE).optional(),
    currentValue: z.number().min(0).max(MAX_GOAL_VALUE).nullable().optional(),
    monthlyContribution: z.number().min(0).max(MAX_GOAL_VALUE).optional(),
    deadline: optionalDateString.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, 'At least one field must be provided');
