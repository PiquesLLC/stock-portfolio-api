import { Status } from '@apple/app-store-server-library';
import type { AppleEnvironment } from './apple-reconciliation-queue.service';

/**
 * App Store Server API transport — Get All Subscription Statuses.
 *
 * Implements docs/apple-authoritative-state-design-2026-08-24.md (FROZEN) §4:
 * Apple's current-state endpoint is the authority, not the notification payload.
 *
 * The transport is an INTERFACE so tests can drive every failure mode
 * adversarially. The real implementation fetches and verifies; the reconciler
 * consumes only the normalized shape below, so it never handles a JWS and this
 * module needs no Apple secrets to be unit-tested.
 *
 * SCOPE: nothing in production constructs AppleServerApiTransport yet.
 * APPLE_IAP_ENABLED remains false and no worker is started. The JWS verifier and
 * the ES256 token provider are injected rather than imported, so this file adds
 * no dependency on apple-iap.service and no credential handling.
 */

/** Apple's subscription status codes, from the library rather than hardcoded. */
export { Status as AppleStatus };

export interface DecodedTransaction {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  purchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  revocationReason?: number;
  appAccountToken?: string;
  environment?: string;
  signedDate?: number;
  type?: string;
}

export interface DecodedRenewal {
  /** Present in Apple's renewal payload; cross-checked against the transaction. */
  originalTransactionId?: string;
  autoRenewStatus?: number;
  autoRenewProductId?: string;
  gracePeriodExpiresDate?: number;
  isInBillingRetryPeriod?: boolean;
  signedDate?: number;
  environment?: string;
}

export interface AppleStatusEntry {
  /**
   * The identifier from the UNSIGNED response envelope.
   *
   * Deliberately kept separate from the verified value and never used as
   * identity. Apple signs the transaction; the envelope around it is not signed,
   * so treating the outer id as authoritative would let a malformed or tampered
   * response point us at the wrong subscription. It is retained only so the
   * reconciler can assert the two AGREE.
   */
  outerOriginalTransactionId?: string;
  status: number;
  /** Verified. This is the identity. */
  transaction: DecodedTransaction;
  /** Verified. */
  renewal: DecodedRenewal;
}

export interface AppleStatusGroup {
  subscriptionGroupIdentifier: string;
  lastTransactions: AppleStatusEntry[];
}

/** Normalized, already-verified response. The reconciler consumes only this. */
export interface AppleStatusResponse {
  environment: string;
  bundleId?: string;
  data: AppleStatusGroup[];
}

export interface AppleTransport {
  getAllSubscriptionStatuses(args: {
    environment: AppleEnvironment;
    originalTransactionId: string;
  }): Promise<AppleStatusResponse>;
}

/** Apple asked us to slow down. `retryAfterMs` is Apple's instruction if usable. */
export class AppleRateLimitError extends Error {
  constructor(readonly retryAfterMs?: number) {
    super(`apple rate limited${retryAfterMs != null ? ` (retry after ${retryAfterMs}ms)` : ''}`);
    this.name = 'AppleRateLimitError';
  }
}

/** 5xx, timeout, socket failure — retryable through the queue's backoff. */
export class AppleTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleTransientError';
  }
}

/**
 * The response could not be trusted: unverifiable, malformed, internally
 * inconsistent, or describing a different environment or subscription than the
 * one requested. NEVER projectable.
 */
export class AppleInvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleInvalidResponseError';
  }
}

/** Current StoreKit domains. */
export const APPLE_BASE_URL: Record<AppleEnvironment, string> = {
  Production: 'https://api.storekit.apple.com',
  Sandbox: 'https://api.storekit-sandbox.apple.com',
};

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Parse Retry-After.
 *
 * The App Store Server API sends a UNIX timestamp in MILLISECONDS — the moment
 * to retry AT, not a delay. That is the primary format, so the delay is
 * `retryAt - now`. Reading it as delta-seconds would turn a timestamp like
 * 1787620045000 into ~56,000 years.
 *
 * Generic HTTP forms are accepted secondarily (delta-seconds, HTTP-date) because
 * an intermediary may rewrite the header. Anything past, negative, malformed, or
 * beyond a day yields undefined so the caller applies a conservative fallback
 * rather than trusting a value it could not read.
 */
export function parseRetryAfterMs(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();

  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    // A value large enough to be a millisecond epoch is one: Apple's documented
    // format. The threshold is far above any plausible delta-seconds value.
    if (n > 1e12) {
      const delay = n - now;
      return delay > 0 && delay <= MAX_RETRY_AFTER_MS ? delay : undefined;
    }
    const ms = n * 1000; // secondary: generic delta-seconds
    return ms >= 0 && ms <= MAX_RETRY_AFTER_MS ? ms : undefined;
  }

  const date = Date.parse(trimmed); // secondary: HTTP-date
  if (Number.isNaN(date)) return undefined;
  const delay = date - now;
  return delay > 0 && delay <= MAX_RETRY_AFTER_MS ? delay : undefined;
}

export interface TransportDeps {
  /** Returns a signed ES256 bearer token. Injected — no credentials live here. */
  getAuthToken: (environment: AppleEnvironment) => Promise<string>;
  /** Verifies and decodes a JWS. Injected — no verifier is constructed here. */
  verifyTransaction: (jws: string) => Promise<DecodedTransaction>;
  verifyRenewal: (jws: string) => Promise<DecodedRenewal>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The real request path. Constructed by nothing in production yet. */
export class AppleServerApiTransport implements AppleTransport {
  constructor(private readonly deps: TransportDeps) {}

  async getAllSubscriptionStatuses(args: {
    environment: AppleEnvironment;
    originalTransactionId: string;
  }): Promise<AppleStatusResponse> {
    const { environment, originalTransactionId } = args;
    const url = `${APPLE_BASE_URL[environment]}/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`;
    const doFetch = this.deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? 15_000);

    let res: Response;
    try {
      const token = await this.deps.getAuthToken(environment);
      res = await doFetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      throw new AppleTransientError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      throw new AppleRateLimitError(parseRetryAfterMs(res.headers.get('retry-after')));
    }
    if (res.status >= 500) throw new AppleTransientError(`apple ${res.status}`);
    if (!res.ok) throw new AppleInvalidResponseError(`apple ${res.status}`);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new AppleInvalidResponseError('apple response was not json');
    }
    return this.normalize(body);
  }

  private async normalize(body: unknown): Promise<AppleStatusResponse> {
    const b = body as {
      environment?: unknown; bundleId?: unknown;
      data?: Array<{ subscriptionGroupIdentifier?: unknown; lastTransactions?: unknown[] }>;
    };
    if (typeof b?.environment !== 'string' || !Array.isArray(b?.data)) {
      throw new AppleInvalidResponseError('apple response missing environment or data');
    }
    const groups: AppleStatusGroup[] = [];
    for (const g of b.data) {
      const entries: AppleStatusEntry[] = [];
      for (const t of (g.lastTransactions ?? []) as Array<Record<string, unknown>>) {
        if (typeof t.signedTransactionInfo !== 'string' || typeof t.signedRenewalInfo !== 'string') {
          throw new AppleInvalidResponseError('apple status entry missing signed payloads');
        }
        entries.push({
          // Kept, never trusted — see AppleStatusEntry.
          outerOriginalTransactionId:
            typeof t.originalTransactionId === 'string' ? t.originalTransactionId : undefined,
          status: Number(t.status),
          transaction: await this.deps.verifyTransaction(t.signedTransactionInfo),
          renewal: await this.deps.verifyRenewal(t.signedRenewalInfo),
        });
      }
      groups.push({
        subscriptionGroupIdentifier: String(g.subscriptionGroupIdentifier ?? ''),
        lastTransactions: entries,
      });
    }
    return {
      environment: b.environment,
      bundleId: typeof b.bundleId === 'string' ? b.bundleId : undefined,
      data: groups,
    };
  }
}
