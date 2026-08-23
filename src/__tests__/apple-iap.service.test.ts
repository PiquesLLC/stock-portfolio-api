import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

/**
 * Apple IAP — refund-replay guard (H-1) and notification handling.
 *
 * This service had NO test coverage at all, despite deciding whether a user is
 * entitled to a paid plan. These cases pin the behaviours that a refund
 * abuser would attack.
 */

const { verifyTxnMock, verifyNotifMock } = vi.hoisted(() => ({
  verifyTxnMock: vi.fn(),
  verifyNotifMock: vi.fn(),
}));

// Replace Apple's JWS verifier so tests supply decoded payloads directly. The
// signature/chain/bundle checks are the library's job, not ours.
vi.mock('@apple/app-store-server-library', () => ({
  Environment: { PRODUCTION: 'PRODUCTION', SANDBOX: 'SANDBOX' },
  VerificationStatus: {},
  VerificationException: class VerificationException extends Error {},
  SignedDataVerifier: class {
    verifyAndDecodeTransaction = verifyTxnMock;
    verifyAndDecodeNotification = verifyNotifMock;
  },
}));

// Run the job body inline so the notification path is directly exercisable.
vi.mock('../services/job-runner.service', () => ({
  runJob: async (opts: { fn: () => Promise<void> }) => { await opts.fn(); },
  JobExecutionError: class JobExecutionError extends Error {
    kind: string;
    constructor(message: string, kind = 'PERMANENT') { super(message); this.kind = kind; }
  },
}));

vi.mock('../config', () => ({
  config: {
    nodeEnv: 'test',
    appleBundleId: 'com.nala.portfolio',
    appleAppAppleId: 123456,
  },
}));

vi.mock('jose', () => ({
  decodeJwt: () => ({ notificationUUID: 'uuid-1', notificationType: 'TEST' }),
}));

import { verifyAndActivatePlan, handleAppleNotification } from '../services/apple-iap.service';

const HOUR = 60 * 60 * 1000;
const YEAR_AHEAD = Date.now() + 365 * 24 * HOUR;

function ensureShape(): void {
  const p = prismaMock as any;
  p.user ??= {};
  p.user.findUnique ??= vi.fn();
  p.user.findFirst ??= vi.fn();
  p.user.update ??= vi.fn();
  p.appleIAPWebhookEvent ??= {};
  p.appleIAPWebhookEvent.create ??= vi.fn();
  p.appleIAPWebhookEvent.deleteMany ??= vi.fn();
}

/** The last `data` object written by prisma.user.update. */
function lastUserUpdate(): any {
  const calls = (prismaMock as any).user.update.mock.calls;
  return calls.length ? calls[calls.length - 1][0].data : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureShape();
  (prismaMock as any).$transaction = vi.fn(async (arg: unknown) => {
    if (typeof arg === 'function') return (arg as any)(prismaMock);
    if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
    return arg;
  });
  (prismaMock as any).user.update.mockResolvedValue({ id: 'user_1' });
  (prismaMock as any).appleIAPWebhookEvent.create.mockResolvedValue({ id: 'evt_1' });
  (prismaMock as any).appleIAPWebhookEvent.deleteMany.mockResolvedValue({ count: 0 });
});

// ---------------------------------------------------------------------------
// verifyAndActivatePlan — the client-submitted receipt path
// ---------------------------------------------------------------------------
describe('verifyAndActivatePlan', () => {
  function armTxn(over: Record<string, unknown> = {}) {
    verifyTxnMock.mockResolvedValue({
      productId: 'nala_elite_yearly',
      originalTransactionId: 'T1',
      expiresDate: YEAR_AHEAD,
      purchaseDate: Date.now() - HOUR,
      ...over,
    });
  }

  it('activates a clean transaction and binds it to the user', async () => {
    armTxn();
    (prismaMock as any).user.findUnique
      .mockResolvedValueOnce({ stripeSubscriptionId: null, plan: 'free' }) // the caller
      .mockResolvedValueOnce(null);                                        // no existing owner

    const result = await verifyAndActivatePlan('user_1', 'jws');

    expect(result.plan).toBe('elite');
    expect(lastUserUpdate()).toMatchObject({
      plan: 'elite',
      appleOriginalTransactionId: 'T1',
      applePurchaseSource: 'app_store',
    });
  });

  it('REFUSES a transaction whose owner carries the revoked marker (H-1 core)', async () => {
    // The saved receipt still looks perfectly valid — signed before the refund,
    // so no revocationDate and a future expiry. Only the server-side marker can
    // refuse it.
    armTxn();
    (prismaMock as any).user.findUnique
      .mockResolvedValueOnce({ stripeSubscriptionId: null, plan: 'free' })
      .mockResolvedValueOnce({ id: 'user_1', applePurchaseSource: 'app_store_revoked:123' });

    await expect(verifyAndActivatePlan('user_1', 'jws')).rejects.toThrow(/refunded or revoked/i);
    expect((prismaMock as any).user.update).not.toHaveBeenCalled();
  });

  it('refuses a transaction Apple itself reports as revoked', async () => {
    armTxn({ revocationDate: Date.now() - HOUR });
    await expect(verifyAndActivatePlan('user_1', 'jws')).rejects.toThrow(/revoked/i);
  });

  it('refuses an expired transaction (no zombie plan)', async () => {
    armTxn({ expiresDate: Date.now() - HOUR });
    await expect(verifyAndActivatePlan('user_1', 'jws')).rejects.toThrow(/expired/i);
  });

  it('refuses a transaction already bound to a different account', async () => {
    armTxn();
    (prismaMock as any).user.findUnique
      .mockResolvedValueOnce({ stripeSubscriptionId: null, plan: 'free' })
      .mockResolvedValueOnce({ id: 'someone_else', applePurchaseSource: 'app_store' });

    await expect(verifyAndActivatePlan('user_1', 'jws')).rejects.toThrow(/another account/i);
  });
});

// ---------------------------------------------------------------------------
// Server notifications
// ---------------------------------------------------------------------------
describe('Apple server notifications', () => {
  function armNotification(
    notificationType: string,
    txn: Record<string, unknown>,
    userRow: Record<string, unknown>,
  ) {
    verifyNotifMock.mockResolvedValue({
      notificationType,
      notificationUUID: `uuid-${notificationType}`,
      data: { signedTransactionInfo: 'inner-jws' },
    });
    verifyTxnMock.mockResolvedValue({
      productId: 'nala_elite_yearly',
      originalTransactionId: 'T1',
      expiresDate: YEAR_AHEAD,
      ...txn,
    });
    (prismaMock as any).user.findFirst.mockResolvedValue({ id: 'user_1', ...userRow });
  }

  it('REFUND keeps the transaction bound and stamps a timestamped revoked marker', async () => {
    armNotification('REFUND', { purchaseDate: Date.now() - HOUR }, { applePurchaseSource: 'app_store' });

    await handleAppleNotification('outer-jws');

    const data = lastUserUpdate();
    expect(data.plan).toBe('free');
    // The binding must SURVIVE — it is the row carrying the marker.
    expect(data).not.toHaveProperty('appleOriginalTransactionId');
    expect(String(data.applePurchaseSource)).toMatch(/^app_store_revoked:\d+$/);
  });

  it('EXPIRED RELEASES the binding (so the same Apple ID can subscribe on a new account)', async () => {
    // Retaining it here would both refuse a legitimate new account and, worse,
    // route the resulting SUBSCRIBED to the abandoned one.
    armNotification('EXPIRED', { purchaseDate: Date.now() - HOUR }, { applePurchaseSource: 'app_store' });

    await handleAppleNotification('outer-jws');

    const data = lastUserUpdate();
    expect(data.plan).toBe('free');
    expect(data.appleOriginalTransactionId).toBeNull();
    expect(data.applePurchaseSource).toBeNull();
  });

  it('IGNORES a stale SUBSCRIBED that predates the revocation', async () => {
    // Apple retries an unacknowledged notification for up to 3 days, so a
    // SUBSCRIBED generated before a refund can arrive after it: no
    // revocationDate in its JWS and a future expiry, i.e. it passes every
    // content check. Only the purchase-vs-revocation comparison rejects it.
    const revokedAt = Date.now() - HOUR;
    armNotification(
      'SUBSCRIBED',
      { purchaseDate: revokedAt - HOUR }, // purchased BEFORE the revocation
      { applePurchaseSource: `app_store_revoked:${revokedAt}` },
    );

    await handleAppleNotification('outer-jws');

    expect((prismaMock as any).user.update).not.toHaveBeenCalled();
  });

  it('honours a genuine SUBSCRIBED that postdates the revocation, clearing the marker', async () => {
    const revokedAt = Date.now() - 2 * HOUR;
    armNotification(
      'SUBSCRIBED',
      { purchaseDate: revokedAt + HOUR }, // a real new purchase
      { applePurchaseSource: `app_store_revoked:${revokedAt}` },
    );

    await handleAppleNotification('outer-jws');

    expect(lastUserUpdate()).toMatchObject({ plan: 'elite', applePurchaseSource: 'app_store' });
  });

  it('never lets DID_CHANGE_RENEWAL_STATUS clear the revoked marker', async () => {
    // This fires when the user toggles auto-renew in App Store settings — no
    // purchase is involved, so it must not launder a revoked transaction.
    const revokedAt = Date.now() - 2 * HOUR;
    armNotification(
      'DID_CHANGE_RENEWAL_STATUS',
      { purchaseDate: revokedAt + HOUR },
      { applePurchaseSource: `app_store_revoked:${revokedAt}` },
    );

    await handleAppleNotification('outer-jws');

    const data = lastUserUpdate();
    expect(data).not.toHaveProperty('applePurchaseSource');
  });

  it('refuses to mint a never-expiring plan from a notification with no expiry', async () => {
    // plan.middleware treats planExpiresAt === null as never-expiring.
    armNotification('SUBSCRIBED', { expiresDate: null, purchaseDate: Date.now() }, { applePurchaseSource: 'app_store' });

    await handleAppleNotification('outer-jws');

    expect((prismaMock as any).user.update).not.toHaveBeenCalled();
  });

  it('EXPIRED does NOT wipe an existing revoked marker (straggler ordering)', async () => {
    // Apple retries for up to 3 days, so an EXPIRED generated before a refund
    // can land after it. Nulling the fields there would delete the marker AND
    // unbind the transaction, letting the saved pre-refund receipt replay.
    armNotification(
      'EXPIRED',
      { purchaseDate: Date.now() - HOUR },
      { applePurchaseSource: `app_store_revoked:${Date.now() - HOUR}` },
    );

    await handleAppleNotification('outer-jws');

    const data = lastUserUpdate();
    expect(data.plan).toBe('free');
    // Binding and marker both preserved.
    expect(data).not.toHaveProperty('appleOriginalTransactionId');
    expect(data).not.toHaveProperty('applePurchaseSource');
  });

  it('stamps the marker with APPLE’s revocationDate, not our processing time', async () => {
    // Using Date.now() would push the recorded revocation later by the whole
    // delivery delay, so a prompt legitimate re-subscription could look OLDER
    // than the revocation and be refused forever.
    const appleRevokedAt = Date.now() - 3 * HOUR;
    armNotification(
      'REFUND',
      { purchaseDate: Date.now() - 4 * HOUR, revocationDate: appleRevokedAt },
      { applePurchaseSource: 'app_store' },
    );

    await handleAppleNotification('outer-jws');

    expect(lastUserUpdate().applePurchaseSource).toBe(`app_store_revoked:${appleRevokedAt}`);
  });

  it('ignores a purchase notification for an already-revoked transaction with an unknown revocation time (fails closed)', async () => {
    armNotification('SUBSCRIBED', { purchaseDate: Date.now() }, { applePurchaseSource: 'app_store_revoked' });

    await handleAppleNotification('outer-jws');

    expect((prismaMock as any).user.update).not.toHaveBeenCalled();
  });
});
