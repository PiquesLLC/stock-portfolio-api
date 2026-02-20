import { z } from 'zod';

export const applySchema = z.object({
  pitch: z.string().trim().max(500, 'Pitch must be at most 500 characters').optional(),
});

const pricingCentsSchema = z.union([z.literal(500), z.literal(1500), z.literal(4900)]);
const trialDaysSchema = z.union([z.literal(0), z.literal(7)]);
const tradeDelaySchema = z.union([z.literal(0), z.literal(24), z.literal(48), z.literal(72)]);

export const updateSettingsSchema = z.object({
  pricingCents: pricingCentsSchema.optional(),
  trialDays: trialDaysSchema.optional(),
  pitch: z.string().trim().max(500, 'Pitch must be at most 500 characters').nullable().optional(),
  showHoldings: z.boolean().optional(),
  showTradeHistory: z.boolean().optional(),
  showRationale: z.boolean().optional(),
  showSectors: z.boolean().optional(),
  showRiskMetrics: z.boolean().optional(),
  showWatchlists: z.boolean().optional(),
  tradeDelayHours: tradeDelaySchema.optional(),
  hideShareCount: z.boolean().optional(),
});

export const reportSchema = z.object({
  reason: z.enum(['misleading', 'spam', 'inappropriate', 'other']),
  description: z.string().trim().max(1000, 'Description must be at most 1000 characters').optional(),
});

