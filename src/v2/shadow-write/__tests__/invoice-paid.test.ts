// Unit tests for the v2 shadow-write of invoice.paid events.
//
// Focus: gating behavior + failure isolation. The contract is:
//   - V2_SHADOW_WRITE_ENABLED !== 'true' → no-op (no postTransaction call)
//   - postTransaction throws → swallowed; caller is unaffected
//   - eventGroupId is deterministic and matches MIG-1's derivation

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postTransactionMock = vi.hoisted(() => vi.fn());

vi.mock('../../ledger', () => ({
  postTransaction: postTransactionMock,
}));

import { shadowWriteInvoicePaid } from '../invoice-paid';

const baseArgs = {
  stripeEventId: 'evt_test_123',
  stripeInvoiceId: 'in_test_123',
  stripeChargeId: 'ch_test_456',
  creatorUserId: '11111111-1111-4111-8111-111111111111',
  creatorShareCents: 800,
  platformShareCents: 200,
  isLegacyDestination: false,
  effectiveAt: new Date('2026-05-28T12:00:00Z'),
};

describe('shadowWriteInvoicePaid gating', () => {
  beforeEach(() => {
    postTransactionMock.mockReset();
    postTransactionMock.mockResolvedValue({
      eventGroupId: 'whatever',
      entries: [],
      deduplicated: false,
    });
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('is a no-op when env not set', async () => {
    await shadowWriteInvoicePaid(baseArgs);
    expect(postTransactionMock).not.toHaveBeenCalled();
  });

  it('is a no-op when env explicitly "false"', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'false';
    await shadowWriteInvoicePaid(baseArgs);
    expect(postTransactionMock).not.toHaveBeenCalled();
  });

  it('calls postTransaction when env="true"', async () => {
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
    await shadowWriteInvoicePaid(baseArgs);
    expect(postTransactionMock).toHaveBeenCalledOnce();
  });
});

describe('shadowWriteInvoicePaid payload shape', () => {
  beforeEach(() => {
    postTransactionMock.mockReset();
    postTransactionMock.mockResolvedValue({
      eventGroupId: 'whatever',
      entries: [],
      deduplicated: false,
    });
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('produces a balanced 3-entry event group', async () => {
    await shadowWriteInvoicePaid(baseArgs);
    const input = postTransactionMock.mock.calls[0][0];
    expect(input.entries).toHaveLength(3);
    // INV-2 balance: stripe_clearing debit 1000 = creator credit 800 + platform credit 200
    const totalDebit = input.entries.reduce((s: bigint, e: { debitMinorUnits: bigint }) => s + e.debitMinorUnits, 0n);
    const totalCredit = input.entries.reduce((s: bigint, e: { creditMinorUnits: bigint }) => s + e.creditMinorUnits, 0n);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(1000n);
  });

  it('uses webhook: postedBy', async () => {
    await shadowWriteInvoicePaid(baseArgs);
    const input = postTransactionMock.mock.calls[0][0];
    expect(input.postedBy).toBe('webhook:invoice.paid');
  });

  it('produces deterministic eventGroupId from stripeEventId', async () => {
    await shadowWriteInvoicePaid(baseArgs);
    const id1 = postTransactionMock.mock.calls[0][0].eventGroupId;
    postTransactionMock.mockClear();
    await shadowWriteInvoicePaid(baseArgs);
    const id2 = postTransactionMock.mock.calls[0][0].eventGroupId;
    expect(id1).toBe(id2);
    // UUID v4 shape (matches postTransaction's regex).
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('different stripeEventIds produce different eventGroupIds', async () => {
    await shadowWriteInvoicePaid(baseArgs);
    const idA = postTransactionMock.mock.calls[0][0].eventGroupId;
    postTransactionMock.mockClear();
    await shadowWriteInvoicePaid({ ...baseArgs, stripeEventId: 'evt_different' });
    const idB = postTransactionMock.mock.calls[0][0].eventGroupId;
    expect(idA).not.toBe(idB);
  });

  it('tags every entry with legacy_destination metadata when flag is true', async () => {
    await shadowWriteInvoicePaid({ ...baseArgs, isLegacyDestination: true });
    const input = postTransactionMock.mock.calls[0][0];
    for (const e of input.entries) {
      expect(e.metadata).toEqual({ legacy_destination: true, source: 'v2-shadow-write' });
    }
  });

  it('passes recent effectiveAt through unchanged', async () => {
    const when = new Date(Date.now() - 60_000); // 1 minute ago
    await shadowWriteInvoicePaid({ ...baseArgs, effectiveAt: when });
    const input = postTransactionMock.mock.calls[0][0];
    expect(input.effectiveAt.getTime()).toBe(when.getTime());
  });

  it('clamps effectiveAt to within the 730-day past-window for backdated replays', async () => {
    // Stripe "Resend event" admin tool can emit events with `created`
    // from > 2 years ago. The clamp ensures postTransaction's 730-day
    // past-window doesn't silently reject the shadow-write.
    const farPast = new Date('2022-01-01T00:00:00Z');
    await shadowWriteInvoicePaid({ ...baseArgs, effectiveAt: farPast });
    const input = postTransactionMock.mock.calls[0][0];
    const minAllowed = Date.now() - 730 * 24 * 60 * 60 * 1000;
    expect(input.effectiveAt.getTime()).toBeGreaterThan(minAllowed);
    // And less than `now` (clamp doesn't push it into the future).
    expect(input.effectiveAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('shadowWriteInvoicePaid failure isolation', () => {
  beforeEach(() => {
    postTransactionMock.mockReset();
    process.env.V2_SHADOW_WRITE_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.V2_SHADOW_WRITE_ENABLED;
  });

  it('swallows postTransaction errors — caller is unaffected', async () => {
    postTransactionMock.mockRejectedValueOnce(new Error('Postgres connection refused'));
    // Must not throw.
    await expect(shadowWriteInvoicePaid(baseArgs)).resolves.toBeUndefined();
  });

  it('handles deduplicated=true response without warning', async () => {
    postTransactionMock.mockResolvedValueOnce({
      eventGroupId: 'whatever',
      entries: [{}, {}, {}],
      deduplicated: true,
    });
    // Must complete normally.
    await expect(shadowWriteInvoicePaid(baseArgs)).resolves.toBeUndefined();
  });

  it('skips invalid amounts (defensive — caller should validate)', async () => {
    await shadowWriteInvoicePaid({ ...baseArgs, creatorShareCents: 0 });
    expect(postTransactionMock).not.toHaveBeenCalled();
  });
});
