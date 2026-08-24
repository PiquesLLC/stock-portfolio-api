import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import {
  applyAsCreator,
  getCreatorDashboard,
  getEntitlement,
  getLockedContent,
  resolveAccessLevel,
  selfActivateCreator,
  updateCreatorSettings,
} from '../services/creator.service';

function ensureCreatorMockShape(): void {
  const p = prismaMock as any;
  p.creator ??= {};
  p.creator.findUnique ??= vi.fn();
  p.creator.create ??= vi.fn();
  p.creator.update ??= vi.fn();

  p.creatorVisibility ??= {};
  p.creatorVisibility.update ??= vi.fn();

  p.creatorSubscription ??= {};
  p.creatorSubscription.findFirst ??= vi.fn();
  p.creatorSubscription.count ??= vi.fn();

  p.follow ??= {};
  p.follow.findUnique ??= vi.fn();

  p.holding ??= {};
  p.holding.findMany ??= vi.fn();

  p.watchlist ??= {};
  p.watchlist.findMany ??= vi.fn();

  p.transaction ??= {};
  p.transaction.findMany ??= vi.fn();

  p.$transaction ??= vi.fn((arg: unknown) => {
    if (typeof arg === 'function') return arg(p);
    if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
    return Promise.resolve(arg);
  });
}

describe('creator service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureCreatorMockShape();
    (prismaMock as any).$transaction = vi.fn((arg: unknown) => {
      if (typeof arg === 'function') return arg(prismaMock);
      if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
      return Promise.resolve(arg);
    });
    (prismaMock as any).creator.findUnique.mockResolvedValue(null);
    (prismaMock as any).creator.create.mockResolvedValue({ id: 'creator_1', status: 'pending' });
    (prismaMock as any).creator.update.mockResolvedValue({});
    (prismaMock as any).creatorVisibility.update.mockResolvedValue({});
    (prismaMock as any).creatorSubscription.findFirst.mockResolvedValue(null);
    (prismaMock as any).creatorSubscription.count.mockResolvedValue(0);
    (prismaMock as any).follow.findUnique.mockResolvedValue(null);
    (prismaMock as any).holding.findMany.mockResolvedValue([]);
    (prismaMock as any).watchlist.findMany.mockResolvedValue([]);
    (prismaMock as any).transaction.findMany.mockResolvedValue([]);
  });

  it('applyAsCreator creates pending creator profile + visibility defaults', async () => {
    const result = await applyAsCreator('user_1', '  Growth investor  ');

    expect(result).toEqual({ status: 'pending', creatorId: 'creator_1' });
    expect((prismaMock as any).creator.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user_1',
          status: 'pending',
          pitch: 'Growth investor',
          visibility: expect.objectContaining({
            create: expect.objectContaining({
              showHoldings: false,
              showTradeHistory: false,
              tradeDelayHours: 24,
            }),
          }),
        }),
      })
    );
  });

  it('resolveAccessLevel prioritizes paid over follower', async () => {
    (prismaMock as any).creatorSubscription.findFirst.mockResolvedValue({ id: 'sub_1' });
    (prismaMock as any).follow.findUnique.mockResolvedValue({ id: 'follow_1' });

    const level = await resolveAccessLevel('creator_1', 'viewer_1');
    expect(level).toBe('paid');
  });

  it('getEntitlement returns CTA and no unlocked sections for public/follower', async () => {
    (prismaMock as any).creator.findUnique.mockResolvedValue({
      id: 'creator_1',
      userId: 'creator_1',
      status: 'active',
      pricingCents: 1500,
      visibility: {
        showHoldings: true,
        showTradeHistory: true,
        showRationale: false,
        showSectors: true,
        showRiskMetrics: false,
        showWatchlists: false,
      },
    });
    (prismaMock as any).follow.findUnique.mockResolvedValue({ id: 'follow_1' });
    (prismaMock as any).creatorSubscription.findFirst.mockResolvedValue(null);
    (prismaMock as any).creatorSubscription.count.mockResolvedValue(4);

    const entitlement = await getEntitlement('creator_1', 'viewer_1');

    expect(entitlement.level).toBe('follower');
    expect(entitlement.accessibleSections).toEqual([]);
    expect(entitlement.cta).toEqual(
      expect.objectContaining({
        canSubscribe: true,
        requiresAuth: false,
        priceCents: 1500,
        subscriberCount: 4,
        unlocks: ['holdings', 'tradeHistory', 'sectors'],
      })
    );
  });

  it('getLockedContent denies non-paid viewers and returns FORBIDDEN code', async () => {
    (prismaMock as any).creator.findUnique.mockResolvedValue({
      id: 'creator_1',
      userId: 'creator_1',
      status: 'active',
      pricingCents: 500,
      visibility: {
        showHoldings: true,
        showTradeHistory: false,
        showRationale: false,
        showSectors: true,
        showRiskMetrics: false,
        showWatchlists: false,
        tradeDelayHours: 0,
        hideShareCount: true,
      },
    });

    await expect(getLockedContent('creator_1', 'viewer_1', 'holdings')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('updateCreatorSettings enforces trialDays=0 and updates visibility', async () => {
    (prismaMock as any).creator.findUnique.mockResolvedValue({ id: 'creator_1' });
    await updateCreatorSettings('creator_1', {
      pricingCents: 4900,
      showHoldings: false,
      tradeDelayHours: 48,
    });

    expect((prismaMock as any).creator.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pricingCents: 4900,
          trialDays: 0,
        }),
      })
    );
    expect((prismaMock as any).creatorVisibility.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          showHoldings: false,
          tradeDelayHours: 48,
        }),
      })
    );
  });

  it('updateCreatorSettings rejects suspended creators', async () => {
    (prismaMock as any).creator.findUnique.mockResolvedValue({ id: 'creator_1', status: 'suspended' });
    await expect(updateCreatorSettings('creator_1', { pricingCents: 1000 }))
      .rejects.toThrow('Account suspended');
  });

  describe('selfActivateCreator', () => {
    const fullCreator = {
      id: 'creator_1',
      userId: 'user_1',
      status: 'pending',
      pricingCents: 1500,
      stripeConnectOnboarded: true,
      visibility: {
        showHoldings: true,
        showTradeHistory: true,
        showRationale: false,
        showSectors: true,
        showRiskMetrics: false,
        showWatchlists: false,
      },
    };

    it('returns ok:true and is idempotent when already active', async () => {
      (prismaMock as any).creator.findUnique.mockResolvedValue({ ...fullCreator, status: 'active' });
      const result = await selfActivateCreator('user_1');
      expect(result).toEqual({ ok: true });
      expect((prismaMock as any).creator.update).not.toHaveBeenCalled();
    });

    it('blocks suspended creators from self-activating', async () => {
      (prismaMock as any).creator.findUnique.mockResolvedValue({ ...fullCreator, status: 'suspended' });
      const result = await selfActivateCreator('user_1');
      expect(result).toEqual({ ok: false, missing: ['account_suspended'] });
      expect((prismaMock as any).creator.update).not.toHaveBeenCalled();
    });

    it('activates when all checklist items are complete', async () => {
      (prismaMock as any).creator.findUnique.mockResolvedValue(fullCreator);
      (prismaMock as any).creator.update.mockResolvedValue({});
      const result = await selfActivateCreator('user_1');
      expect(result).toEqual({ ok: true });
      expect((prismaMock as any).creator.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user_1' },
          data: { status: 'active' },
        })
      );
    });

    it('rejects when checklist items are incomplete', async () => {
      (prismaMock as any).creator.findUnique.mockResolvedValue({
        ...fullCreator,
        pricingCents: 500, // default = not set
        stripeConnectOnboarded: false,
      });
      const result = await selfActivateCreator('user_1');
      expect(result.ok).toBe(false);
      expect(result.missing).toContain('set_price');
      expect(result.missing).toContain('connect_stripe');
      expect((prismaMock as any).creator.update).not.toHaveBeenCalled();
    });
  });
});

/** The dashboard repeats the same balance formula, so it repeats the same bug. */
describe('getCreatorDashboard — payoutBalanceCents subtracts a pending payout once', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    ensureCreatorMockShape();
  });

  it('does not re-subtract a pending payout the ledger has already debited', async () => {
    const p = prismaMock as any;
    p.creator.findUnique.mockResolvedValue({ id: 'c1', pricingCents: 500, status: 'active' });
    p.creatorSubscription.count.mockResolvedValue(0);

    const aged = new Date(Date.now() - 30 * DAY_MS); // outside the 14-day reserve
    p.creatorWalletLedger ??= {};
    // Two different reads hit this mock: the dashboard's earning/refund slice and
    // getPayoutBalanceFromLedger's full-ledger sum. Route on the where clause so
    // the payout debit reaches only the balance calculation, as in production.
    p.creatorWalletLedger.findMany = vi.fn(async ({ where }: any) => {
      const rows = [
        { type: 'earning', amountCents: 10000, createdAt: aged, description: null },
        { type: 'payout', amountCents: 4000, createdAt: aged, description: 'payout:payout_1' },
      ];
      return where?.type ? rows.filter((r) => r.type === 'earning' || r.type === 'refund') : rows;
    });
    p.creatorSubscriptionEvent ??= {};
    p.creatorSubscriptionEvent.findMany = vi.fn(async () => []);
    p.creatorPayout ??= {};
    p.creatorPayout.aggregate = vi.fn(async () => ({ _sum: { amountCents: 4000 } }));

    const dash = await getCreatorDashboard('creator_1');

    // 10000 earned − 4000 already debited = 6000, not 2000.
    expect(dash.payoutBalanceCents).toBe(6000);
  });
});
