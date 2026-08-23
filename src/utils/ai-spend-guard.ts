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

// M-11 — close the check-then-act race.
//
// The breaker read a 30s-memoized total and cost logging is fire-and-forget
// AFTER the call returns. So every request arriving inside one memo window saw
// the SAME stale total: at the cap boundary, N concurrent callers all read
// "under cap" and all proceeded. The overshoot is unbounded in principle and
// bounded in practice only by how many requests fit in 30 seconds.
//
// Fix: charge calls we have already waved through against the cap optimistically
// until their real cost lands in the aggregate.
//
// Admissions are held as TIMESTAMPS, not a counter, and discharged only once
// they are old enough to be reflected in the logged total. A plain counter
// zeroed on each refresh was wrong twice over: provider calls run 30-60s
// (perplexity's default timeout is 45s) and cost logging is fire-and-forget
// AFTER the call returns, so a 30s memo window discharges an admission while it
// is still in flight and in neither bucket; and two concurrent refreshes would
// each zero the other's admissions.
//
// PENDING_COST_USD is a deliberately conservative per-call estimate —
// over-estimating trips the breaker slightly early, the safe direction here.
const PENDING_COST_USD = 0.02;
const PENDING_SETTLE_MS = 90 * 1000; // > slowest provider timeout + logging lag
let pendingAdmissions: number[] = [];

/** Drop admissions old enough that their cost is now in the aggregate. */
function livePendingCount(nowMs: number): number {
  if (pendingAdmissions.length > 0) {
    pendingAdmissions = pendingAdmissions.filter((t) => nowMs - t < PENDING_SETTLE_MS);
  }
  return pendingAdmissions.length;
}

// Per-user hourly ceiling. The global cap protects the platform; it does nothing
// to stop ONE account burning the whole daily budget. express-rate-limit already
// caps bursts at 10/min/user, which still allows ~600/hour from a single user.
const USER_HOUR_MS = 60 * 60 * 1000;
const userCallCache = new NodeCache({ stdTTL: USER_HOUR_MS / 1000, checkperiod: 300 });

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
export async function assertAiBudget(feature?: string, userId?: string): Promise<void> {
  if (config.aiHardDisabled) {
    throw new AiBudgetExceededError('AI is disabled (AI_DISABLED)');
  }
  if (!config.aiSpendBreakerEnabled) return;

  // M-11: per-user hourly ceiling, checked BEFORE the global read so one abusive
  // account is stopped without a DB round-trip. In-memory and per-instance: it
  // resets on deploy and does not span replicas, which is an acceptable
  // trade for a backstop that costs nothing on the hot path. The durable
  // per-user accounting lives in ApiUsageLog if this ever needs to be exact.
  // Spend the user's quota HERE, at check time, not after the await below.
  //
  // Deferring it until after the global check looked tidier (don't charge for a
  // call the platform breaker rejects) but was wrong twice: the check and the
  // increment would straddle `await readSpendWindow()`, so on a cache miss every
  // concurrent request from one user reads the same `used` and all pass; and the
  // fail-open path returns early, admitting the call while never advancing the
  // counter — so during a database outage, when the global cap has ALSO failed
  // open, a single account could burn unlimited spend with no backstop at all.
  // The rejection paths below refund it instead.
  const userKey = userId && config.aiUserHourlyCallCap > 0 ? `u:${userId}` : null;
  if (userKey) {
    const used = userCallCache.get<number>(userKey) ?? 0;
    if (used >= config.aiUserHourlyCallCap) {
      console.error(
        `[AiSpendGuard] TRIPPED per-user: ${used} >= cap ${config.aiUserHourlyCallCap} (user=${userId}, feature=${feature || 'n/a'})`,
      );
      throw new AiBudgetExceededError('hourly AI limit reached for this account');
    }
    adjustUserQuota(userKey, 1);
  }

  let window: SpendWindow;
  try {
    window = await readSpendWindow();
  } catch (err) {
    // Fail open on a read error — but the call IS admitted, so the quota spent
    // above correctly stands. This is the only backstop left during an outage.
    console.error('[AiSpendGuard] budget read failed, allowing call:', (err as Error).message);
    return;
  }

  // Charge still-in-flight admissions against the cap, so a burst of concurrent
  // requests cannot all pass on the same stale total.
  const pending = livePendingCount(Date.now());
  const effectiveCostUsd = window.costUsd + pending * PENDING_COST_USD;
  const effectiveCount = window.count + pending;

  if (config.aiDailyCostCapUsd > 0 && effectiveCostUsd >= config.aiDailyCostCapUsd) {
    console.error(
      `[AiSpendGuard] TRIPPED on cost: $${effectiveCostUsd.toFixed(2)} (logged $${window.costUsd.toFixed(2)} + ${pending} in-flight) >= cap $${config.aiDailyCostCapUsd} (feature=${feature || 'n/a'})`,
    );
    if (userKey) adjustUserQuota(userKey, -1); // the call is rejected — don't charge it
    throw new AiBudgetExceededError('daily AI cost cap reached');
  }
  if (config.aiDailyCallCap > 0 && effectiveCount >= config.aiDailyCallCap) {
    console.error(
      `[AiSpendGuard] TRIPPED on count: ${effectiveCount} (logged ${window.count} + ${pending} in-flight) >= cap ${config.aiDailyCallCap} (feature=${feature || 'n/a'})`,
    );
    if (userKey) adjustUserQuota(userKey, -1);
    throw new AiBudgetExceededError('daily AI call cap reached');
  }

  // Admitted.
  pendingAdmissions.push(Date.now());
}

/**
 * Add `delta` to a user's hourly counter, preserving the ORIGINAL expiry.
 *
 * A bare `set()` restarts node-cache's stdTTL, which would turn the fixed hour
 * into a sliding one that a steady caller could keep alive forever.
 */
function adjustUserQuota(userKey: string, delta: number): void {
  const used = userCallCache.get<number>(userKey) ?? 0;
  const next = Math.max(0, used + delta);

  if (next === 0) {
    // Drop the key rather than storing a zero. A stored 0 would be read as
    // "first call of the window" by the next spend, which then re-sets with
    // stdTTL and restarts the hour.
    userCallCache.del(userKey);
    return;
  }

  if (used === 0) {
    userCallCache.set(userKey, next); // first call — stdTTL starts the hour
    return;
  }

  const expiresAtMs = userCallCache.getTtl(userKey);
  const remainingSec = expiresAtMs
    ? Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000))
    : USER_HOUR_MS / 1000;
  userCallCache.set(userKey, next, remainingSec);
}

/** Test-only: clear the memoized window so each case reads fresh. */
export function __resetAiSpendCache(): void {
  cache.flushAll();
  userCallCache.flushAll();
  pendingAdmissions = [];
}
