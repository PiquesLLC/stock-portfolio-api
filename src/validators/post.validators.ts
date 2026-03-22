import { z } from 'zod';

export const createPostBodySchema = z.object({
  content: z.string().trim().min(1, 'Content is required').max(1000, 'Content must be 1000 characters or less'),
  ticker: z.string().max(10).regex(/^[A-Z0-9.\-/]{1,10}$/i, 'Invalid ticker format').optional(),
  type: z.enum(['thought', 'analysis', 'trade_idea']).optional(),
  attachmentType: z.enum(['stock_chart', 'portfolio_chart', 'trade']).optional(),
  attachmentData: z.object({
    ticker: z.string().max(10).optional(),
    period: z.string().max(5).optional(),
    action: z.string().max(10).optional(),
    shares: z.number().optional(),
    price: z.number().optional(),
    image: z.string().max(4000000).optional(), // base64 chart capture (max ~4MB)
  }).optional(),
});

export const createCommentBodySchema = z.object({
  content: z.string().trim().min(1, 'Content is required').max(500, 'Content must be 500 characters or less'),
});
