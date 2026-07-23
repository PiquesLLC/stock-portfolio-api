import { z } from 'zod';

export const addHoldingSchema = z.object({
  ticker: z.string().trim().min(1),
  // A2: bound absurd values (fat-finger / fabrication floor), matching the
  // screenshot-import bounds (MAX_SHARES 1e9, MAX_PRICE 1e7). Ticker-relative
  // plausibility is unenforceable for self-reported data — the real assurance
  // is brokerage (Plaid) verification + the "self-reported" labelling.
  shares: z.number().positive().max(1e9),
  averageCost: z.number().positive().max(1e7),
  skipTransaction: z.boolean().optional(),
  skipActivity: z.boolean().optional(),
});

export const removeHoldingParamsSchema = z.object({
  ticker: z.string().trim().min(1),
});

export const removeHoldingQuerySchema = z.object({
  skipTransaction: z.enum(['true', 'false']).optional(),
  skipActivity: z.enum(['true', 'false']).optional(),
});

export const setCashBalanceSchema = z.object({
  // Upper bound is a fat-finger ceiling (~$1T), consistent with the holding bounds.
  cashBalance: z.number().min(0).max(1e12),
});
