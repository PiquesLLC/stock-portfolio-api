import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import * as jose from 'jose';
import fs from 'fs';
import path from 'path';
import {
  Environment,
  Status,
  VerificationException,
  VerificationStatus,
} from '@apple/app-store-server-library';
import {
  createAppleVerifier,
  classifyVerificationError,
  AppleVerificationPermanentError,
  AppleVerificationTransientError,
} from '../services/apple-verifier';
import {
  createAppleAuthTokenProvider,
  AppleAuthTokenError,
  APPLE_AUDIENCE,
  APPLE_MAX_TOKEN_TTL_SECONDS,
} from '../services/apple-auth-token';
import {
  appleTransportConfigFromEnv,
  missingAppleTransportConfig,
  createProductionAppleTransport,
} from '../services/apple-transport-factory';
import { reconcileOnce } from '../services/apple-reconciler.service';
import {
  __TEST_ONLY_ENQUEUE_SQL,
  PERMANENT_PARK_MS,
  type QueueClient,
  type AppleEnvironment,
} from '../services/apple-reconciliation-queue.service';
import { __resetAppleRateLimitersForTests } from '../services/apple-rate-limiter';

/**
 * The Apple trust boundary.
 *
 * Everything downstream treats decoded payloads as verified fact, so these tests
 * are about one question: when does "Apple said so" hold, and when it does not,
 * is the failure permanent or merely incomplete?
 *
 * Apple's cryptography is stubbed — no network, no PKI, no credentials. What is
 * exercised for real is the classification, the identity assertions, the
 * environment separation, the token claims, and how each failure travels through
 * reconcileOnce into the queue.
 */

const OTI = '2000000123456789';
const BUNDLE = 'com.nala.portfolio';

/** A stand-in for SignedDataVerifier with per-call behaviour. */
function stubVerifier(behaviour: {
  transaction?: () => unknown;
  renewal?: () => unknown;
}) {
  return {
    verifyAndDecodeTransaction: async () => {
      const r = behaviour.transaction?.();
      return r;
    },
    verifyAndDecodeRenewalInfo: async () => behaviour.renewal?.(),
  } as never;
}

const goodTransaction = (over: Record<string, unknown> = {}) => ({
  transactionId: 'txn-1',
  originalTransactionId: OTI,
  productId: 'nala_pro_monthly',
  bundleId: BUNDLE,
  environment: 'Production',
  expiresDate: Date.now() + 86_400_000,
  ...over,
});
const goodRenewal = (over: Record<string, unknown> = {}) => ({
  originalTransactionId: OTI,
  autoRenewStatus: 1,
  environment: 'Production',
  ...over,
});

describe('apple verifier — classification', () => {
  it('maps RETRYABLE_VERIFICATION_FAILURE to TRANSIENT', () => {
    const e = classifyVerificationError(new VerificationException(VerificationStatus.RETRYABLE_VERIFICATION_FAILURE));
    expect(e).toBeInstanceOf(AppleVerificationTransientError);
  });

  it('maps every other VerificationStatus to PERMANENT', () => {
    for (const status of [
      VerificationStatus.VERIFICATION_FAILURE,
      VerificationStatus.INVALID_APP_IDENTIFIER,
      VerificationStatus.INVALID_ENVIRONMENT,
      VerificationStatus.INVALID_CHAIN_LENGTH,
      VerificationStatus.INVALID_CERTIFICATE,
      VerificationStatus.FAILURE,
    ]) {
      const e = classifyVerificationError(new VerificationException(status));
      expect(e, `status ${status}`).toBeInstanceOf(AppleVerificationPermanentError);
    }
  });

  it('treats a malformed JWS as permanent — it is a statement about the DATA', () => {
    expect(classifyVerificationError(new Error('malformed JWS payload')))
      .toBeInstanceOf(AppleVerificationPermanentError);
  });

  it('treats an UNRECOGNISED failure as transient, not permanent', () => {
    // Parking a subscription forever on an unknown failure is worse than
    // retrying one that will keep failing.
    expect(classifyVerificationError(new Error('ECONNRESET talking to OCSP responder')))
      .toBeInstanceOf(AppleVerificationTransientError);
  });
});

describe('apple verifier — identity and environment', () => {
  const verifier = (behaviour: Parameters<typeof stubVerifier>[0]) =>
    createAppleVerifier({ bundleId: BUNDLE, appAppleId: 123, enableOnlineChecks: false }, () => stubVerifier(behaviour));

  it('verifies a valid PRODUCTION transaction', async () => {
    const v = verifier({ transaction: () => goodTransaction() });
    const t = await v.verifyTransaction('Production', 'JWS');
    expect(t.transactionId).toBe('txn-1');
    expect(t.originalTransactionId).toBe(OTI);
  });

  it('verifies a valid SANDBOX transaction', async () => {
    const v = verifier({ transaction: () => goodTransaction({ environment: 'Sandbox' }) });
    const t = await v.verifyTransaction('Sandbox', 'JWS');
    expect(t.transactionId).toBe('txn-1');
  });

  it('rejects a payload whose environment disagrees with the request', async () => {
    const v = verifier({ transaction: () => goodTransaction({ environment: 'Sandbox' }) });
    await expect(v.verifyTransaction('Production', 'JWS'))
      .rejects.toBeInstanceOf(AppleVerificationPermanentError);
  });

  it('rejects a payload for a different bundle id', async () => {
    const v = verifier({ transaction: () => goodTransaction({ bundleId: 'com.someone.else' }) });
    await expect(v.verifyTransaction('Production', 'JWS'))
      .rejects.toBeInstanceOf(AppleVerificationPermanentError);
  });

  it('rejects a verified transaction missing its identifiers', async () => {
    const v = verifier({ transaction: () => ({ productId: 'nala_pro_monthly', bundleId: BUNDLE }) });
    await expect(v.verifyTransaction('Production', 'JWS'))
      .rejects.toBeInstanceOf(AppleVerificationPermanentError);
  });

  it('surfaces an invalid certificate chain as permanent', async () => {
    const v = verifier({ transaction: () => { throw new VerificationException(VerificationStatus.INVALID_CHAIN_LENGTH); } });
    await expect(v.verifyTransaction('Production', 'JWS'))
      .rejects.toBeInstanceOf(AppleVerificationPermanentError);
  });

  it('surfaces an invalid signature as permanent', async () => {
    const v = verifier({ transaction: () => { throw new VerificationException(VerificationStatus.VERIFICATION_FAILURE); } });
    await expect(v.verifyTransaction('Production', 'JWS'))
      .rejects.toBeInstanceOf(AppleVerificationPermanentError);
  });

  it('surfaces an OCSP-style failure as transient', async () => {
    const v = verifier({ transaction: () => { throw new VerificationException(VerificationStatus.RETRYABLE_VERIFICATION_FAILURE); } });
    await expect(v.verifyTransaction('Production', 'JWS'))
      .rejects.toBeInstanceOf(AppleVerificationTransientError);
  });

  it('ENVIRONMENT SEPARATION: each environment gets its OWN verifier instance', async () => {
    const built: AppleEnvironment[] = [];
    const v = createAppleVerifier(
      { bundleId: BUNDLE, appAppleId: 123, enableOnlineChecks: false },
      (env) => { built.push(env); return stubVerifier({ transaction: () => goodTransaction({ environment: env }) }); },
    );
    await v.verifyTransaction('Production', 'JWS');
    await v.verifyTransaction('Sandbox', 'JWS');
    await v.verifyTransaction('Production', 'JWS');   // cached, not rebuilt
    expect(built).toEqual(['Production', 'Sandbox']);
    // Distinct Environment values reach the library, so one environment can
    // never vouch for the other.
    expect(Environment.PRODUCTION).not.toBe(Environment.SANDBOX);
  });

  it('never echoes the signed payload in an error message', async () => {
    const SECRET_JWS = 'eyJhbGciOiJFUzI1NiJ9.SUPERSECRETPAYLOAD.sig';
    const v = verifier({ transaction: () => { throw new VerificationException(VerificationStatus.VERIFICATION_FAILURE); } });
    const err = await v.verifyTransaction('Production', SECRET_JWS).catch((e) => e as Error);
    expect(err.message).not.toContain('SUPERSECRETPAYLOAD');
    expect(err.message).not.toContain(SECRET_JWS);
  });
});

describe('apple auth token provider', () => {
  let privateKeyPem: string;
  let publicKey: jose.CryptoKey | Uint8Array;

  beforeEach(async () => {
    const { privateKey, publicKey: pub } = await jose.generateKeyPair('ES256', { extractable: true });
    privateKeyPem = await jose.exportPKCS8(privateKey);
    publicKey = pub as never;
  });

  const provider = (over: Record<string, unknown> = {}, now?: () => number) =>
    createAppleAuthTokenProvider({
      issuerId: 'issuer-uuid', keyId: 'KEYID123', privateKey: privateKeyPem, bundleId: BUNDLE, ...over,
    } as never, now);

  it('mints a token with the correct kid, issuer, audience and bundle', async () => {
    const token = await provider().getToken('Production');
    const header = jose.decodeProtectedHeader(token);
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('KEYID123');
    expect(header.typ).toBe('JWT');

    const { payload } = await jose.jwtVerify(token, publicKey as never, { audience: APPLE_AUDIENCE });
    expect(payload.iss).toBe('issuer-uuid');
    expect(payload.aud).toBe(APPLE_AUDIENCE);
    expect(payload.bid).toBe(BUNDLE);
  });

  it('bounds the token lifetime and caps it at Apple\'s maximum', async () => {
    const t1 = await provider({ ttlSeconds: 600 }).getToken('Production');
    const p1 = jose.decodeJwt(t1);
    expect(p1.exp! - p1.iat!).toBe(600);

    // A caller asking for longer than Apple permits gets Apple's cap, not theirs.
    const t2 = await provider({ ttlSeconds: 24 * 60 * 60 }).getToken('Production');
    const p2 = jose.decodeJwt(t2);
    expect(p2.exp! - p2.iat!).toBe(APPLE_MAX_TOKEN_TTL_SECONDS);
  });

  it('reuses a live token and re-mints once it nears expiry', async () => {
    let nowMs = 1_700_000_000_000;
    const p = provider({ ttlSeconds: 300 }, () => nowMs);
    const a = await p.getToken('Production');
    const b = await p.getToken('Production');
    expect(b).toBe(a);                       // cached
    nowMs += 300_000;                        // past expiry
    const c = await p.getToken('Production');
    expect(c).not.toBe(a);                   // re-minted
  });

  it('reports missing configuration by NAME and never by value', async () => {
    for (const [field, expected] of [
      ['issuerId', 'issuer id'], ['keyId', 'key id'], ['privateKey', 'private key'], ['bundleId', 'bundle id'],
    ] as const) {
      const err = await provider({ [field]: '' }).getToken('Production').catch((e) => e as Error);
      expect(err).toBeInstanceOf(AppleAuthTokenError);
      expect(err.message).toContain(expected);
    }
  });

  it('never includes private key material in a parse failure', async () => {
    const FAKE_KEY = '-----BEGIN PRIVATE KEY-----\nSECRETKEYBYTES\n-----END PRIVATE KEY-----';
    const err = await provider({ privateKey: FAKE_KEY }).getToken('Production').catch((e) => e as Error);
    expect(err).toBeInstanceOf(AppleAuthTokenError);
    expect(err.message).not.toContain('SECRETKEYBYTES');
    expect(err.message).not.toContain('BEGIN PRIVATE KEY');
  });

  it('describe() exposes presence, never secrets', async () => {
    const d = provider().describe();
    expect(d).toEqual({ issuerIdPresent: true, keyIdPresent: true, privateKeyPresent: true, bundleId: BUNDLE, ttlSeconds: 20 * 60 });
    expect(JSON.stringify(d)).not.toContain(privateKeyPem.slice(30, 60));
    expect(JSON.stringify(d)).not.toContain('KEYID123');
  });
});

describe('apple transport factory', () => {
  it('reads the ISSUER id, not the team id, and reports what is missing by name', () => {
    const cfg = appleTransportConfigFromEnv({
      APPLE_ISSUER_ID: 'iss', APPLE_KEY_ID: 'kid', APPLE_PRIVATE_KEY: 'pk',
      APPLE_BUNDLE_ID: BUNDLE, APPLE_APP_APPLE_ID: '99',
      APPLE_TEAM_ID: 'TEAMSHOULDNOTBEUSED',
    } as never);
    expect(cfg.auth.issuerId).toBe('iss');
    expect(JSON.stringify(cfg)).not.toContain('TEAMSHOULDNOTBEUSED');
    expect(missingAppleTransportConfig(cfg)).toEqual([]);

    const empty = appleTransportConfigFromEnv({} as never);
    expect(missingAppleTransportConfig(empty)).toEqual([
      'APPLE_ISSUER_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY', 'APPLE_BUNDLE_ID', 'APPLE_APP_APPLE_ID',
    ]);
  });

  it('constructs without touching the network and invokes nothing on its own', () => {
    const built = createProductionAppleTransport({
      auth: { issuerId: 'i', keyId: 'k', privateKey: 'p', bundleId: BUNDLE },
      verifier: { bundleId: BUNDLE, appAppleId: 1, enableOnlineChecks: false },
    });
    expect(typeof built.transport.getAllSubscriptionStatuses).toBe('function');
    expect(built.tokenProvider.describe().bundleId).toBe(BUNDLE);
  });
});

describe('verification failures through reconcileOnce (real engine)', () => {
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
  const enqueue = async () => {
    const now = new Date().toISOString();
    await db.execute({ sql: __TEST_ONLY_ENQUEUE_SQL, args: [crypto.randomUUID(), 'Production', OTI, now, now, now] });
  };
  const job = async () => (await db.execute(`SELECT * FROM "AppleReconciliation"`)).rows[0] as Record<string, unknown>;

  beforeEach(async () => {
    __resetAppleRateLimitersForTests();
    db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY)`);
    const sql = fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';')) { const s = stmt.trim(); if (s) await db.execute(s); }
  });
  afterEach(() => { db.close(); __resetAppleRateLimitersForTests(); });

  it('a PERMANENT verification failure is parked, not retried forever', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter,
      transport: { getAllSubscriptionStatuses: async () => { throw new AppleVerificationPermanentError('signature verification failure'); } },
    });
    expect(out.kind).toBe('permanently-invalid');

    const j = await job();
    expect(String(j.reconcileState)).toBe('failed');
    expect(String(j.lastError)).toContain('permanently');
    // Parked far out — an hourly retry forever would bury the real problem.
    const parkedMs = new Date(String(j.nextAttemptAt)).getTime() - Date.now();
    expect(parkedMs).toBeGreaterThan(PERMANENT_PARK_MS * 0.9);
    expect(Number((await db.execute(`SELECT COUNT(*) AS n FROM "AppleSubscription"`)).rows[0].n)).toBe(0);
  });

  it('a parked job is revived by a NEW notification, not by our own retries', async () => {
    await enqueue();
    await reconcileOnce('w1', {
      client: adapter,
      transport: { getAllSubscriptionStatuses: async () => { throw new AppleVerificationPermanentError('bad chain'); } },
    });
    expect(new Date(String((await job()).nextAttemptAt)).getTime()).toBeGreaterThan(Date.now() + 1e9);

    await enqueue();   // Apple sends something new
    const j = await job();
    expect(Number(j.targetGeneration)).toBe(2);
    expect(new Date(String(j.nextAttemptAt)).getTime()).toBeLessThan(Date.now() + 60_000);
  });

  it('a TRANSIENT verification failure takes ordinary durable backoff', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter,
      transport: { getAllSubscriptionStatuses: async () => { throw new AppleVerificationTransientError('retryable verification failure'); } },
    });
    expect(out.kind).toBe('transient');

    const j = await job();
    expect(String(j.reconcileState)).toBe('failed');
    expect(Number(j.attemptCount)).toBe(1);
    const delayMs = new Date(String(j.nextAttemptAt)).getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(1_000);
    expect(delayMs).toBeLessThan(PERMANENT_PARK_MS * 0.5);   // backed off, NOT parked
  });

  it('a valid verified response still commits normally', async () => {
    await enqueue();
    const out = await reconcileOnce('w1', {
      client: adapter,
      transport: {
        getAllSubscriptionStatuses: async () => ({
          environment: 'Production',
          data: [{
            subscriptionGroupIdentifier: 'group-1',
            lastTransactions: [{
              outerOriginalTransactionId: OTI,
              status: Status.ACTIVE,
              transaction: goodTransaction() as never,
              renewal: goodRenewal() as never,
            }],
          }],
        }),
      },
    });
    expect(out.kind).toBe('committed');
  });
});
