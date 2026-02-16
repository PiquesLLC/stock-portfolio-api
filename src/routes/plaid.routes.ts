import { Router } from 'express';
import { createLinkTokenHandler, exchangeTokenHandler, getItemsHandler, disconnectItemHandler, getHoldingsHandler, syncHoldingsHandler, webhookHandler } from '../controllers/plaid.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter, webhookLimiter } from '../middleware/rateLimiter';
import { requireMfaAssurance } from '../middleware/mfa-assurance.middleware';

const router = Router();

// Sensitive Plaid operations require auth + MFA step-up (if user has MFA enabled)
// POST /plaid/link-token - Create Plaid Link token
router.post('/link-token', mutationLimiter, requireAuth, requireMfaAssurance, createLinkTokenHandler);

// POST /plaid/exchange-token - Exchange public token for access token
router.post('/exchange-token', mutationLimiter, requireAuth, requireMfaAssurance, exchangeTokenHandler);

// GET /plaid/items - List linked accounts (read-only, no MFA step-up needed)
router.get('/items', requireAuth, getItemsHandler);

// GET /plaid/items/:itemId/holdings - Fetch holdings from linked brokerage
router.get('/items/:itemId/holdings', requireAuth, getHoldingsHandler);

// POST /plaid/items/:itemId/sync - Re-sync holdings from linked brokerage
router.post('/items/:itemId/sync', mutationLimiter, requireAuth, syncHoldingsHandler);

// DELETE /plaid/items/:itemId - Disconnect a linked account (sensitive — requires MFA)
router.delete('/items/:itemId', mutationLimiter, requireAuth, requireMfaAssurance, disconnectItemHandler);

// POST /plaid/webhook - Plaid webhook (no auth — Plaid calls this directly, verified via JWT)
router.post('/webhook', webhookLimiter, webhookHandler);

export default router;
