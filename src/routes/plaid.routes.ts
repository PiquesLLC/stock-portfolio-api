import { Router } from 'express';
import { createLinkTokenHandler, exchangeTokenHandler, getItemsHandler, disconnectItemHandler, webhookHandler } from '../controllers/plaid.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

// All routes except webhook require auth
// POST /plaid/link-token - Create Plaid Link token
router.post('/link-token', mutationLimiter, requireAuth, createLinkTokenHandler);

// POST /plaid/exchange-token - Exchange public token for access token
router.post('/exchange-token', mutationLimiter, requireAuth, exchangeTokenHandler);

// GET /plaid/items - List linked accounts
router.get('/items', requireAuth, getItemsHandler);

// DELETE /plaid/items/:itemId - Disconnect a linked account
router.delete('/items/:itemId', mutationLimiter, requireAuth, disconnectItemHandler);

// POST /plaid/webhook - Plaid webhook (no auth — Plaid calls this directly)
router.post('/webhook', webhookHandler);

export default router;
