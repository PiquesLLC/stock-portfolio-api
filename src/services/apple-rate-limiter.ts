import type { AppleEnvironment } from './apple-reconciliation-queue.service';

/**
 * Global rate limiter for the App Store Server API.
 *
 * Per the frozen design §4: coalescing collapses repeated work for ONE
 * subscription but does nothing for a burst across many distinct subscribers, so
 * a separate app-wide limiter bounds total request rate.
 *
 * "App-wide" is the load-bearing word. The buckets live in module scope and the
 * class is NOT exported, so a caller cannot construct an independent bucket: a
 * limiter per worker would multiply the effective rate by the worker count and
 * defeat the purpose. Production and Sandbox have separate budgets and never
 * borrow from each other.
 *
 * ── NOT SOLVED HERE, AND A HARD PRE-RELEASE REQUIREMENT ───────────────────
 * This limiter is PROCESS-WIDE, not distributed. Railway can run multiple
 * replicas, and each would hold its own budget — so N replicas issue up to N ×
 * the intended rate. Before APPLE_IAP_ENABLED can EVER be turned on, Apple worker
 * execution must be either a singleton (one replica runs it) or backed by a
 * distributed limiter. Recorded here so it cannot be discovered at enablement
 * time.
 */

/** Requests per second. Sandbox is documented at 10% of Production. */
export const APPLE_RATE_LIMITS: Record<AppleEnvironment, number> = {
  Production: 50,
  Sandbox: 5,
};

/** NOT exported — see the module comment. */
class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  /** Epoch ms until which the whole environment is held off by Apple's 429. */
  private cooldownUntilMs = 0;

  constructor(
    readonly ratePerSecond: number,
    private readonly nowFn: () => number,
  ) {
    this.tokens = ratePerSecond;
    this.lastRefillMs = nowFn();
  }

  private refill(): void {
    const now = this.nowFn();
    const elapsed = now - this.lastRefillMs;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.ratePerSecond, this.tokens + (elapsed / 1000) * this.ratePerSecond);
    this.lastRefillMs = now;
  }

  /**
   * Apple told us to back off. This holds off the ENTIRE environment, not just
   * the reconciliation row that happened to receive the 429 — parking one row
   * leaves every other worker free to keep hitting a limiter Apple has already
   * refused, which is what turns a rate limit into a sustained one.
   */
  applyCooldown(untilMs: number): void {
    if (untilMs > this.cooldownUntilMs) this.cooldownUntilMs = untilMs;
  }

  private inCooldown(): boolean {
    return this.nowFn() < this.cooldownUntilMs;
  }

  tryAcquire(): boolean {
    if (this.inCooldown()) return false;
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Milliseconds until a request should be permitted. 0 when ready now. */
  msUntilNextToken(): number {
    if (this.inCooldown()) return this.cooldownUntilMs - this.nowFn();
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000);
  }

  /** Observability only. */
  availableTokens(): number {
    if (this.inCooldown()) return 0;
    this.refill();
    return this.tokens;
  }
}

export type AppleRateLimiter = Pick<
  TokenBucket, 'tryAcquire' | 'msUntilNextToken' | 'availableTokens' | 'applyCooldown' | 'ratePerSecond'
>;

/** Clock seam. Production always uses Date.now; tests can advance it. */
let clock: () => number = () => Date.now();
const buckets = new Map<AppleEnvironment, TokenBucket>();

/**
 * The shared per-environment limiter. The only way to obtain one.
 */
export function getAppleRateLimiter(environment: AppleEnvironment): AppleRateLimiter {
  let bucket = buckets.get(environment);
  if (!bucket) {
    bucket = new TokenBucket(APPLE_RATE_LIMITS[environment], () => clock());
    buckets.set(environment, bucket);
  }
  return bucket;
}

/**
 * Hold off an entire environment until `untilMs`, in response to a 429.
 * Applies to the shared limiter, so every worker in the process is affected.
 */
export function applyAppleRateLimitCooldown(environment: AppleEnvironment, untilMs: number): void {
  getAppleRateLimiter(environment).applyCooldown(untilMs);
}

/* ── test-only seams ─────────────────────────────────────────────────── */

export function __resetAppleRateLimitersForTests(): void {
  buckets.clear();
  clock = () => Date.now();
}

/** Lets a test advance time deterministically instead of sleeping. */
export function __setAppleLimiterClockForTests(fn: () => number): void {
  clock = fn;
  buckets.clear();
}
