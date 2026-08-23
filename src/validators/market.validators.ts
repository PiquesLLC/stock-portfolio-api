import { z } from 'zod';

// L-1: a ticker used to be any non-empty string. It is interpolated into
// upstream provider URLs and used verbatim as a cache key, so an unvalidated
// value could smuggle extra query parameters into a provider request and mint
// unbounded distinct cache entries. The allowlist below covers every real
// symbol shape we handle:
//   AAPL · BRK.B · BRK-B · ^GSPC · EURUSD=X · 005930.KS
//   AAPL240119C00150000 (OCC options — 21 chars max, see utils/occ-parser.ts)
// and excludes the characters that make URL/query injection possible
// (/ ? # & % : @ whitespace and control chars).
const SYMBOL_MAX_LENGTH = 24;
const SYMBOL_PATTERN = /^[A-Z0-9.\-^=_]+$/;

const symbolString = z
  .string()
  .trim()
  .min(1)
  .max(SYMBOL_MAX_LENGTH, 'Ticker is too long')
  .transform((value) => value.toUpperCase())
  .refine((value) => SYMBOL_PATTERN.test(value), 'Invalid ticker symbol');

export const tickerParamSchema = z.object({
  ticker: symbolString,
});

export const pricesQuerySchema = z.object({
  tickers: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean))
    // Drop malformed entries rather than 400-ing the whole batch: this endpoint
    // is called with a whole portfolio's worth of symbols and one bad entry
    // should not blank the dashboard.
    .transform((tickers) => tickers.filter((t) => t.length <= SYMBOL_MAX_LENGTH && SYMBOL_PATTERN.test(t)))
    .refine((tickers) => tickers.length > 0, 'No valid tickers')
    // Matches config.maxRefreshTickers (MAX_REFRESH_TICKERS, default 500) so a
    // legitimately large portfolio is never truncated by this validator.
    .refine((tickers) => tickers.length <= 500, 'Too many tickers'),
});

export const hourlyCandlesQuerySchema = z.object({
  period: z.enum(['1W', '1M', '6M', 'YTD']),
});

export const candleQuerySchema = z.object({
  period: z.enum(['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', 'MAX']),
  interval: z.enum(['1m', '5m', '15m', '1h', '1D', '1W', '1M']),
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
