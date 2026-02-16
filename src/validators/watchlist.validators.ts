import { z } from 'zod';

export const watchlistIdParamSchema = z.object({
  id: z.string().min(1),
});

export const watchlistIdTickerParamSchema = z.object({
  id: z.string().min(1),
  ticker: z.string().trim().min(1),
});

export const createWatchlistSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  color: z.string().optional(),
});

export const updateWatchlistSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    color: z.string().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, 'At least one field must be provided');

export const addWatchlistHoldingSchema = z.object({
  ticker: z.string().trim().min(1),
  shares: z.number().positive(),
  averageCost: z.number().min(0),
});

export const updateWatchlistHoldingSchema = z
  .object({
    shares: z.number().positive().optional(),
    averageCost: z.number().min(0).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, 'At least one field must be provided');

export const watchlistChartQuerySchema = z.object({
  period: z.enum(['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL']).optional(),
});
