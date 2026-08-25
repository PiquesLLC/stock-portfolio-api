import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { Status } from '@apple/app-store-server-library';
import fs from 'fs';
import path from 'path';
import {
  AppleServerApiTransport,
  AppleRateLimitError,
  AppleTransientError,
  AppleInvalidResponseError,
  APPLE_BASE_URL,
  type DecodedTransaction,
  type DecodedRenewal,
} from '../services/apple-server-api';
import { reconcileOnce } from '../services/apple-reconciler.service';
import {
  __TEST_ONLY_ENQUEUE_SQL,
  type QueueClient,
} from '../services/apple-reconciliation-queue.service';
import { __resetAppleRateLimitersForTests } from '../services/apple-rate-limiter';

/**
 * The CONCRETE transport, exercised end to end.
 *
 * The reconciler suite injects an AppleTransport, which proves everything from
 * a normalized response onward but leaves the most production-specific class in
 * this PR untraversed. This file closes that: real fetch path, real header
 * construction, real status handling, real normalization — with fetch, the auth
 * token provider and both JWS verifiers injected, so no Apple credentials and no
 * network are involved.
 */

const OTI = '2000000123456789';
const PRODUCT = 'nala_pro_monthly';

function response(init: {
  status?: number; body?: unknown; headers?: Record<string, string>; notJson?: boolean;
}): Response {
  const headers = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: init.status ?? 200,
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    json: async () => {
      if (init.notJson) throw new Error('invalid json');
      return init.body;
    },
  } as unknown as Response;
}

/** A body in Apple's wire shape: signed payloads as opaque strings. */
function wireBody(over: Partial<{
  environment: string; outerOti: string | undefined; group: string;
  txJws: string; renewalJws: string; omitSigned: boolean;
}> = {}) {
  const txn: Record<string, unknown> = {
    originalTransactionId: 'outerOti' in over ? over.outerOti : OTI,
    status: Status.ACTIVE,
  };
  if (!over.omitSigned) {
    txn.signedTransactionInfo = over.txJws ?? 'JWS.transaction';
    txn.signedRenewalInfo = over.renewalJws ?? 'JWS.renewal';
  }
  return {
    environment: over.environment ?? 'Production',
    bundleId: 'com.nala.app',
    data: [{ subscriptionGroupIdentifier: over.group ?? 'group-1', lastTransactions: [txn] }],
  };
}

const verifiedTransaction = (over: Partial<DecodedTransaction> = {}): DecodedTransaction => ({
  transactionId: 'txn-1',
  originalTransactionId: OTI,
  productId: PRODUCT,
  subscriptionGroupIdentifier: 'group-1',
  expiresDate: Date.now() + 30 * 86_400_000,
  ...over,
});
const verifiedRenewal = (over: Partial<DecodedRenewal> = {}): DecodedRenewal => ({
  originalTransactionId: OTI,
  autoRenewStatus: 1,
  autoRenewProductId: PRODUCT,
  ...over,
});

function makeTransport(over: {
  fetchImpl?: typeof fetch;
  verifyTransaction?: (jws: string) => Promise<DecodedTransaction>;
  verifyRenewal?: (jws: string) => Promise<DecodedRenewal>;
  getAuthToken?: (env: 'Production' | 'Sandbox') => Promise<string>;
} = {}) {
  const calls = { urls: [] as string[], headers: [] as Record<string, string>[], txJws: [] as string[], renewalJws: [] as string[] };
  const inner = over.fetchImpl ?? ((async () => response({ body: wireBody() })) as unknown as typeof fetch);
  // Recording wraps ANY fetch, including overrides, so every test can assert on
  // the URL and headers the transport actually built.
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.urls.push(String(url));
    calls.headers.push((init?.headers ?? {}) as Record<string, string>);
    return inner(url as never, init as never);
  }) as unknown as typeof fetch;

  const transport = new AppleServerApiTransport({
    getAuthToken: over.getAuthToken ?? (async () => 'signed.es256.token'),
    verifyTransaction: over.verifyTransaction ?? (async (jws) => { calls.txJws.push(jws); return verifiedTransaction(); }),
    verifyRenewal: over.verifyRenewal ?? (async (jws) => { calls.renewalJws.push(jws); return verifiedRenewal(); }),
    fetchImpl,
  });
  return { transport, calls };
}

describe('AppleServerApiTransport (concrete path, injected fetch and verifiers)', () => {
  beforeEach(() => __resetAppleRateLimitersForTests());
  afterEach(() => __resetAppleRateLimitersForTests());

  it('calls the exact Production StoreKit URL', async () => {
    const { transport, calls } = makeTransport();
    await transport.getAllSubscriptionStatuses({ environment: 'Production', originalTransactionId: OTI });
    expect(calls.urls[0]).toBe(`${APPLE_BASE_URL.Production}/inApps/v1/subscriptions/${OTI}`);
    expect(calls.urls[0]).toContain('api.storekit.apple.com');
  });

  it('calls the Sandbox URL for a Sandbox request and never the Production host', async () => {
    const { transport, calls } = makeTransport({
      fetchImpl: (async () => response({ body: wireBody({ environment: 'Sandbox' }) })) as unknown as typeof fetch,
    });
    await transport.getAllSubscriptionStatuses({ environment: 'Sandbox', originalTransactionId: OTI });
    expect(calls.urls[0]).toBe(`${APPLE_BASE_URL.Sandbox}/inApps/v1/subscriptions/${OTI}`);
    expect(calls.urls[0]).toContain('api.storekit-sandbox.apple.com');
    expect(calls.urls[0]).not.toContain('//api.storekit.apple.com');
  });

  it('attaches the bearer token from the injected provider', async () => {
    const { transport, calls } = makeTransport({ getAuthToken: async () => 'my.signed.jwt' });
    await transport.getAllSubscriptionStatuses({ environment: 'Production', originalTransactionId: OTI });
    expect(calls.headers[0].Authorization).toBe('Bearer my.signed.jwt');
    expect(calls.headers[0].Accept).toBe('application/json');
  });

  it('invokes BOTH verifiers with the signed payloads from the body', async () => {
    const { transport, calls } = makeTransport();
    await transport.getAllSubscriptionStatuses({ environment: 'Production', originalTransactionId: OTI });
    expect(calls.txJws).toEqual(['JWS.transaction']);
    expect(calls.renewalJws).toEqual(['JWS.renewal']);
  });

  it('keeps the outer id SEPARATE from the verified id through normalization', async () => {
    const { transport } = makeTransport({
      fetchImpl: (async () => response({ body: wireBody({ outerOti: 'ENVELOPE-CLAIM' }) })) as unknown as typeof fetch,
      verifyTransaction: async () => verifiedTransaction({ originalTransactionId: 'VERIFIED-ID' }),
    });
    const out = await transport.getAllSubscriptionStatuses({ environment: 'Production', originalTransactionId: OTI });
    const e = out.data[0].lastTransactions[0];
    // Normalization must not collapse them; the reconciler decides what to do.
    expect(e.outerOriginalTransactionId).toBe('ENVELOPE-CLAIM');
    expect(e.transaction.originalTransactionId).toBe('VERIFIED-ID');
  });

  it('429 with an Apple MILLISECOND timestamp yields the right delay', async () => {
    const retryAt = Date.now() + 45_000;
    const { transport } = makeTransport({
      fetchImpl: (async () => response({ status: 429, headers: { 'retry-after': String(retryAt) } })) as unknown as typeof fetch,
    });
    const err = await transport.getAllSubscriptionStatuses({ environment: 'Production', originalTransactionId: OTI })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppleRateLimitError);
    expect((err as AppleRateLimitError).retryAfterMs!).toBeGreaterThan(40_000);
    expect((err as AppleRateLimitError).retryAfterMs!).toBeLessThanOrEqual(45_000);
  });

  it('429 with no usable header yields no instruction, not a wrong one', async () => {
    const { transport } = makeTransport({
      fetchImpl: (async () => response({ status: 429 })) as unknown as typeof fetch,
    });
    const err = await transport.getAllSubscriptionStatuses({ environment: 'Production', originalTransactionId: OTI })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppleRateLimitError);
    expect((err as AppleRateLimitError).retryAfterMs).toBeUndefined();
  });

  it('maps 5xx to transient, other non-2xx to invalid, and network errors to transient', async () => {
    const cases: Array<[() => Promise<Response>, unknown]> = [
      [async () => response({ status: 503 }), AppleTransientError],
      [async () => response({ status: 400 }), AppleInvalidResponseError],
      [async () => { throw new Error('socket hang up'); }, AppleTransientError],
      [async () => response({ status: 200, notJson: true }), AppleInvalidResponseError],
    ];
    for (const [impl, expected] of cases) {
      const { transport } = makeTransport({ fetchImpl: impl as unknown as typeof fetch });
      const err = await transport.getAllSubscriptionStatuses({ environment: 'Production', originalTransactionId: OTI })
        .catch((e) => e);
      expect(err).toBeInstanceOf(expected as never);
    }
  });

  it('rejects a body missing its signed payloads rather than normalizing it', async () => {
    const { transport } = makeTransport({
      fetchImpl: (async () => response({ body: wireBody({ omitSigned: true }) })) as unknown as typeof fetch,
    });
    await expect(transport.getAllSubscriptionStatuses({ environment: 'Production', originalTransactionId: OTI }))
      .rejects.toBeInstanceOf(AppleInvalidResponseError);
  });

  it('rejects a body with no environment or data', async () => {
    const { transport } = makeTransport({
      fetchImpl: (async () => response({ body: { nope: true } })) as unknown as typeof fetch,
    });
    await expect(transport.getAllSubscriptionStatuses({ environment: 'Production', originalTransactionId: OTI }))
      .rejects.toBeInstanceOf(AppleInvalidResponseError);
  });

  it('a VERIFIER failure never produces a normalized response', async () => {
    const { transport } = makeTransport({
      verifyTransaction: async () => { throw new Error('jws signature invalid'); },
    });
    await expect(transport.getAllSubscriptionStatuses({ environment: 'Production', originalTransactionId: OTI }))
      .rejects.toThrow(/jws signature invalid/);
  });
});

describe('AppleServerApiTransport wired into the reconciler (full seam)', () => {
  let db: Client;
  const MIGRATION = path.join(
    __dirname, '..', '..', 'prisma', 'migrations',
    '20260824000000_apple_authoritative_state', 'migration.sql',
  );

  const adapter: QueueClient = {
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) =>
      Number((await db.execute({ sql, args: args as never })).rowsAffected),
    $queryRawUnsafe: async <T,>(sql: string, ...args: unknown[]) =>
      (await db.execute({ sql, args: args as never })).rows as T[],
    $transaction: async <T,>(fn: (tx: QueueClient) => Promise<T>): Promise<T> => {
      await db.execute('BEGIN');
      try { const out = await fn(adapter); await db.execute('COMMIT'); return out; }
      catch (err) { await db.execute('ROLLBACK'); throw err; }
    },
  };

  beforeEach(async () => {
    __resetAppleRateLimitersForTests();
    db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY)`);
    const sql = fs.readFileSync(MIGRATION, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';')) { const s = stmt.trim(); if (s) await db.execute(s); }
  });
  afterEach(() => { db.close(); __resetAppleRateLimitersForTests(); });

  it('HTTP body -> transport -> verifiers -> normalization -> CAS -> snapshot', async () => {
    const now = new Date().toISOString();
    await db.execute({
      sql: __TEST_ONLY_ENQUEUE_SQL,
      args: [crypto.randomUUID(), 'Production', OTI, now, now, now],
    });

    const verifyTx = vi.fn(async () => verifiedTransaction());
    const verifyRenewal = vi.fn(async () => verifiedRenewal());
    const transport = new AppleServerApiTransport({
      getAuthToken: async () => 'tok',
      verifyTransaction: verifyTx,
      verifyRenewal,
      fetchImpl: (async () => response({ body: wireBody() })) as unknown as typeof fetch,
    });

    const out = await reconcileOnce('w1', { transport, client: adapter });
    expect(out.kind).toBe('committed');
    expect(verifyTx).toHaveBeenCalledTimes(1);
    expect(verifyRenewal).toHaveBeenCalledTimes(1);

    const s = (await db.execute(`SELECT * FROM "AppleSubscription"`)).rows[0];
    expect(String(s.originalTransactionId)).toBe(OTI);
    expect(String(s.plan)).toBe('pro');
    expect(String(s.status)).toBe('active');
    expect(String(s.subscriptionGroupId)).toBe('group-1');   // the VERIFIED group
    expect(Number(s.appliedGeneration)).toBe(1);
  });

  it('a verifier failure through the real transport writes no snapshot', async () => {
    const now = new Date().toISOString();
    await db.execute({
      sql: __TEST_ONLY_ENQUEUE_SQL,
      args: [crypto.randomUUID(), 'Production', OTI, now, now, now],
    });
    const transport = new AppleServerApiTransport({
      getAuthToken: async () => 'tok',
      verifyTransaction: async () => { throw new Error('jws signature invalid'); },
      verifyRenewal: async () => verifiedRenewal(),
      fetchImpl: (async () => response({ body: wireBody() })) as unknown as typeof fetch,
    });

    const out = await reconcileOnce('w1', { transport, client: adapter });
    expect(out.kind).toBe('transient');   // unclassified throw, retried not trusted
    expect(Number((await db.execute(`SELECT COUNT(*) AS n FROM "AppleSubscription"`)).rows[0].n)).toBe(0);
  });
});
