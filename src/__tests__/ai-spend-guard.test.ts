import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { config } from '../config';
import { assertAiBudget, AiBudgetExceededError, __resetAiSpendCache } from '../utils/ai-spend-guard';

// ─────────────────────────────────────────────────────────────────────────────
// M6: platform-wide AI spend backstop. Trips on EITHER a rolling-24h USD cap or
// a call-count cap (the count catches providers whose per-call cost logs as ~$0,
// e.g. Gemini). Hard kill switch overrides. Fails OPEN on a DB read error.
// ─────────────────────────────────────────────────────────────────────────────

describe('AI spend guard (M6)', () => {
  const orig = {
    enabled: config.aiSpendBreakerEnabled,
    cost: config.aiDailyCostCapUsd,
    count: config.aiDailyCallCap,
    hard: config.aiHardDisabled,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetAiSpendCache();
    (config as any).aiSpendBreakerEnabled = true;
    (config as any).aiDailyCostCapUsd = 100;
    (config as any).aiDailyCallCap = 10000;
    (config as any).aiHardDisabled = false;
    prismaMock.apiUsageLog.aggregate.mockResolvedValue({ _sum: { costUsdEstimate: 0 }, _count: { _all: 0 } });
    prismaMock.deepResearchJob.aggregate.mockResolvedValue({ _sum: { costUsdEstimate: 0 } });
  });

  afterEach(() => {
    (config as any).aiSpendBreakerEnabled = orig.enabled;
    (config as any).aiDailyCostCapUsd = orig.cost;
    (config as any).aiDailyCallCap = orig.count;
    (config as any).aiHardDisabled = orig.hard;
  });

  it('allows a call when well under budget', async () => {
    await expect(assertAiBudget('ask')).resolves.toBeUndefined();
  });

  it('throws when the USD cap is reached', async () => {
    prismaMock.apiUsageLog.aggregate.mockResolvedValue({ _sum: { costUsdEstimate: 100 }, _count: { _all: 5 } });
    await expect(assertAiBudget('ask')).rejects.toBeInstanceOf(AiBudgetExceededError);
    await expect(assertAiBudget('ask')).rejects.toThrow(/cost cap/);
  });

  it('throws when the call-count cap is reached (catches $0-cost providers like Gemini)', async () => {
    prismaMock.apiUsageLog.aggregate.mockResolvedValue({ _sum: { costUsdEstimate: 0 }, _count: { _all: 10000 } });
    await expect(assertAiBudget('daily-report')).rejects.toThrow(/call cap/);
  });

  it('hard kill switch blocks even under budget, without touching the DB', async () => {
    (config as any).aiHardDisabled = true;
    await expect(assertAiBudget('ask')).rejects.toThrow(/disabled|AI_DISABLED/i);
    expect(prismaMock.apiUsageLog.aggregate).not.toHaveBeenCalled();
  });

  it('allows everything when the breaker is disabled, and does not query', async () => {
    (config as any).aiSpendBreakerEnabled = false;
    prismaMock.apiUsageLog.aggregate.mockResolvedValue({ _sum: { costUsdEstimate: 9999 }, _count: { _all: 999999 } });
    await expect(assertAiBudget('ask')).resolves.toBeUndefined();
    expect(prismaMock.apiUsageLog.aggregate).not.toHaveBeenCalled();
  });

  it('fails OPEN on a budget read error (a DB hiccup must not take all AI down)', async () => {
    prismaMock.apiUsageLog.aggregate.mockRejectedValue(new Error('db down'));
    await expect(assertAiBudget('ask')).resolves.toBeUndefined();
  });

  it('memoizes the window — repeated calls do not re-query within the TTL', async () => {
    await assertAiBudget('ask');
    await assertAiBudget('ask');
    await assertAiBudget('ask');
    expect(prismaMock.apiUsageLog.aggregate).toHaveBeenCalledTimes(1);
  });

  it('treats a null cost sum as an empty window', async () => {
    prismaMock.apiUsageLog.aggregate.mockResolvedValue({ _sum: { costUsdEstimate: null }, _count: { _all: 0 } });
    prismaMock.deepResearchJob.aggregate.mockResolvedValue({ _sum: { costUsdEstimate: null } });
    await expect(assertAiBudget('ask')).resolves.toBeUndefined();
  });

  it('counts deep-research job cost toward the USD cap (its biggest spend category)', async () => {
    // Neither source alone trips ($60 logged + $50 deep-research), but combined
    // ($110) exceeds the $100 cap — proving deep-research spend is visible.
    prismaMock.apiUsageLog.aggregate.mockResolvedValue({ _sum: { costUsdEstimate: 60 }, _count: { _all: 5 } });
    prismaMock.deepResearchJob.aggregate.mockResolvedValue({ _sum: { costUsdEstimate: 50 } });
    await expect(assertAiBudget('deep-research')).rejects.toThrow(/cost cap/);
  });

  it('aggregates over a rolling 24h window (createdAt lower bound)', async () => {
    await assertAiBudget('ask');
    const arg = prismaMock.apiUsageLog.aggregate.mock.calls[0][0];
    expect(arg.where.createdAt.gte).toBeInstanceOf(Date);
    const ageMs = Date.now() - arg.where.createdAt.gte.getTime();
    expect(ageMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ageMs).toBeLessThan(25 * 60 * 60 * 1000);
  });
});
