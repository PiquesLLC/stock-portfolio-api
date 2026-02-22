import { z } from 'zod';

export const reportUserBodySchema = z.object({
  reason: z.enum(['misleading', 'spam', 'inappropriate', 'harassment', 'other']),
  description: z.string().max(1000).optional(),
  context: z.string().optional(),
}).strict();
