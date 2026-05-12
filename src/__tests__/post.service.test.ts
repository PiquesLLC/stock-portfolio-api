import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { getUserPosts } from '../services/post.service';

function ensureMockShape(): void {
  const p = prismaMock as any;
  p.post ??= {};
  p.post.findMany ??= vi.fn();
  p.creator ??= {};
  p.creator.findUnique ??= vi.fn();
  p.creatorSubscription ??= {};
  p.creatorSubscription.findFirst ??= vi.fn();
}

describe('post service creator access gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureMockShape();
    (prismaMock as any).creator.findUnique.mockResolvedValue({
      status: 'active',
      pricingCents: 1500,
    });
    (prismaMock as any).post.findMany.mockResolvedValue([
      {
        id: 'trade-post-1',
        userId: 'creator_1',
        attachmentType: 'trade',
        _count: { comments: 0, likes: 0 },
      },
      {
        id: 'thought-post-1',
        userId: 'creator_1',
        attachmentType: null,
        _count: { comments: 0, likes: 0 },
      },
    ]);
  });

  it('does not expose trade posts to past_due subscriptions with null currentPeriodEnd during the grace window', async () => {
    (prismaMock as any).creatorSubscription.findFirst.mockImplementation(async ({ where }: any) => {
      const nullPeriodClause = where?.OR?.find((clause: any) => clause?.currentPeriodEnd === null);
      if (nullPeriodClause && !nullPeriodClause.status) {
        return {
          id: 'sub_past_due_1',
          status: 'past_due',
          currentPeriodEnd: null,
        };
      }
      return null;
    });

    const posts = await getUserPosts('creator_1', 20, undefined, 'viewer_1');

    expect(posts.map((post: any) => post.id)).toEqual(['thought-post-1']);
  });
});
