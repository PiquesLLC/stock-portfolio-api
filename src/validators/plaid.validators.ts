import { z } from 'zod';

export const exchangeTokenSchema = z.object({
  publicToken: z.string().min(1, 'Public token is required'),
});

export const disconnectItemSchema = z.object({
  itemId: z.string().uuid('Invalid item ID'),
});
