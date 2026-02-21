import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const {
  createCheckoutSessionMock,
  createCustomerPortalSessionMock,
  getBillingStatusMock,
  handleWebhookEventMock,
  constructEventMock,
} = vi.hoisted(() => ({
  createCheckoutSessionMock: vi.fn(),
  createCustomerPortalSessionMock: vi.fn(),
  getBillingStatusMock: vi.fn(),
  handleWebhookEventMock: vi.fn(),
  constructEventMock: vi.fn(),
}));

vi.mock('../middleware/rateLimiter', () => {
  const passthrough = (req: any, _res: any, next: any) => next();
  return {
    loginLimiter: passthrough,
    setPasswordLimiter: passthrough,
    signupLimiter: passthrough,
    mutationLimiter: passthrough,
    heavyReadLimiter: passthrough,
    apiLimiter: passthrough,
    enumerationLimiter: passthrough,
    mfaVerifyLimiter: passthrough,
    mfaSendLimiter: passthrough,
    oauthLimiter: passthrough,
    webhookLimiter: passthrough,
    billingMutationLimiter: passthrough,
    billingWebhookLimiter: passthrough,
  };
});

vi.mock('../middleware/auth.middleware', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (req.headers['x-test-auth'] !== '1') {
      res.status(401).json({ error: 'Authorization required' });
      return;
    }
    req.user = { userId: 'user_1', username: 'tester', plan: 'pro' };
    next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  requireOwnership: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../services/billing.service', () => ({
  createCheckoutSession: createCheckoutSessionMock,
  createCustomerPortalSession: createCustomerPortalSessionMock,
  getBillingStatus: getBillingStatusMock,
  handleWebhookEvent: handleWebhookEventMock,
}));

vi.mock('stripe', () => {
  class StripeMock {
    webhooks = {
      constructEvent: constructEventMock,
    };
    constructor(_apiKey: string) {}
  }
  return { default: StripeMock };
});

describe('billing routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_123';
    createCheckoutSessionMock.mockResolvedValue('https://checkout.stripe.test/session');
    createCustomerPortalSessionMock.mockResolvedValue('https://billing.stripe.test/portal');
    getBillingStatusMock.mockResolvedValue({
      plan: 'free',
      planStartedAt: null,
      planExpiresAt: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      isGracePeriod: false,
      graceEndsAt: null,
    });
    handleWebhookEventMock.mockResolvedValue(undefined);
    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: {} },
    });
  });

  it('POST /billing/checkout requires auth', async () => {
    const app = (await import('../app')).default;
    const res = await request(app).post('/billing/checkout').send({ priceId: 'price_pro' });
    expect(res.status).toBe(401);
  });

  it('POST /billing/checkout validates input', async () => {
    const app = (await import('../app')).default;
    const res = await request(app)
      .post('/billing/checkout')
      .set('x-test-auth', '1')
      .send({});

    expect(res.status).toBe(400);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('POST /billing/checkout returns checkout url', async () => {
    const app = (await import('../app')).default;
    const res = await request(app)
      .post('/billing/checkout')
      .set('x-test-auth', '1')
      .send({ priceId: 'price_pro' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.test/session');
    expect(createCheckoutSessionMock).toHaveBeenCalledWith('user_1', 'price_pro');
  });

  it('POST /billing/portal handles no-customer edge case', async () => {
    createCustomerPortalSessionMock.mockRejectedValueOnce(new Error('No billing account found'));
    const app = (await import('../app')).default;
    const res = await request(app)
      .post('/billing/portal')
      .set('x-test-auth', '1')
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to create customer portal session');
  });

  it('GET /billing/status requires auth', async () => {
    const app = (await import('../app')).default;
    const res = await request(app).get('/billing/status');
    expect(res.status).toBe(401);
  });

  it('POST /billing/webhook rejects missing signature', async () => {
    const app = (await import('../app')).default;
    const res = await request(app)
      .post('/billing/webhook')
      .set('Content-Type', 'application/json')
      .send('{"id":"evt_no_sig"}');

    expect(res.status).toBe(400);
    expect(handleWebhookEventMock).not.toHaveBeenCalled();
  });

  it('POST /billing/webhook verifies using raw buffer and forwards event', async () => {
    const app = (await import('../app')).default;
    const res = await request(app)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=abc')
      .set('Content-Type', 'application/json')
      .send('{"id":"evt_1","type":"checkout.session.completed","data":{"object":{}}}');

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(constructEventMock).toHaveBeenCalledTimes(1);
    const [rawBody] = constructEventMock.mock.calls[0];
    expect(Buffer.isBuffer(rawBody)).toBe(true);
    expect(handleWebhookEventMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt_1' }));
  });
});
