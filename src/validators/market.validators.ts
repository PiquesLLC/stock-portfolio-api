import { z } from 'zod';

const upperString = z.string().trim().min(1).transform((value) => value.toUpperCase());

export const tickerParamSchema = z.object({
  ticker: upperString,
});

export const pricesQuerySchema = z.object({
  tickers: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean))
    .refine((tickers) => tickers.length > 0, 'No valid tickers'),
});

export const hourlyCandlesQuerySchema = z.object({
  period: z.enum(['1W', '1M', 'YTD']),
});

export const searchSymbolsQuerySchema = z.object({
  q: z.string().optional(),
  held: z.string().optional(),
});

export const marketNewsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const tickerNewsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const benchmarkParamSchema = z.object({
  ticker: z.enum(['SPY', 'QQQ', 'DIA']),
});

export const aiEventsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(7300).optional(),
});

export const stockQuestionSchema = z.object({
  question: z.string().trim().min(1).max(500),
});

export const historicalCagrQuerySchema = z.object({
  tickers: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean))
    .refine((tickers) => tickers.length > 0 && tickers.length <= 50, 'Invalid ticker list'),
});

export const heatmapQuerySchema = z.object({
  period: z.enum(['1D', '1W', '1M', '3M', '6M', '1Y']).optional(),
  index: z.enum(['SP500', 'DOW30', 'NASDAQ100']).optional(),
});
