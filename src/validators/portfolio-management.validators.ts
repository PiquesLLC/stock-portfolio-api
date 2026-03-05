import { z } from 'zod';

export const portfolioIdParamSchema = z.object({
  id: z.string().min(1),
});

export const createPortfolioSchema = z.object({
  name: z.string().trim().min(1).max(50),
  type: z.string().trim().min(1).max(30).optional(),
});

export const updatePortfolioSchema = z
  .object({
    name: z.string().trim().min(1).max(50).optional(),
    type: z.string().trim().min(1).max(30).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, 'At least one field must be provided');
