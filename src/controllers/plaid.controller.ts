import { Request, Response } from 'express';
import { AuthRequest } from '../types/auth';
import { createLinkToken, exchangePublicToken, getPlaidItems, disconnectPlaidItem, handleItemWebhook, getInvestmentHoldings } from '../services/plaid.service';
import { exchangeTokenSchema, disconnectItemSchema, webhookPayloadSchema } from '../validators/plaid.validators';
import { config } from '../config';
import { verifyPlaidWebhook } from '../utils/plaid-webhook-verify';
import { syncHoldingsFromPlaid } from '../services/plaid-sync.service';

/**
 * POST /plaid/link-token
 * Create a Plaid Link token for the authenticated user.
 */
export async function createLinkTokenHandler(req: AuthRequest, res: Response) {
  try {
    const linkToken = await createLinkToken(req.user!.userId);
    res.json({ linkToken });
  } catch (_err) {
    console.error('[Plaid] Link token creation failed', _err instanceof Error ? _err.message : String(_err));
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
      return res.status(400).json({ error: 'Invalid request' });
    }

    const result = await exchangePublicToken(req.user!.userId, parsed.data.publicToken);
    res.json(result);
  } catch (_err) {
    console.error('[Plaid] Token exchange failed', _err instanceof Error ? _err.message : String(_err));
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
  } catch (_err) {
    console.error('[Plaid] Failed to retrieve items', _err instanceof Error ? _err.message : String(_err));
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
      return res.status(400).json({ error: 'Invalid item ID' });
    }

    const success = await disconnectPlaidItem(parsed.data.itemId, req.user!.userId);
    if (!success) {
      return res.status(404).json({ error: 'Linked account not found' });
    }
    res.json({ success: true });
  } catch (_err) {
    console.error('[Plaid] Disconnect failed', _err instanceof Error ? _err.message : String(_err));
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
      return res.status(400).json({ error: 'Invalid item ID' });
    }

    const holdings = await getInvestmentHoldings(parsed.data.itemId, req.user!.userId);
    res.json({ holdings });
  } catch (_err) {
    console.error('[Plaid] Holdings fetch failed', _err instanceof Error ? _err.message : String(_err));
    res.status(500).json({ error: 'Failed to fetch holdings' });
  }
}

/**
 * POST /plaid/items/:itemId/sync
 * Manually sync holdings from a linked brokerage into local holdings.
 */
export async function syncHoldingsHandler(req: AuthRequest, res: Response) {
  try {
    const parsed = disconnectItemSchema.safeParse({ itemId: req.params.itemId });
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const result = await syncHoldingsFromPlaid(parsed.data.itemId, req.user!.userId);
    res.json({ result });
  } catch (_err) {
    console.error('[Plaid] Holdings sync failed', _err instanceof Error ? _err.message : String(_err));
    res.status(500).json({ error: 'Failed to sync holdings' });
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

      // Use captured raw bytes — NEVER fall back to JSON.stringify (different bytes = hash mismatch)
      const rawBody = (req as any).rawBody;
      if (!rawBody) {
        console.error('[Plaid] Webhook raw body not captured');
        return res.status(500).json({ error: 'Webhook processing failed' });
      }

      const isValid = await verifyPlaidWebhook(plaidVerification, rawBody);
      if (!isValid) {
        console.error('[Plaid] Webhook signature verification failed');
        return res.status(401).json({ error: 'Webhook verification failed' });
      }
    }

    // Validate webhook payload schema
    const parsed = webhookPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    const { webhook_type, webhook_code, item_id, error } = parsed.data;
    await handleItemWebhook(webhook_type, webhook_code, item_id, error);
    res.json({ received: true });
  } catch (_err) {
    console.error('[Plaid] Webhook processing error', _err instanceof Error ? _err.message : String(_err));
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}
