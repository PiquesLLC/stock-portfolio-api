import { Request, Response } from 'express';
import { AuthRequest } from '../types/auth';
import { createLinkToken, exchangePublicToken, getPlaidItems, disconnectPlaidItem, handleItemWebhook, getInvestmentHoldings } from '../services/plaid.service';
import { exchangeTokenSchema, disconnectItemSchema } from '../validators/plaid.validators';
import { config } from '../config';
import { verifyPlaidWebhook } from '../utils/plaid-webhook-verify';

/**
 * POST /plaid/link-token
 * Create a Plaid Link token for the authenticated user.
 */
export async function createLinkTokenHandler(req: AuthRequest, res: Response) {
  try {
    const linkToken = await createLinkToken(req.user!.userId);
    res.json({ linkToken });
  } catch (err: any) {
    console.error('[Plaid] Link token error:', err.message);
    res.status(500).json({ error: 'Failed to create link token' });
  }
}

/**
 * POST /plaid/exchange-token
 * Exchange a public token from Plaid Link for an access token.
 */
export async function exchangeTokenHandler(req: AuthRequest, res: Response) {
  try {
    const parsed = exchangeTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const result = await exchangePublicToken(req.user!.userId, parsed.data.publicToken);
    res.json(result);
  } catch (err: any) {
    console.error('[Plaid] Exchange token error:', err.message);
    res.status(500).json({ error: 'Failed to link account' });
  }
}

/**
 * GET /plaid/items
 * List all linked Plaid items for the authenticated user.
 */
export async function getItemsHandler(req: AuthRequest, res: Response) {
  try {
    const items = await getPlaidItems(req.user!.userId);
    res.json({ items });
  } catch (err: any) {
    console.error('[Plaid] Get items error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve linked accounts' });
  }
}

/**
 * DELETE /plaid/items/:itemId
 * Disconnect a Plaid item (revoke access).
 */
export async function disconnectItemHandler(req: AuthRequest, res: Response) {
  try {
    const parsed = disconnectItemSchema.safeParse({ itemId: req.params.itemId });
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const success = await disconnectPlaidItem(parsed.data.itemId, req.user!.userId);
    if (!success) {
      return res.status(404).json({ error: 'Linked account not found' });
    }
    res.json({ success: true });
  } catch (err: any) {
    console.error('[Plaid] Disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect account' });
  }
}

/**
 * GET /plaid/items/:itemId/holdings
 * Fetch investment holdings from a linked brokerage.
 */
export async function getHoldingsHandler(req: AuthRequest, res: Response) {
  try {
    const parsed = disconnectItemSchema.safeParse({ itemId: req.params.itemId });
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const holdings = await getInvestmentHoldings(parsed.data.itemId, req.user!.userId);
    res.json({ holdings });
  } catch (err: any) {
    console.error('[Plaid] Holdings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch holdings' });
  }
}

/**
 * POST /plaid/webhook
 * Handle Plaid webhook callbacks. Verifies webhook JWT signature.
 *
 * In sandbox mode, verification is skipped for testing.
 * In development/production, the Plaid-Verification header JWT is verified
 * against Plaid's public key endpoint and the request body hash is checked.
 */
export async function webhookHandler(req: Request, res: Response) {
  try {
    // Plaid signs webhooks with a JWT in the Plaid-Verification header.
    if (config.plaidEnv !== 'sandbox') {
      const plaidVerification = req.headers['plaid-verification'] as string;
      if (!plaidVerification) {
        return res.status(401).json({ error: 'Missing webhook verification' });
      }

      // Verify JWT signature and body hash
      const rawBody = JSON.stringify(req.body);
      const isValid = await verifyPlaidWebhook(plaidVerification, rawBody);
      if (!isValid) {
        console.error('[Plaid] Webhook verification failed');
        return res.status(401).json({ error: 'Webhook verification failed' });
      }
    }

    const { webhook_type, webhook_code, item_id, error } = req.body;

    if (!webhook_type || !webhook_code || !item_id) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    await handleItemWebhook(webhook_type, webhook_code, item_id, error);
    res.json({ received: true });
  } catch (err: any) {
    console.error('[Plaid] Webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}
