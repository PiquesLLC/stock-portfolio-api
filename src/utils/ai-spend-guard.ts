import NodeCache from 'node-cache';
import { config } from '../config';

/**
 * Thrown when the platform-wide AI spend backstop (M6) blocks a call. Provider
 * wrappers throw this at their chokepoint; AI services already catch provider
 * errors and degrade gracefully, so a trip turns into "AI temporarily
 * unavailable" UX rather than a crash.
 */
export class AiBudgetExceededError extends Error {
  constructor(public reason: string) {
    super(`AI temporarily unavailable: ${reason}`);
    this.name = 'AiBudgetExceededError';
  }
}

const WINDOW_MS = 24 * 60 * 60 * 1000; // rolling 24h

// Memoize the aggregate so we don't add a DB read to every AI call. A short TTL
// keeps the breaker responsive; fire-and-forget usage logging already lags the
// true total by seconds, so a ~30s memo adds no meaningful blind spot.
const cache = new NodeCache({ stdTTL: 30, checkperiod: 60 });
const CACHE_KEY = 'ai-spend-window';

interface SpendWindow {
  costUsd: number;
  count: number;
}

async function readSpendWindow(): Promise<SpendWindow> {
  const cached = cache.get<SpendWindow>(CACHE_KEY);
  if (cached) return cached;

  // Dynamic import mirrors the logging path and avoids a static prisma cycle.
  const prisma = (await import('./prisma')).default;
  const since = new Date(Date.now() - WINDOW_MS);
  // Deep-research spend lands in DeepResearchJob (not ApiUsageLog) and is the
  // most expensive category ($2-5/run), so fold its completed-job cost into the
  // USD total — otherwise the dollar cap is blind to it. In-flight jobs carry
  // ~0 until completion (same lag as fire-and-forget logging); excluded
  // 'failed' to match the deep-research monthly-limit accounting.
  const [agg, drAgg] = await Promise.all([
    prisma.apiUsageLog.aggregate({
      _sum: { costUsdEstimate: true },
      _count: { _all: true },
      where: { createdAt: { gte: since } },
    }),
    prisma.deepResearchJob.aggregate({
      _sum: { costUsdEstimate: true },
      where: { createdAt: { gte: since }, status: { notIn: ['failed'] } },
    }),
  ]);
  const window: SpendWindow = {
    costUsd: (agg._sum?.costUsdEstimate ?? 0) + (drAgg._sum?.costUsdEstimate ?? 0),
    count: agg._count?._all ?? 0,
  };
  cache.set(CACHE_KEY, window);
  return window;
}

/**
 * Throw AiBudgetExceededError if AI is hard-disabled or the rolling-24h budget
 * is exhausted. Called at the provider chokepoints (callPerplexity / callGemini
 * / deep-research start) so EVERY paid LLM call — including scheduled jobs like
 * daily-report pre-gen, the biggest multiplier — is gated by one backstop.
 *
 * Failure policy: the hard kill switch is deterministic. The cost/count caps
 * fail OPEN on a DB read error (a transient DB hiccup must not take all AI
 * down — this is a backstop against sustained runaway spend, and the next
 * successful read within ~30s will trip it).
 */
export async function assertAiBudget(feature?: string): Promise<void> {
  if (config.aiHardDisabled) {
    throw new AiBudgetExceededError('AI is disabled (AI_DISABLED)');
  }
  if (!config.aiSpendBreakerEnabled) return;

  let window: SpendWindow;
  try {
    window = await readSpendWindow();
  } catch (err) {
    console.error('[AiSpendGuard] budget read failed, allowing call:', (err as Error).message);
    return; // fail open on read error
  }

  if (config.aiDailyCostCapUsd > 0 && window.costUsd >= config.aiDailyCostCapUsd) {
    console.error(
      `[AiSpendGuard] TRIPPED on cost: $${window.costUsd.toFixed(2)} >= cap $${config.aiDailyCostCapUsd} (feature=${feature || 'n/a'})`,
    );
    throw new AiBudgetExceededError('daily AI cost cap reached');
  }
  if (config.aiDailyCallCap > 0 && window.count >= config.aiDailyCallCap) {
    console.error(
      `[AiSpendGuard] TRIPPED on count: ${window.count} >= cap ${config.aiDailyCallCap} (feature=${feature || 'n/a'})`,
    );
    throw new AiBudgetExceededError('daily AI call cap reached');
  }
}

/** Test-only: clear the memoized window so each case reads fresh. */
export function __resetAiSpendCache(): void {
  cache.flushAll();
}
