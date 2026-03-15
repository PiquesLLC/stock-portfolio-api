import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({
  waitlistAdminUserIds: ['waitlist-admin'],
  creatorAdminUserIds: ['creator-admin'],
}));

vi.mock('../config', () => ({
  config: configMock,
}));

import { __mockPrisma as prismaMock } from '../utils/prisma';
import { getDashboard } from '../services/analytics.service';

describe('analytics service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prismaMock as any).$queryRawUnsafe = vi.fn()
      .mockResolvedValueOnce([{ totalEvents: 10, uniqueUsers: 2, uniqueSessions: 3 }])
      .mockResolvedValueOnce([{ avgDuration: 1200 }])
      .mockResolvedValueOnce([{ feature: 'portfolio', views: 10, uniqueUsers: 2, totalDurationMs: 12000, avgDurationMs: 1200 }])
      .mockResolvedValueOnce([{ count: 2 }])
      .mockResolvedValueOnce([{ date: '2026-03-14', count: 2 }]);

    (prismaMock as any).user = { count: vi.fn().mockResolvedValue(5) };
    (prismaMock as any).portfolio = { count: vi.fn().mockResolvedValue(4) };
    (prismaMock as any).holding = { count: vi.fn().mockResolvedValue(12) };
    (prismaMock as any).watchlist = { count: vi.fn().mockResolvedValue(3) };
  });

  it('excludes waitlist admins, creator admins, and system admin from event queries', async () => {
    await getDashboard('7d');

    const calls = (prismaMock as any).$queryRawUnsafe.mock.calls;
    expect(calls.length).toBeGreaterThan(0);

    for (const [, ...params] of calls) {
      expect(params).toContain('waitlist-admin');
      expect(params).toContain('creator-admin');
      expect(params).toContain('237198da-612e-411c-9ef8-f267c887a9f1');
    }
  });
});
