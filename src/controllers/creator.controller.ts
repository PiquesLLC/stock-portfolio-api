import { Request, Response } from 'express';
import Stripe from 'stripe';
import { AuthRequest } from '../types/auth';
import { config } from '../config';
import { formatZodError } from '../validators/auth.validators';
import { applySchema, reportSchema, updateSettingsSchema } from '../validators/creator.validators';
import {
  activateCreator,
  applyAsCreator,
  getCreatorDashboard,
  getCreatorProfile,
  getEntitlement,
  getLockedContent,
  getMyCreatorSubscriptions,
  reportCreator,
  updateCreatorSettings,
} from '../services/creator.service';
import {
  cancelCreatorSubscription,
  createCreatorCheckoutSession,
  getCreatorLedger,
  createStripeConnectOnboardingLink,
  getPayoutBalance,
  handleCreatorWebhookEvent,
  requestPayout,
} from '../services/creator-billing.service';

const DISCLAIMER = 'Educational content only. Not investment advice.';
const ALLOWED_LOCKED_CONTENT_SECTIONS = new Set([
  'holdings',
  'tradeHistory',
  'rationale',
  'sectors',
  'riskMetrics',
  'watchlists',
]);

export async function applyCreatorHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const result = await applyAsCreator(userId, parsed.data.pitch);
    res.json({ ...result, disclaimer: DISCLAIMER });
  } catch (error) {
    console.error('[Creator] applyCreatorHandler failed:', error);
    res.status(500).json({ error: 'Failed to apply as creator' });
  }
}

export async function activateCreatorHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const requesterId = req.user?.userId;
    if (!requesterId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!config.creatorAdminUserIds.includes(requesterId)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    const { userId } = req.params;
    await activateCreator(userId);
    res.json({ ok: true });
  } catch (error) {
    console.error('[Creator] activateCreatorHandler failed:', error);
    res.status(500).json({ error: 'Failed to activate creator' });
  }
}

export async function getCreatorProfileHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const profile = await getCreatorProfile(userId, req.user?.userId);
    if (!profile) {
      res.status(404).json({ error: 'Creator not found' });
      return;
    }
    res.json(profile);
  } catch (error) {
    console.error('[Creator] getCreatorProfileHandler failed:', error);
    res.status(500).json({ error: 'Failed to fetch creator profile' });
  }
}

export async function getCreatorEntitlementHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const entitlement = await getEntitlement(userId, req.user?.userId);
    res.json(entitlement);
  } catch (error) {
    console.error('[Creator] getCreatorEntitlementHandler failed:', error);
    res.status(500).json({ error: 'Failed to fetch entitlement' });
  }
}

export async function getCreatorLockedContentHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const viewerId = req.user?.userId;
    if (!viewerId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { userId } = req.params;
    const rawSection = String(req.query.section || '').trim();
    if (!rawSection) {
      res.status(400).json({ error: 'section query is required' });
      return;
    }
    if (!ALLOWED_LOCKED_CONTENT_SECTIONS.has(rawSection)) {
      res.status(400).json({ error: 'Invalid section' });
      return;
    }
    const section = rawSection as 'holdings' | 'tradeHistory' | 'rationale' | 'sectors' | 'riskMetrics' | 'watchlists';
    if (!section) {
      res.status(400).json({ error: 'section query is required' });
      return;
    }
    const data = await getLockedContent(userId, viewerId, section);
    res.json({ section, data });
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'FORBIDDEN') {
      res.status(403).json({ error: 'Locked content requires paid subscription' });
      return;
    }
    console.error('[Creator] getCreatorLockedContentHandler failed:', error);
    res.status(500).json({ error: 'Failed to fetch locked content' });
  }
}

export async function updateCreatorSettingsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const parsed = updateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    await updateCreatorSettings(userId, parsed.data);
    res.json({ ok: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to update creator settings';
    res.status(400).json({ error: msg });
  }
}

export async function creatorDashboardHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const data = await getCreatorDashboard(userId);
    res.json(data);
  } catch (error) {
    console.error('[Creator] creatorDashboardHandler failed:', error);
    res.status(500).json({ error: 'Failed to fetch creator dashboard' });
  }
}

export async function getMyCreatorSubscriptionsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const data = await getMyCreatorSubscriptions(userId);
    res.json(data);
  } catch (error) {
    console.error('[Creator] getMyCreatorSubscriptionsHandler failed:', error);
    res.status(500).json({ error: 'Failed to fetch subscriptions' });
  }
}

export async function subscribeToCreatorHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const subscriberUserId = req.user?.userId;
    if (!subscriberUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const creatorUserId = req.params.userId;
    const url = await createCreatorCheckoutSession(subscriberUserId, creatorUserId);
    res.json({ url });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create checkout session';
    res.status(400).json({ error: message });
  }
}

export async function cancelCreatorSubscriptionHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const subscriberUserId = req.user?.userId;
    if (!subscriberUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const creatorUserId = req.params.userId;
    await cancelCreatorSubscription(subscriberUserId, creatorUserId);
    res.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to cancel subscription';
    res.status(400).json({ error: message });
  }
}

export async function connectOnboardingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const url = await createStripeConnectOnboardingLink(userId);
    res.json({ url });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create onboarding link';
    res.status(400).json({ error: message });
  }
}

export async function requestCreatorPayoutHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const result = await requestPayout(userId);
    res.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to request payout';
    res.status(400).json({ error: message });
  }
}

export async function getCreatorPayoutBalanceHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const balance = await getPayoutBalance(userId);
    res.json(balance);
  } catch (error) {
    console.error('[Creator] getCreatorPayoutBalanceHandler failed:', error);
    res.status(500).json({ error: 'Failed to fetch payout balance' });
  }
}

export async function getCreatorLedgerHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 25;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const typeRaw = typeof req.query.type === 'string' ? req.query.type : undefined;
    const allowedTypes = new Set(['earning', 'platform_fee', 'refund', 'payout']);
    if (typeRaw && !allowedTypes.has(typeRaw)) {
      res.status(400).json({ error: 'Invalid type filter' });
      return;
    }
    const fromRaw = typeof req.query.from === 'string' ? req.query.from : undefined;
    const toRaw = typeof req.query.to === 'string' ? req.query.to : undefined;
    const from = fromRaw ? new Date(fromRaw) : undefined;
    const to = toRaw ? new Date(toRaw) : undefined;
    if ((fromRaw && Number.isNaN(from?.getTime())) || (toRaw && Number.isNaN(to?.getTime()))) {
      res.status(400).json({ error: 'Invalid date range' });
      return;
    }

    const data = await getCreatorLedger(userId, {
      limit,
      cursor,
      type: typeRaw as 'earning' | 'platform_fee' | 'refund' | 'payout' | undefined,
      from,
      to,
    });
    res.json(data);
  } catch (error) {
    console.error('[Creator] getCreatorLedgerHandler failed:', error);
    res.status(500).json({ error: 'Failed to fetch creator ledger' });
  }
}

export async function reportCreatorHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const reporterUserId = req.user?.userId;
    if (!reporterUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    await reportCreator(reporterUserId, req.params.userId, parsed.data.reason, parsed.data.description);
    res.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to submit report';
    res.status(400).json({ error: message });
  }
}

export async function creatorStripeWebhookHandler(req: Request, res: Response): Promise<void> {
  try {
    const signature = req.headers['stripe-signature'];
    if (!signature || typeof signature !== 'string') {
      res.status(400).json({ error: 'Invalid webhook signature' });
      return;
    }
    if (!config.stripeConnectWebhookSecret) {
      res.status(500).json({ error: 'Webhook not configured' });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      res.status(500).json({ error: 'Webhook processing failed' });
      return;
    }
    const stripe = new Stripe(config.stripeSecretKey);
    const event = stripe.webhooks.constructEvent(req.body, signature, config.stripeConnectWebhookSecret);
    await handleCreatorWebhookEvent(event);
    res.json({ received: true });
  } catch (error) {
    console.error('[Creator] creatorStripeWebhookHandler failed:', error);
    if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
      res.status(400).json({ error: 'Invalid webhook signature' });
      return;
    }
    res.status(400).json({ error: 'Webhook processing failed' });
  }
}
