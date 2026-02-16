import { z } from 'zod';

export const addHoldingSchema = z.object({
  ticker: z.string().trim().min(1),
  shares: z.number().positive(),
  averageCost: z.number().positive(),
  skipTransaction: z.boolean().optional(),
});

export const removeHoldingParamsSchema = z.object({
  ticker: z.string().trim().min(1),
});

export const removeHoldingQuerySchema = z.object({
  skipTransaction: z.enum(['true', 'false']).optional(),
});

export const setCashBalanceSchema = z.object({
  cashBalance: z.number().min(0),
});
