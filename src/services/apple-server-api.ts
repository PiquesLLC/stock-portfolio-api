import type { AppleEnvironment } from './apple-reconciliation-queue.service';

/**
 * App Store Server API transport — Get All Subscription Statuses.
 *
 * Implements docs/apple-authoritative-state-design-2026-08-24.md (FROZEN) §4:
 * Apple's current-state endpoint is the authority, not the notification payload.
 *
 * The transport is an INTERFACE so tests can drive every failure mode
 * adversarially. The real implementation fetches and verifies; the reconciler
 * consumes only the normalized shape below, so it never handles a JWS itself and
 * this module needs no Apple secrets to be unit-tested.
 *
 * NOTE ON SCOPE: nothing in production constructs AppleServerApiTransport yet.
 * APPLE_IAP_ENABLED remains false and no worker is started. The JWS verifier and
 * the ES256 token provider are injected rather than imported, so this file adds
 * no dependency on apple-iap.service and no credential handling.
 */

/** Apple's subscription status codes. Read from the library enum at the edge. */
export const APPLE_STATUS = {
  ACTIVE: 1,
  EXPIRED: 2,
  BILLING_RETRY: 3,
  GRACE: 4,
  REVOKED: 5,
} as const;

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
  autoRenewStatus?: number;
  autoRenewProductId?: string;
  gracePeriodExpiresDate?: number;
  isInBillingRetryPeriod?: boolean;
  signedDate?: number;
  environment?: string;
}

export interface AppleStatusEntry {
  originalTransactionId: string;
  status: number;
  transaction: DecodedTransaction;
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
 * The response could not be trusted: unverifiable, malformed, or describing a
 * different environment than the one we asked about. NEVER projectable.
 */
export class AppleInvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleInvalidResponseError';
  }
}

export const APPLE_BASE_URL: Record<AppleEnvironment, string> = {
  Production: 'https://api.storekit.itunes.apple.com',
  Sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
};

/**
 * Parse Retry-After. Apple may send delta-seconds or an HTTP-date; anything else
 * (absent, malformed, negative, absurd) yields undefined so the caller applies a
 * conservative fallback rather than trusting a value it could not read.
 */
export function parseRetryAfterMs(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return ms >= 0 && ms <= 24 * 60 * 60 * 1000 ? ms : undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const ms = date - now;
  return ms > 0 && ms <= 24 * 60 * 60 * 1000 ? ms : undefined;
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

/**
 * The real request path. Constructed by nothing in production yet.
 */
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
      // Abort, DNS, socket — all retryable, none authoritative.
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
        const transaction = await this.deps.verifyTransaction(t.signedTransactionInfo);
        const renewal = await this.deps.verifyRenewal(t.signedRenewalInfo);
        entries.push({
          originalTransactionId: String(t.originalTransactionId ?? transaction.originalTransactionId),
          status: Number(t.status),
          transaction,
          renewal,
        });
      }
      groups.push({
        subscriptionGroupIdentifier: String(g.subscriptionGroupIdentifier ?? ''),
        lastTransactions: entries,
      });
    }
    return { environment: b.environment, bundleId: typeof b.bundleId === 'string' ? b.bundleId : undefined, data: groups };
  }
}
