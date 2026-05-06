import { z } from 'zod';

export const RESEARCH_TYPES = ['stock', 'portfolio', 'sector', 'custom'] as const;

export const startResearchSchema = z.object({
  prompt: z.string().trim().min(10, 'Prompt must be at least 10 characters').max(2000, 'Prompt must be at most 2000 characters'),
  ticker: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z0-9.\-]{1,10}$/, 'Invalid ticker')).optional(),
  researchType: z.enum(RESEARCH_TYPES).default('stock'),
  clientRequestId: z.string().trim().min(1).max(128).optional(),
});

export const followUpSchema = z.object({
  question: z.string().trim().min(5, 'Question must be at least 5 characters').max(1000, 'Question must be at most 1000 characters'),
});

export const jobIdParamSchema = z.object({
  id: z.string().uuid('Invalid job ID'),
});

export const listJobsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(['queued', 'submitted', 'in_progress', 'completed', 'failed', 'cancelled']).optional(),
  // Default false: archived rows are hidden from the main list. UI passes
  // `includeArchived=1` to fetch the archived view. Avoid `z.coerce.boolean()`
  // — it uses JS truthy semantics, so the strings "false" and "0" coerce to
  // `true`. Map only the explicit truthy tokens; everything else is false.
  includeArchived: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => v === true || v === '1' || v === 'true'),
});
