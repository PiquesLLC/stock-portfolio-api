import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { discoverCreators, updateCreatorSettings } from '../services/creator.service';

function ensureMockShape(): void {
  const p = prismaMock as any;
  p.user ??= {};
  p.user.findMany ??= vi.fn();
  p.user.count ??= vi.fn();
  p.creator ??= {};
  p.creator.findUnique ??= vi.fn();
  p.creator.update ??= vi.fn();
  p.creatorSubscription ??= {};
  p.creatorSubscription.groupBy ??= vi.fn();
  p.creatorVisibility ??= {};
  p.creatorVisibility.update ??= vi.fn();
  p.$transaction ??= vi.fn();
}

// Helper: build a fake User row as returned by prisma.user.findMany
function fakeUser(overrides: {
  id: string;
  username?: string;
  displayName?: string;
  createdAt?: Date;
  twrPct?: number | null;
  flagged?: boolean;
  // Creator data (null = not a creator)
  creatorPitch?: string | null;
  creatorPricingCents?: number;
  creatorStatus?: string;
  creatorCreatedAt?: Date;
  discoverable?: boolean;
  visibility?: {
    showHoldings: boolean;
    showTradeHistory: boolean;
    showRationale: boolean;
    showSectors: boolean;
    showRiskMetrics: boolean;
    showWatchlists: boolean;
  };
}) {
  const hasCreator = overrides.creatorStatus != null;
  return {
    id: overrides.id,
    username: overrides.username ?? overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    createdAt: overrides.createdAt ?? new Date('2026-01-15T00:00:00Z'),
    leaderboardCaches:
      overrides.twrPct != null
        ? [{ twrPct: overrides.twrPct, flagged: overrides.flagged ?? false }]
        : [],
    creator: hasCreator
      ? {
          status: overrides.creatorStatus,
          pitch: overrides.creatorPitch ?? null,
          pricingCents: overrides.creatorPricingCents ?? 500,
          createdAt: overrides.creatorCreatedAt ?? overrides.createdAt ?? new Date('2026-01-15T00:00:00Z'),
          visibility: {
            showHoldings: true,
            showTradeHistory: false,
            showRationale: false,
            showSectors: true,
            showRiskMetrics: false,
            showWatchlists: false,
            discoverable: overrides.discoverable ?? true,
            ...(overrides.visibility ?? {}),
          },
        }
      : null,
  };
}

describe('discoverCreators', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureMockShape();
    (prismaMock as any).user.count.mockResolvedValue(0);
    (prismaMock as any).user.findMany.mockResolvedValue([]);
    (prismaMock as any).creatorSubscription.groupBy.mockResolvedValue([]);
  });

  // ────────────────────────────────────────────────────
  // Core: shows all leaderboard-eligible users
  // ────────────────────────────────────────────────────
  it('returns both creators and non-creators', async () => {
    const users = [
      fakeUser({ id: 'creator1', twrPct: 10, creatorStatus: 'active', creatorPricingCents: 999 }),
      fakeUser({ id: 'regular1', twrPct: 15 }),  // not a creator
    ];

    (prismaMock as any).user.count.mockResolvedValue(2);
    (prismaMock as any).user.findMany.mockResolvedValue(users);

    const result = await discoverCreators({ sort: 'performance' });

    expect(result.creators).toHaveLength(2);
    // regular1 has higher return, should be first
    expect(result.creators[0].userId).toBe('regular1');
    expect(result.creators[0].isCreator).toBe(false);
    expect(result.creators[0].pricingCents).toBeNull();
    expect(result.creators[1].userId).toBe('creator1');
    expect(result.creators[1].isCreator).toBe(true);
    expect(result.creators[1].pricingCents).toBe(999);
  });

  it('queries User table with profilePublic + leaderboardEligible', async () => {
    (prismaMock as any).user.count.mockResolvedValue(0);
    (prismaMock as any).user.findMany.mockResolvedValue([]);

    await discoverCreators({});

    const call = (prismaMock as any).user.findMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      profilePublic: true,
      leaderboardEligible: true,
    });
  });

  // ────────────────────────────────────────────────────
  // Performance sort — returnPct DESC, nulls last
  // ────────────────────────────────────────────────────
  it('performance: sorts by returnPct DESC with nulls last', async () => {
    const users = [
      fakeUser({ id: 'perf1', twrPct: 15.5, creatorStatus: 'active' }),
      fakeUser({ id: 'perf2', twrPct: 3.2 }),
      fakeUser({ id: 'nodata', twrPct: null }),
    ];

    (prismaMock as any).user.count.mockResolvedValue(3);
    (prismaMock as any).user.findMany.mockResolvedValue(users);

    const page1 = await discoverCreators({ sort: 'performance', limit: 2 });

    expect(page1.creators).toHaveLength(2);
    expect(page1.creators[0].userId).toBe('perf1');
    expect(page1.creators[0].returnPct).toBe(15.5);
    expect(page1.creators[0].isVerified).toBe(true);
    expect(page1.creators[1].userId).toBe('perf2');
    expect(page1.nextCursor).toBeTruthy();

    // Page 2: null returnPct comes last
    const page2 = await discoverCreators({ sort: 'performance', limit: 2, cursor: page1.nextCursor! });

    expect(page2.creators).toHaveLength(1);
    expect(page2.creators[0].userId).toBe('nodata');
    expect(page2.creators[0].returnPct).toBeNull();
    expect(page2.creators[0].isVerified).toBe(false);
  });

  // ────────────────────────────────────────────────────
  // Popular sort — subscriberCount DESC
  // ────────────────────────────────────────────────────
  it('popular: sorts by subscriberCount DESC and paginates', async () => {
    const users = [
      fakeUser({ id: 'u1', creatorStatus: 'active' }),
      fakeUser({ id: 'u2', creatorStatus: 'active' }),
      fakeUser({ id: 'u3' }), // non-creator, 0 subs
    ];

    (prismaMock as any).user.count.mockResolvedValue(3);
    (prismaMock as any).user.findMany.mockResolvedValue(users);
    (prismaMock as any).creatorSubscription.groupBy.mockResolvedValue([
      { creatorUserId: 'u2', _count: 10 },
      { creatorUserId: 'u1', _count: 5 },
    ]);

    const page1 = await discoverCreators({ sort: 'popular', limit: 2 });

    expect(page1.creators).toHaveLength(2);
    expect(page1.creators[0].userId).toBe('u2');
    expect(page1.creators[0].subscriberCount).toBe(10);
    expect(page1.creators[1].userId).toBe('u1');
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await discoverCreators({ sort: 'popular', limit: 2, cursor: page1.nextCursor! });
    expect(page2.creators).toHaveLength(1);
    expect(page2.creators[0].userId).toBe('u3');
    expect(page2.creators[0].subscriberCount).toBe(0);
  });

  // ────────────────────────────────────────────────────
  // Newest sort
  // ────────────────────────────────────────────────────
  it('newest: sorts by createdAt DESC and paginates', async () => {
    const users = [
      fakeUser({ id: 'a', createdAt: new Date('2026-02-10T00:00:00Z') }),
      fakeUser({ id: 'b', createdAt: new Date('2026-02-05T00:00:00Z') }),
      fakeUser({ id: 'c', createdAt: new Date('2026-02-01T00:00:00Z') }),
    ];

    (prismaMock as any).user.count.mockResolvedValue(3);
    (prismaMock as any).user.findMany.mockResolvedValue(users);

    const page1 = await discoverCreators({ sort: 'newest', limit: 2 });

    expect(page1.creators).toHaveLength(2);
    expect(page1.creators[0].userId).toBe('a');
    expect(page1.creators[1].userId).toBe('b');
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await discoverCreators({ sort: 'newest', limit: 2, cursor: page1.nextCursor! });
    expect(page2.creators).toHaveLength(1);
    expect(page2.creators[0].userId).toBe('c');
  });

  // ────────────────────────────────────────────────────
  // Price sorts — creators first, non-creators last
  // ────────────────────────────────────────────────────
  it('price_low: sorts creators by price ASC, non-creators last', async () => {
    const users = [
      fakeUser({ id: 'cheap', creatorStatus: 'active', creatorPricingCents: 300 }),
      fakeUser({ id: 'exp', creatorStatus: 'active', creatorPricingCents: 1500 }),
      fakeUser({ id: 'nocreator' }),
    ];

    (prismaMock as any).user.count.mockResolvedValue(3);
    (prismaMock as any).user.findMany.mockResolvedValue(users);

    const result = await discoverCreators({ sort: 'price_low' });

    expect(result.creators[0].userId).toBe('cheap');
    expect(result.creators[1].userId).toBe('exp');
    expect(result.creators[2].userId).toBe('nocreator');
    expect(result.creators[2].pricingCents).toBeNull();
  });

  // ────────────────────────────────────────────────────
  // Discoverable opt-out
  // ────────────────────────────────────────────────────
  it('filters out creators with discoverable=false', async () => {
    const users = [
      fakeUser({ id: 'visible', twrPct: 10, creatorStatus: 'active', discoverable: true }),
      fakeUser({ id: 'hidden', twrPct: 20, creatorStatus: 'active', discoverable: false }),
      fakeUser({ id: 'regular', twrPct: 5 }), // non-creator, always visible
    ];

    (prismaMock as any).user.count.mockResolvedValue(3);
    (prismaMock as any).user.findMany.mockResolvedValue(users);

    const result = await discoverCreators({ sort: 'performance' });

    const ids = result.creators.map((c) => c.userId);
    expect(ids).toContain('visible');
    expect(ids).toContain('regular');
    expect(ids).not.toContain('hidden');
  });

  // ────────────────────────────────────────────────────
  // Edge cases
  // ────────────────────────────────────────────────────
  it('returns empty list with total=0 when no eligible users', async () => {
    (prismaMock as any).user.count.mockResolvedValue(0);
    (prismaMock as any).user.findMany.mockResolvedValue([]);

    const result = await discoverCreators({});

    expect(result.creators).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.nextCursor).toBeNull();
  });

  it('derives sectionsUnlocked from creator visibility toggles', async () => {
    const user = fakeUser({
      id: 'vis',
      creatorStatus: 'active',
      visibility: {
        showHoldings: true,
        showTradeHistory: true,
        showRationale: false,
        showSectors: false,
        showRiskMetrics: true,
        showWatchlists: false,
      },
    });

    (prismaMock as any).user.count.mockResolvedValue(1);
    (prismaMock as any).user.findMany.mockResolvedValue([user]);

    const result = await discoverCreators({ sort: 'performance' });

    expect(result.creators[0].sectionsUnlocked).toEqual(['holdings', 'tradeHistory', 'riskMetrics']);
  });

  it('non-creators have empty sectionsUnlocked', async () => {
    const user = fakeUser({ id: 'regular', twrPct: 5 });

    (prismaMock as any).user.count.mockResolvedValue(1);
    (prismaMock as any).user.findMany.mockResolvedValue([user]);

    const result = await discoverCreators({});

    expect(result.creators[0].sectionsUnlocked).toEqual([]);
    expect(result.creators[0].isCreator).toBe(false);
  });

  // ────────────────────────────────────────────────────
  // Pagination stability with mixed creator + non-creator
  // ────────────────────────────────────────────────────
  it('cursor pagination: no duplicates or gaps across pages with mixed users', async () => {
    // 5 users: mix of creators and non-creators with varied performance
    const users = [
      fakeUser({ id: 'c1', twrPct: 20, creatorStatus: 'active' }),
      fakeUser({ id: 'u1', twrPct: 18 }),
      fakeUser({ id: 'c2', twrPct: 15, creatorStatus: 'active' }),
      fakeUser({ id: 'u2', twrPct: 10 }),
      fakeUser({ id: 'u3', twrPct: 5 }),
    ];

    (prismaMock as any).user.count.mockResolvedValue(5);
    (prismaMock as any).user.findMany.mockResolvedValue(users);

    // Page 1: limit 2
    const page1 = await discoverCreators({ sort: 'performance', limit: 2 });
    expect(page1.creators.map(c => c.userId)).toEqual(['c1', 'u1']);
    expect(page1.nextCursor).toBeTruthy();

    // Page 2: same data returned (in-memory re-sort), cursor skips past u1
    const page2 = await discoverCreators({ sort: 'performance', limit: 2, cursor: page1.nextCursor! });
    expect(page2.creators.map(c => c.userId)).toEqual(['c2', 'u2']);
    expect(page2.nextCursor).toBeTruthy();

    // Page 3: last item
    const page3 = await discoverCreators({ sort: 'performance', limit: 2, cursor: page2.nextCursor! });
    expect(page3.creators.map(c => c.userId)).toEqual(['u3']);
    expect(page3.nextCursor).toBeNull();

    // Verify: no duplicates across all pages
    const allIds = [
      ...page1.creators.map(c => c.userId),
      ...page2.creators.map(c => c.userId),
      ...page3.creators.map(c => c.userId),
    ];
    expect(allIds).toEqual(['c1', 'u1', 'c2', 'u2', 'u3']);
    expect(new Set(allIds).size).toBe(5);
  });

  it('cursor pagination: stable under popular sort with mixed subscriber counts', async () => {
    const users = [
      fakeUser({ id: 'c1', creatorStatus: 'active' }),
      fakeUser({ id: 'c2', creatorStatus: 'active' }),
      fakeUser({ id: 'u1' }), // non-creator, 0 subs
      fakeUser({ id: 'u2' }), // non-creator, 0 subs
    ];

    (prismaMock as any).user.count.mockResolvedValue(4);
    (prismaMock as any).user.findMany.mockResolvedValue(users);
    (prismaMock as any).creatorSubscription.groupBy.mockResolvedValue([
      { creatorUserId: 'c1', _count: 10 },
      { creatorUserId: 'c2', _count: 3 },
    ]);

    const page1 = await discoverCreators({ sort: 'popular', limit: 2 });
    expect(page1.creators[0].userId).toBe('c1');
    expect(page1.creators[0].subscriberCount).toBe(10);
    expect(page1.creators[1].userId).toBe('c2');
    expect(page1.creators[1].subscriberCount).toBe(3);

    const page2 = await discoverCreators({ sort: 'popular', limit: 2, cursor: page1.nextCursor! });
    // u1 and u2 both have 0 subs, tie-broken by userId
    expect(page2.creators).toHaveLength(2);
    const p2Ids = page2.creators.map(c => c.userId);
    expect(p2Ids).not.toContain('c1');
    expect(p2Ids).not.toContain('c2');
  });

  // ────────────────────────────────────────────────────
  // Price filter semantics with null pricingCents
  // ────────────────────────────────────────────────────
  it('price_high: creators sorted DESC, all null-priced users pushed to end', async () => {
    const users = [
      fakeUser({ id: 'exp', creatorStatus: 'active', creatorPricingCents: 1500 }),
      fakeUser({ id: 'mid', creatorStatus: 'active', creatorPricingCents: 500 }),
      fakeUser({ id: 'r1' }), // null pricing
      fakeUser({ id: 'r2' }), // null pricing
    ];

    (prismaMock as any).user.count.mockResolvedValue(4);
    (prismaMock as any).user.findMany.mockResolvedValue(users);

    const result = await discoverCreators({ sort: 'price_high' });

    // Creators with pricing first (desc), then nulls
    expect(result.creators[0].userId).toBe('exp');
    expect(result.creators[0].pricingCents).toBe(1500);
    expect(result.creators[1].userId).toBe('mid');
    expect(result.creators[1].pricingCents).toBe(500);
    expect(result.creators[2].pricingCents).toBeNull();
    expect(result.creators[3].pricingCents).toBeNull();
  });

  it('price_low: null-priced users always after priced creators', async () => {
    // Edge: more non-creators than creators
    const users = [
      fakeUser({ id: 'c1', creatorStatus: 'active', creatorPricingCents: 999 }),
      fakeUser({ id: 'u1' }),
      fakeUser({ id: 'u2' }),
      fakeUser({ id: 'u3' }),
    ];

    (prismaMock as any).user.count.mockResolvedValue(4);
    (prismaMock as any).user.findMany.mockResolvedValue(users);

    const result = await discoverCreators({ sort: 'price_low' });

    expect(result.creators[0].userId).toBe('c1');
    expect(result.creators[0].pricingCents).toBe(999);
    // All non-creators at the end with null pricing
    result.creators.slice(1).forEach(c => {
      expect(c.pricingCents).toBeNull();
      expect(c.isCreator).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────
  // Discoverable state transitions
  // ────────────────────────────────────────────────────
  it('discoverable toggle: true → false → true state transitions', async () => {
    const p = prismaMock as any;

    p.creator.findUnique.mockResolvedValue({ id: 'c1', status: 'active' });
    p.$transaction.mockImplementation(() => Promise.resolve());

    // Toggle OFF
    await updateCreatorSettings('user1', { discoverable: false });
    expect(p.creatorVisibility.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { creatorId: 'c1' },
        data: expect.objectContaining({ discoverable: false }),
      })
    );

    vi.clearAllMocks();
    ensureMockShape();

    // Toggle ON
    p.creator.findUnique.mockResolvedValue({ id: 'c1', status: 'active' });
    p.$transaction.mockImplementation(() => Promise.resolve());

    await updateCreatorSettings('user1', { discoverable: true });
    expect(p.creatorVisibility.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { creatorId: 'c1' },
        data: expect.objectContaining({ discoverable: true }),
      })
    );
  });
});
