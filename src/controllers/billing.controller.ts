import { Request, Response } from 'express';
import Stripe from 'stripe';
import { AuthRequest } from '../types/auth';
import { config } from '../config';
import {
  createCheckoutSession,
  createCustomerPortalSession,
  getBillingStatus,
  handleWebhookEvent,
} from '../services/billing.service';
import { createCheckoutSchema } from '../validators/billing.validators';

export async function createCheckoutHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsed = createCheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const url = await createCheckoutSession(req.user!.userId, parsed.data.priceId);
    res.json({ url });
  } catch {
    console.error('[Billing] Checkout session creation failed');
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

export async function createPortalHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const url = await createCustomerPortalSession(req.user!.userId);
    res.json({ url });
  } catch {
    console.error('[Billing] Portal session creation failed');
    res.status(500).json({ error: 'Failed to create customer portal session' });
  }
}

export async function getBillingStatusHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const status = await getBillingStatus(req.user!.userId);
    res.json(status);
  } catch {
    console.error('[Billing] Billing status retrieval failed');
    res.status(500).json({ error: 'Failed to fetch billing status' });
  }
}

export async function billingWebhookHandler(req: Request, res: Response): Promise<void> {
  try {
    const signature = req.headers['stripe-signature'];
    if (!signature || typeof signature !== 'string') {
      res.status(400).json({ error: 'Invalid webhook signature' });
      return;
    }
    if (!config.stripeWebhookSecret) {
      res.status(500).json({ error: 'Webhook not configured' });
      return;
    }

    if (!Buffer.isBuffer(req.body)) {
      res.status(500).json({ error: 'Webhook processing failed' });
      return;
    }

    const stripe = new Stripe(config.stripeSecretKey);
    const event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
    await handleWebhookEvent(event);
    res.json({ received: true });
  } catch {
    console.error('[Billing] Webhook handling failed');
    res.status(400).json({ error: 'Webhook processing failed' });
  }
}
