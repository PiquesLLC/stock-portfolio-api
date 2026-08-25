import type { AppleEnvironment } from './apple-reconciliation-queue.service';

/**
 * Global rate limiter for the App Store Server API.
 *
 * Per the frozen design §4: coalescing collapses repeated work for ONE
 * subscription, but does nothing for a burst across many distinct subscribers —
 * a price change or a mass renewal is exactly that shape. So a separate,
 * app-wide limiter bounds total request rate.
 *
 * "App-wide" is the load-bearing word. The buckets live in module scope, so every
 * worker in the process shares one budget per environment. A limiter constructed
 * per worker would multiply the effective rate by the worker count and defeat the
 * purpose — which is why `getAppleRateLimiter` returns a shared instance rather
 * than exporting the class for callers to instantiate.
 *
 * Production and Sandbox have separate budgets and never borrow from each other.
 */

/** Requests per second. Sandbox is documented at 10% of Production. */
export const APPLE_RATE_LIMITS: Record<AppleEnvironment, number> = {
  Production: 50,
  Sandbox: 5,
};

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    readonly ratePerSecond: number,
    private readonly nowFn: () => number = Date.now,
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

  /** Take a token if one is available. Non-blocking; the caller decides to wait. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Milliseconds until a token should be available. 0 when one is ready now. */
  msUntilNextToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000);
  }

  /** Observability only. */
  availableTokens(): number {
    this.refill();
    return this.tokens;
  }
}

const buckets = new Map<AppleEnvironment, TokenBucket>();

/**
 * The shared per-environment limiter. Callers MUST go through this rather than
 * constructing a TokenBucket, or the app-wide budget stops being app-wide.
 */
export function getAppleRateLimiter(environment: AppleEnvironment, nowFn?: () => number): TokenBucket {
  let bucket = buckets.get(environment);
  if (!bucket) {
    bucket = new TokenBucket(APPLE_RATE_LIMITS[environment], nowFn);
    buckets.set(environment, bucket);
  }
  return bucket;
}

/** Test seam only — never called in production. */
export function __resetAppleRateLimitersForTests(): void {
  buckets.clear();
}
