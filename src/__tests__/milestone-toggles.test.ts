import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Thursday 2026-07-16 — a regular trading day. Only Date is faked so the
// service's real setTimeout throttles still resolve.
const NOW = new Date('2026-07-16T15:00:00-04:00');

const { prismaMock, fetchPricesMock, getPriorThresholdsMock, getRegularMarketCloseMock, sessionForTickerMock } = vi.hoisted(() => ({
  prismaMock: {
    holding: { findMany: vi.fn() },
    alert: { findMany: vi.fn() },
    milestoneEvent: { findFirst: vi.fn(), create: vi.fn() },
  },
  fetchPricesMock: vi.fn(),
  getPriorThresholdsMock: vi.fn(),
  getRegularMarketCloseMock: vi.fn(),
  sessionForTickerMock: vi.fn(),
}));

vi.mock('../utils/prisma', () => ({ default: prismaMock }));
vi.mock('../services/market.service', () => ({ fetchPrices: fetchPricesMock }));
vi.mock('../utils/milestone-ranges', () => ({
  getPriorThresholds: getPriorThresholdsMock,
  getRegularMarketClose: getRegularMarketCloseMock,
}));
vi.mock('../services/push.service', () => ({
  sendPushToUser: vi.fn().mockResolvedValue(undefined),
  sendNativePushToUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/market-hours', () => ({
  getMarketSession: vi.fn(() => 'POST'),
  getMarketSessionForTicker: sessionForTickerMock,
}));

import { checkMilestoneAlerts, checkMilestoneCloseAlerts } from '../services/milestone.service';

const createdEvents = () => prismaMock.milestoneEvent.create.mock.calls.map(c => c[0].data);

function setupHolders(ticker: string, userIds: string[]) {
  prismaMock.holding.findMany.mockResolvedValue(userIds.map(userId => ({ ticker, userId })));
  fetchPricesMock.mockResolvedValue({ quotes: new Map([[ticker, { currentPrice: 320 }]]) });
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  prismaMock.holding.findMany.mockReset();
  prismaMock.alert.findMany.mockReset().mockResolvedValue([]);
  prismaMock.milestoneEvent.findFirst.mockReset().mockResolvedValue(null);
  prismaMock.milestoneEvent.create.mockReset().mockResolvedValue({});
  fetchPricesMock.mockReset();
  getPriorThresholdsMock.mockReset();
  getRegularMarketCloseMock.mockReset();
  sessionForTickerMock.mockReset().mockReturnValue('REG');
});

describe('milestone Alert Settings toggles', () => {
  it('skips users who turned the toggle off; others fire (and a disabled ATH still allows their 52W alert)', async () => {
    // Price 320 beats both records; u1 has "All-Time High" switched OFF
    setupHolders('T1', ['u1', 'u2']);
    getPriorThresholdsMock.mockResolvedValue({ week52High: 300, week52Low: 100, allTimeHigh: 310, allTimeLow: 50 });
    prismaMock.alert.findMany.mockResolvedValue([{ userId: 'u1', type: 'ath' }]);

    await checkMilestoneAlerts();

    const events = createdEvents();
    // u2: ath fires, 52w_high suppressed by it. u1: ath silenced by toggle,
    // but their 52W switch is still on and the stock DID set a 52-week high.
    expect(events).toHaveLength(2);
    expect(events.find(e => e.userId === 'u2')).toMatchObject({ eventType: 'ath' });
    expect(events.find(e => e.userId === 'u1')).toMatchObject({ eventType: '52w_high' });
  });

  it('the same toggle silences the end-of-day close variant', async () => {
    setupHolders('T2', ['u1', 'u2']);
    sessionForTickerMock.mockReturnValue('POST'); // US stock after the bell
    getRegularMarketCloseMock.mockResolvedValue({ close: 320, closedOnEtDate: '2026-07-16' });
    getPriorThresholdsMock.mockResolvedValue({ week52High: 300, week52Low: 100, allTimeHigh: null, allTimeLow: null });
    prismaMock.alert.findMany.mockResolvedValue([{ userId: 'u1', type: '52w_high' }]);

    await checkMilestoneCloseAlerts();

    const events = createdEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userId: 'u2', eventType: '52w_high_close' });
  });

  it('never fires twice in one ET day (DB dedup) and ATH defers to an already-sent 52W when the records coincide', async () => {
    setupHolders('T3', ['u1']);
    // Records coincide: the 52-week high IS the all-time high
    getPriorThresholdsMock.mockResolvedValue({ week52High: 310, week52Low: 100, allTimeHigh: 310, allTimeLow: 50 });
    // A 52w_high event already exists today (sent while the ATH threshold was
    // unavailable during a transient weekly-fetch failure)
    prismaMock.milestoneEvent.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.eventType === '52w_high' ? { id: 'sent-earlier' } : null));

    await checkMilestoneAlerts();

    expect(prismaMock.milestoneEvent.create).not.toHaveBeenCalled();
  });

  it('skips non-regular sessions intraday (no pre/post-market records)', async () => {
    setupHolders('T4', ['u1']);
    sessionForTickerMock.mockReturnValue('POST');
    getPriorThresholdsMock.mockResolvedValue({ week52High: 300, week52Low: 100, allTimeHigh: 310, allTimeLow: 50 });

    await checkMilestoneAlerts();

    expect(prismaMock.milestoneEvent.create).not.toHaveBeenCalled();
    expect(getPriorThresholdsMock).not.toHaveBeenCalled();
  });
});
