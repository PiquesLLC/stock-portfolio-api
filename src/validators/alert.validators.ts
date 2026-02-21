import { z } from 'zod';

export const alertIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const updateAlertBodySchema = z.object({
  threshold: z.number().nullable().optional(),
  enabled: z.boolean().optional(),
}).strict();
