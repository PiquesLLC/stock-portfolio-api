import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { getAnalystEvents } from '../services/analyst.service';

describe('analyst service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prismaMock as any).analystEvent = {
      findMany: vi.fn().mockResolvedValue([]),
    };
    (prismaMock as any).userSettings = {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    };
  });

  it('projects analyst read state from analystLastReadAt', async () => {
    // User holds AAPL — required since the service filters events by held tickers.
    prismaMock.holding.findMany.mockResolvedValue([{ ticker: 'AAPL' }] as any);
    (prismaMock as any).analystEvent.findMany = vi.fn().mockResolvedValue([
      {
        id: 'newer',
        ticker: 'AAPL',
        eventType: 'target_change',
        message: 'newer',
        oldValue: null,
        newValue: null,
        changePct: 10,
        read: false,
        createdAt: new Date('2026-03-14T12:00:00.000Z'),
      },
      {
        id: 'older',
        ticker: 'AAPL',
        eventType: 'rating_change',
        message: 'older',
        oldValue: null,
        newValue: null,
        changePct: null,
        read: false,
        createdAt: new Date('2026-03-14T10:00:00.000Z'),
      },
    ]);
    (prismaMock as any).userSettings.findUnique = vi.fn().mockResolvedValue({
      analystLastReadAt: new Date('2026-03-14T11:00:00.000Z'),
    });

    const result = await getAnalystEvents(50, undefined, 'user-1');

    expect(result.map((event: any) => ({ id: event.id, read: event.read }))).toEqual([
      { id: 'newer', read: false },
      { id: 'older', read: true },
    ]);
    expect((prismaMock as any).userSettings.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: { analystLastReadAt: true },
    });
  });
});
