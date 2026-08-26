import { describe, it, expect, beforeEach, vi } from 'vitest';

const { ingestMock, createVerifierMock, configMock } = vi.hoisted(() => ({
  ingestMock: vi.fn(),
  createVerifierMock: vi.fn(() => ({} as never)),
  configMock: { appleIapEnabled: false, appleBundleId: 'com.nala.portfolio', appleAppAppleId: 123 },
}));

vi.mock('../services/apple-notification-intake.service', () => ({
  ingestAppleNotification: ingestMock,
}));

vi.mock('../services/apple-verifier', async (importOriginal) => {
  // Keep the REAL error classes: the controller maps on instanceof, and a stubbed
  // class would let a broken mapping pass.
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, createAppleVerifier: createVerifierMock };
});

vi.mock('../config', () => ({ config: configMock }));

import { appleWebhookHandler } from '../controllers/apple-iap.controller';
import {
  AppleVerificationPermanentError,
  AppleVerificationTransientError,
} from '../services/apple-verifier';

/**
 * The /billing/apple-webhook contract.
 *
 * Two things are being pinned here:
 *
 *   1. While the rollout flag is off the route does NOTHING — no verifier is
 *      constructed, no credential is read, no Apple table is touched. The legacy
 *      handler had no gate at all, which is the single most important difference.
 *
 *   2. Status codes are decided by typed errors. The path this replaces chose its
 *      retry policy by searching error strings for English words like "mismatch"
 *      and "Missing", so a reworded library message silently flipped a security
 *      decision — and it answered 200 to a payload that failed verification.
 */

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res;
}
const req = (body: unknown) => ({ body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) } as never);

describe('POST /billing/apple-webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.appleIapEnabled = false;
    ingestMock.mockResolvedValue({
      outcome: 'accepted', notificationUUID: 'n-1', environment: 'Production',
      notificationType: 'DID_RENEW', enqueued: true,
    });
  });

  describe('while APPLE_IAP_ENABLED is false', () => {
    it('returns a deterministic 503 and does no Apple work at all', async () => {
      const res = mockRes();
      await appleWebhookHandler(req({ signedPayload: 'anything' }), res as never);

      expect(res.statusCode).toBe(503);
      expect(res.body).toMatchObject({ code: 'apple_iap_disabled' });

      // The gate runs BEFORE any of this: no verifier, no intake, so no
      // credential read and no Apple table touched.
      expect(createVerifierMock).not.toHaveBeenCalled();
      expect(ingestMock).not.toHaveBeenCalled();
    });

    it('short-circuits even for a malformed body', async () => {
      const res = mockRes();
      await appleWebhookHandler(req('not json at all'), res as never);
      expect(res.statusCode).toBe(503);
      expect(ingestMock).not.toHaveBeenCalled();
    });
  });

  describe('while enabled', () => {
    beforeEach(() => { configMock.appleIapEnabled = true; });

    it('400s a malformed body without calling intake', async () => {
      const res = mockRes();
      await appleWebhookHandler(req('}{ not json'), res as never);
      expect(res.statusCode).toBe(400);
      expect(ingestMock).not.toHaveBeenCalled();
    });

    it('400s a missing signedPayload', async () => {
      const res = mockRes();
      await appleWebhookHandler(req({ notThePayload: true }), res as never);
      expect(res.statusCode).toBe(400);
      expect(ingestMock).not.toHaveBeenCalled();
    });

    it('400s a non-string signedPayload', async () => {
      const res = mockRes();
      await appleWebhookHandler(req({ signedPayload: { nested: 'object' } }), res as never);
      expect(res.statusCode).toBe(400);
      expect(ingestMock).not.toHaveBeenCalled();
    });

    it('200s a durably accepted notification', async () => {
      const res = mockRes();
      await appleWebhookHandler(req({ signedPayload: 'jws' }), res as never);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ ok: true, outcome: 'accepted' });
    });

    for (const outcome of ['duplicate', 'ignored', 'superseded', 'failed'] as const) {
      it(`200s a durably audited '${outcome}' notification`, async () => {
        // Durability, not entitlement completion: every one of these committed,
        // so Apple must not be asked to redeliver.
        ingestMock.mockResolvedValue({
          outcome, notificationUUID: 'n-1', environment: 'Production',
          notificationType: 'DID_RENEW', enqueued: false,
        });
        const res = mockRes();
        await appleWebhookHandler(req({ signedPayload: 'jws' }), res as never);
        expect(res.statusCode).toBe(200);
      });
    }

    it('400s a PERMANENT verification failure — never 200', async () => {
      // The legacy handler answered 200 here, telling Apple a forged payload had
      // been accepted.
      ingestMock.mockRejectedValue(new AppleVerificationPermanentError('bad signature'));
      const res = mockRes();
      await appleWebhookHandler(req({ signedPayload: 'jws' }), res as never);
      expect(res.statusCode).toBe(400);
    });

    it('503s a TRANSIENT verification failure so Apple retries', async () => {
      ingestMock.mockRejectedValue(new AppleVerificationTransientError('ocsp unreachable'));
      const res = mockRes();
      await appleWebhookHandler(req({ signedPayload: 'jws' }), res as never);
      expect(res.statusCode).toBe(503);
      // Distinguished from a storage failure: same status, different cause, and
      // an operator reading the response must be able to tell them apart.
      expect(res.body).toMatchObject({ error: 'Verification temporarily unavailable' });
    });

    it('503s a durability failure — an uncommitted event is never acknowledged', async () => {
      ingestMock.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
      const res = mockRes();
      await appleWebhookHandler(req({ signedPayload: 'jws' }), res as never);
      expect(res.statusCode).toBe(503);
      expect(res.body).toMatchObject({ error: 'Notification could not be stored' });
    });

    it('never echoes the payload or an Apple identifier in the response', async () => {
      ingestMock.mockRejectedValue(new AppleVerificationPermanentError('bundle com.evil mismatch'));
      const res = mockRes();
      await appleWebhookHandler(req({ signedPayload: 'super-secret-jws' }), res as never);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('super-secret-jws');
      expect(body).not.toContain('com.evil');
      expect(body).not.toContain('bundle');
    });

    it('passes only the payload to intake — the caller cannot choose an environment', async () => {
      const res = mockRes();
      await appleWebhookHandler(
        req({ signedPayload: 'jws', environment: 'Sandbox', data: { environment: 'Sandbox' } }),
        res as never,
      );
      expect(res.statusCode).toBe(200);
      const [payload, deps] = ingestMock.mock.calls[0];
      expect(payload).toBe('jws');
      expect(Object.keys(deps as object)).toEqual(['verifier']);   // no environment seam
    });
  });
});
