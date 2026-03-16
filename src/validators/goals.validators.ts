import { z } from 'zod';

export const goalIdParamSchema = z.object({
  id: z.string().min(1),
});

const optionalDateString = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), 'Invalid date');

export const createGoalSchema = z.object({
  name: z.string().trim().min(1),
  targetValue: z.number().positive(),
  currentValue: z.number().min(0).nullable().optional(),
  monthlyContribution: z.number().min(0).optional(),
  deadline: optionalDateString.nullable().optional(),
});

export const updateGoalSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    targetValue: z.number().positive().optional(),
    currentValue: z.number().min(0).nullable().optional(),
    monthlyContribution: z.number().min(0).optional(),
    deadline: optionalDateString.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, 'At least one field must be provided');
