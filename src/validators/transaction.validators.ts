import { z } from 'zod';

export const transactionIdParamSchema = z.object({
  id: z.string().min(1),
});

export const addTransactionSchema = z.object({
  type: z.enum(['deposit', 'withdrawal']),
  amount: z.number().positive(),
  date: z.string().min(1).refine((value) => !Number.isNaN(new Date(value).getTime()), 'Invalid date'),
});
