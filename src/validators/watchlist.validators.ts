import { z } from 'zod';

export const watchlistIdParamSchema = z.object({
  id: z.string().min(1),
});

export const watchlistIdTickerParamSchema = z.object({
  id: z.string().min(1),
  ticker: z.string().trim().min(1),
});

// L-4: SQLite does not constrain a Prisma `String`, so an unbounded free-text
// field is stored and re-served at whatever size the client sends. Cap every
// one of them. `color` is a CSS colour token, not prose — 32 is generous.
export const createWatchlistSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  color: z.string().max(32).optional(),
});

export const updateWatchlistSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    color: z.string().max(32).optional(),
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
  period: z.enum(['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', 'ALL']).optional(),
});
