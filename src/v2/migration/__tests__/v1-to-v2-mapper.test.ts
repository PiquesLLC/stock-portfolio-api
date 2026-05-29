// Unit tests for the v1 → v2 backfill mapper.
//
// Covers the implemented shapes (G1, G2, G5a, G5b, G5c) plus the
// deterministic eventGroupId derivation and the group-key bucketing.

import { describe, expect, it } from 'vitest';
import {
  V1LedgerRow,
  bucketV1Rows,
  mapV1GroupToV2Event,
  v1DescriptionToGroupKey,
  v1KeyToEventGroupId,
} from '../v1-to-v2-mapper';

const CREATOR_A = '11111111-1111-4111-8111-111111111111';
const CREATOR_B = '22222222-2222-4222-8222-222222222222';

function row(overrides: Partial<V1LedgerRow> = {}): V1LedgerRow {
  return {
    id: 'row_' + Math.random().toString(36).slice(2, 10),
    creatorUserId: CREATOR_A,
    type: 'earning',
    amountCents: 800,
    subscriptionId: null,
    description: null,
    createdAt: new Date('2026-01-15T00:00:00Z'),
    ...overrides,
  };
}

describe('v1KeyToEventGroupId', () => {
  it('produces a UUID v4 format string', () => {
    const out = v1KeyToEventGroupId('stripe_event:evt_abc');
    expect(out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is deterministic — same input → same UUID', () => {
    const a = v1KeyToEventGroupId('stripe_event:evt_xyz');
    const b = v1KeyToEventGroupId('stripe_event:evt_xyz');
    expect(a).toBe(b);
  });

  it('different inputs → different UUIDs', () => {
    expect(v1KeyToEventGroupId('a')).not.toBe(v1KeyToEventGroupId('b'));
  });

  it('namespaced — same v1 key under different prefix produces different UUID', () => {
    // The mapper prepends 'mig-1:' internally, so callers don't need a
    // collision check. But a future mig-2 would namespace differently.
    expect(v1KeyToEventGroupId('payout:po_1')).not.toBe(v1KeyToEventGroupId('stripe_event:po_1'));
  });
});

describe('v1DescriptionToGroupKey', () => {
  it('extracts stripe_event prefix', () => {
    expect(v1DescriptionToGroupKey('stripe_event:evt_X:creator_share')).toBe('stripe_event:evt_X');
    expect(v1DescriptionToGroupKey('stripe_event:evt_X:charge:ch_Y:creator_share')).toBe('stripe_event:evt_X');
    expect(v1DescriptionToGroupKey('stripe_event:evt_X:creator_share:legacy_destination')).toBe('stripe_event:evt_X');
  });

  it('extracts payout shapes', () => {
    expect(v1DescriptionToGroupKey('payout:po_1')).toBe('payout:po_1');
    expect(v1DescriptionToGroupKey('payout_reversal:po_2')).toBe('payout_reversal:po_2');
    expect(v1DescriptionToGroupKey('transfer_reversed:tr_3')).toBe('transfer_reversed:tr_3');
  });

  it('returns full description for admin_fix (unique idempotency embedded)', () => {
    const desc = 'admin_fix:initial_payment:user_a:idem_1';
    expect(v1DescriptionToGroupKey(desc)).toBe(desc);
  });

  it('returns null for unrecognized', () => {
    expect(v1DescriptionToGroupKey(null)).toBeNull();
    expect(v1DescriptionToGroupKey('')).toBeNull();
    expect(v1DescriptionToGroupKey('legacy_freeform_note')).toBeNull();
  });
});

describe('bucketV1Rows', () => {
  it('groups rows by their derived key', () => {
    const a1 = row({ description: 'stripe_event:evt_A:creator_share', type: 'earning' });
    const a2 = row({ description: 'stripe_event:evt_A:platform_fee', type: 'platform_fee', amountCents: 200 });
    const b1 = row({ description: 'payout:po_1', type: 'payout', amountCents: 500 });
    const x1 = row({ description: 'legacy_freeform' });
    const { groups, unbucketed } = bucketV1Rows([a1, a2, b1, x1]);
    expect(groups.get('stripe_event:evt_A')).toHaveLength(2);
    expect(groups.get('payout:po_1')).toHaveLength(1);
    expect(unbucketed).toHaveLength(1);
  });
});

describe('mapV1GroupToV2Event — G1 invoice.paid', () => {
  it('emits 3 balanced entries when creator+platform_fee pair present', () => {
    const rows = [
      row({ type: 'earning', amountCents: 800, description: 'stripe_event:evt_X:creator_share' }),
      row({ type: 'platform_fee', amountCents: 200, description: 'stripe_event:evt_X:platform_fee' }),
    ];
    const out = mapV1GroupToV2Event('stripe_event:evt_X', rows);
    expect(out.kind).toBe('mapped');
    if (out.kind !== 'mapped') return;
    expect(out.shape).toBe('G1.invoice.paid');
    expect(out.event.entries).toHaveLength(3);
    // Balanced: stripe_clearing debit 1000 = creator credit 800 + platform credit 200
    const stripeClearing = out.event.entries.find((e) => e.accountScope === 'stripe_clearing')!;
    const creator = out.event.entries.find((e) => e.accountScope === 'creator')!;
    const platformRev = out.event.entries.find((e) => e.accountScope === 'platform_revenue')!;
    expect(stripeClearing.debitMinorUnits).toBe(1000n);
    expect(creator.creditMinorUnits).toBe(800n);
    expect(platformRev.creditMinorUnits).toBe(200n);
  });

  it('tags entries with legacy_destination metadata when v1 row had the suffix', () => {
    const rows = [
      row({ type: 'earning', amountCents: 800, description: 'stripe_event:evt_X:creator_share:legacy_destination' }),
      row({ type: 'platform_fee', amountCents: 200, description: 'stripe_event:evt_X:platform_fee:legacy_destination' }),
    ];
    const out = mapV1GroupToV2Event('stripe_event:evt_X', rows);
    if (out.kind !== 'mapped') throw new Error('expected mapped');
    const creator = out.event.entries.find((e) => e.accountScope === 'creator')!;
    expect(creator.metadata).toEqual({ legacy_destination: true, source: 'v1-backfill' });
  });

  it('uses migration: postedBy', () => {
    const rows = [
      row({ type: 'earning', amountCents: 800, description: 'stripe_event:evt_X:creator_share' }),
      row({ type: 'platform_fee', amountCents: 200, description: 'stripe_event:evt_X:platform_fee' }),
    ];
    const out = mapV1GroupToV2Event('stripe_event:evt_X', rows);
    if (out.kind !== 'mapped') throw new Error('expected mapped');
    expect(out.event.postedBy).toBe('migration:mig-1-backfill-v1');
  });

  it('uses v1 row createdAt as v2 effectiveAt', () => {
    const when = new Date('2025-06-15T08:30:00Z');
    const rows = [
      row({ type: 'earning', amountCents: 800, description: 'stripe_event:evt_X:creator_share', createdAt: when }),
      row({ type: 'platform_fee', amountCents: 200, description: 'stripe_event:evt_X:platform_fee', createdAt: when }),
    ];
    const out = mapV1GroupToV2Event('stripe_event:evt_X', rows);
    if (out.kind !== 'mapped') throw new Error('expected mapped');
    expect(out.event.effectiveAt.getTime()).toBe(when.getTime());
  });

  it('eventGroupId is deterministic across runs', () => {
    const rows = [
      row({ type: 'earning', amountCents: 800, description: 'stripe_event:evt_DET:creator_share' }),
      row({ type: 'platform_fee', amountCents: 200, description: 'stripe_event:evt_DET:platform_fee' }),
    ];
    const out1 = mapV1GroupToV2Event('stripe_event:evt_DET', rows);
    const out2 = mapV1GroupToV2Event('stripe_event:evt_DET', rows);
    if (out1.kind !== 'mapped' || out2.kind !== 'mapped') throw new Error('expected mapped');
    expect(out1.event.eventGroupId).toBe(out2.event.eventGroupId);
  });
});

describe('mapV1GroupToV2Event — G2 charge.refunded', () => {
  it('emits 3 balanced entries on a refund pair', () => {
    const rows = [
      row({ type: 'refund', amountCents: -400, description: 'stripe_event:evt_R:charge:ch_X:refund_creator' }),
      row({ type: 'platform_fee', amountCents: -100, description: 'stripe_event:evt_R:charge:ch_X:refund_platform' }),
    ];
    const out = mapV1GroupToV2Event('stripe_event:evt_R', rows);
    expect(out.kind).toBe('mapped');
    if (out.kind !== 'mapped') return;
    expect(out.shape).toBe('G2.charge.refunded');
    // stripe_clearing CREDIT 500 = creator DEBIT 400 + platform DEBIT 100
    const stripeClearing = out.event.entries.find((e) => e.accountScope === 'stripe_clearing')!;
    const creator = out.event.entries.find((e) => e.accountScope === 'creator')!;
    const platformRev = out.event.entries.find((e) => e.accountScope === 'platform_revenue')!;
    expect(stripeClearing.creditMinorUnits).toBe(500n);
    expect(creator.debitMinorUnits).toBe(400n);
    expect(platformRev.debitMinorUnits).toBe(100n);
  });
});

describe('mapV1GroupToV2Event — G5a/b/c payouts', () => {
  it('G5a payout: 2 entries — creator debit + stripe_clearing credit', () => {
    const r = row({ type: 'payout', amountCents: 500, description: 'payout:po_1' });
    const out = mapV1GroupToV2Event('payout:po_1', [r]);
    expect(out.kind).toBe('mapped');
    if (out.kind !== 'mapped') return;
    expect(out.shape).toBe('G5a.payout');
    expect(out.event.entries).toHaveLength(2);
    const creator = out.event.entries.find((e) => e.accountScope === 'creator')!;
    expect(creator.debitMinorUnits).toBe(500n);
    expect(creator.eventType).toBe('PAYOUT_INITIATED');
  });

  it('G5b payout_reversal: creator credit + stripe_clearing debit', () => {
    const r = row({ type: 'earning', amountCents: 500, description: 'payout_reversal:po_1' });
    const out = mapV1GroupToV2Event('payout_reversal:po_1', [r]);
    if (out.kind !== 'mapped') throw new Error('expected mapped');
    const creator = out.event.entries.find((e) => e.accountScope === 'creator')!;
    expect(creator.creditMinorUnits).toBe(500n);
    expect(creator.eventType).toBe('PAYOUT_FAILED');
  });

  it('G5c transfer.reversed: creator credit + stripe_clearing debit', () => {
    const r = row({ type: 'earning', amountCents: 500, description: 'transfer_reversed:tr_1' });
    const out = mapV1GroupToV2Event('transfer_reversed:tr_1', [r]);
    if (out.kind !== 'mapped') throw new Error('expected mapped');
    const creator = out.event.entries.find((e) => e.accountScope === 'creator')!;
    expect(creator.eventType).toBe('PAYOUT_REVERSED');
  });

  it('rejects multi-row payout group as malformed', () => {
    const r1 = row({ type: 'payout', amountCents: 500, description: 'payout:po_X' });
    const r2 = row({ type: 'payout', amountCents: 500, description: 'payout:po_X' });
    const out = mapV1GroupToV2Event('payout:po_X', [r1, r2]);
    expect(out.kind).toBe('malformed');
  });
});

describe('mapV1GroupToV2Event — deferrals', () => {
  it('defers G3 dispute clawback shapes', () => {
    const rows = [
      row({ type: 'refund', amountCents: -800, description: 'stripe_event:evt_D:charge:ch_X:dispute_clawback_creator' }),
      row({ type: 'platform_fee', amountCents: -200, description: 'stripe_event:evt_D:charge:ch_X:dispute_clawback_platform' }),
    ];
    const out = mapV1GroupToV2Event('stripe_event:evt_D', rows);
    expect(out.kind).toBe('deferred');
  });

  it('defers G6 admin_fix groups', () => {
    const rows = [
      row({ type: 'earning', amountCents: 800, description: 'admin_fix:initial_payment:user_a:idem_1' }),
      row({ type: 'platform_fee', amountCents: 200, description: 'admin_fix:platform_fee:user_a:idem_1' }),
    ];
    const out = mapV1GroupToV2Event('admin_fix:initial_payment:user_a:idem_1', rows);
    expect(out.kind).toBe('deferred');
  });
});
