import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import {
  applyAsCreator,
  getEntitlement,
  getLockedContent,
  resolveAccessLevel,
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
              showHoldings: true,
              showTradeHistory: false,
              tradeDelayHours: 0,
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
});
