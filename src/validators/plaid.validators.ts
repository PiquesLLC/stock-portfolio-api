import { z } from 'zod';

// Plaid public tokens follow the format: public-<env>-<uuid>
const PLAID_PUBLIC_TOKEN_RE = /^public-(sandbox|development|production)-[0-9a-f-]{36}$/;

export const exchangeTokenSchema = z.object({
  publicToken: z.string()
    .min(1, 'Public token is required')
    .regex(PLAID_PUBLIC_TOKEN_RE, 'Invalid public token format'),
});

export const disconnectItemSchema = z.object({
  itemId: z.string().uuid('Invalid item ID'),
});

// Webhook payload validation — strict allowlists per webhook_type
const VALID_WEBHOOK_CODES: Record<string, string[]> = {
  ITEM: ['ERROR', 'PENDING_EXPIRATION', 'USER_PERMISSION_REVOKED', 'WEBHOOK_UPDATE_ACKNOWLEDGED'],
  HOLDINGS: ['DEFAULT_UPDATE'],
  INVESTMENTS_TRANSACTIONS: ['DEFAULT_UPDATE'],
  ASSETS: ['PRODUCT_READY', 'ERROR'],
};

export const webhookPayloadSchema = z.object({
  webhook_type: z.string(),
  webhook_code: z.string().min(1, 'Webhook code is required'),
  item_id: z.string().min(1, 'Item ID is required'),
  error: z.object({
    error_code: z.string(),
    error_message: z.string(),
  }).optional(),
}).refine(
  (data) => {
    const validCodes = VALID_WEBHOOK_CODES[data.webhook_type];
    return validCodes !== undefined && validCodes.includes(data.webhook_code);
  },
  { message: 'Invalid webhook type/code combination' }
);
