// MIG-1: map v1 CreatorWalletLedger rows → v2 double-entry event groups.
//
// v1's ledger stores ONE leg per row (the creator side, possibly paired with a
// platform_fee row). v2 requires the full balanced event group with the
// stripe_clearing balancing leg synthesized. This module translates each known
// v1 description shape into a v2 PostTransactionInput.
//
// COVERAGE STATUS:
//   G1  invoice.paid           ✅ implemented
//   G2  charge.refunded        ✅ implemented
//   G3  dispute.created        ✅ implemented (1-3 rows; independent gates)
//   G4  dispute.closed (won)   ✅ implemented (mirror of G3)
//   G5a payout requested       ✅ implemented
//   G5b payout reversal        ✅ implemented (Stripe transfer failure)
//   G5c transfer.reversed      ✅ implemented
//   G6  admin_fix              ⛔ deferred — no Stripe anchor; needs an
//                                 adjustment account in the chart of accounts
//
// IDEMPOTENCY: every group's eventGroupId is a deterministic UUID v4 derived
// from the v1 key via SHA-256. Re-running the backfill against the same v1
// rows hits v2's postTransaction idempotency dedup (same idempotency_key on
// same accounts) and writes nothing new.
//
// EVENT-TYPE MAPPING is conservative: v1's `earning` / `platform_fee` map to
// v2's `EARNING_GROSS` / `PLATFORM_FEE` etc. Reversal/restore types use the
// architecture's reversal event_types but DO NOT set `reversesEntryId` because
// v1 didn't track that linkage; preserving v2's structural double-clawback
// protection requires the dispute clawback to identify the original v1 entry,
// which is a separate concern (covered by the description-segment match v1
// already uses).

import { createHash, randomUUID } from 'crypto';
import { LedgerEntryInput, PostTransactionInput } from '../ledger/types';

export interface V1LedgerRow {
  id: string;
  creatorUserId: string;
  type: string;
  amountCents: number;
  subscriptionId: string | null;
  description: string | null;
  createdAt: Date;
}

export type MapperOutcome =
  | { kind: 'mapped'; event: PostTransactionInput; v1RowIds: string[]; shape: string }
  | { kind: 'deferred'; reason: string; v1RowIds: string[] }
  | { kind: 'malformed'; reason: string; v1RowIds: string[] };

// Derive a deterministic UUID v4 from an arbitrary v1 key (e.g. a Stripe
// event id, payout id). Re-running the backfill produces the same
// eventGroupId for the same v1 key, so postTransaction dedups idempotently.
export function v1KeyToEventGroupId(v1Key: string): string {
  const hash = createHash('sha256').update('mig-1:' + v1Key).digest('hex');
  // Force version=4 nibble (third group, first char).
  // Force variant=10xx (fourth group, first nibble in {8, 9, a, b}).
  const variantChar = ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return (
    hash.slice(0, 8) +
    '-' +
    hash.slice(8, 12) +
    '-' +
    '4' +
    hash.slice(13, 16) +
    '-' +
    variantChar +
    hash.slice(17, 20) +
    '-' +
    hash.slice(20, 32)
  );
}

// Inspect a v1 description and return the GROUP KEY that all v1 rows
// belonging to the same v2 event group share. Used by the bucketing pass.
// Returns null if the description doesn't match any known shape (the row
// is deferred for manual review).
export function v1DescriptionToGroupKey(description: string | null): string | null {
  if (!description) return null;

  // G1, G2, G3, G4 — all anchored on stripe_event:<id>.
  const stripeEventMatch = description.match(/^stripe_event:([^:]+)/);
  if (stripeEventMatch) {
    return `stripe_event:${stripeEventMatch[1]}`;
  }
  // G5a payouts
  const payoutMatch = description.match(/^payout:([^:]+)/);
  if (payoutMatch) return `payout:${payoutMatch[1]}`;
  // G5b payout reversals
  const payoutRevMatch = description.match(/^payout_reversal:([^:]+)/);
  if (payoutRevMatch) return `payout_reversal:${payoutRevMatch[1]}`;
  // G5c transfer reversals
  const transferRevMatch = description.match(/^transfer_reversed:([^:]+)/);
  if (transferRevMatch) return `transfer_reversed:${transferRevMatch[1]}`;
  // G6 admin fixes — the full description is unique (includes actorId +
  // idempotencyKey).
  if (description.startsWith('admin_fix:')) return description;
  return null;
}

// Map a single v1 group (1+ rows sharing a group key) to a v2 event group.
// Returns a MapperOutcome describing whether the row(s) were successfully
// translated, deferred (known shape, not yet implemented), or malformed.
export function mapV1GroupToV2Event(
  groupKey: string,
  rows: V1LedgerRow[],
): MapperOutcome {
  const ids = rows.map((r) => r.id);

  // ── G1: invoice.paid ───────────────────────────────────────────────
  // v1: creator+earning row (creator share) + creator+platform_fee row
  //     (platform share). Description: stripe_event:<eventId>[:charge:<cid>]
  //     :creator_share[:legacy_destination] (and platform_fee mirror).
  // v2: 3 entries — stripe_clearing debit (synthesized) + creator credit
  //     + platform_revenue credit. event_type EARNING_GROSS on all three.
  if (groupKey.startsWith('stripe_event:')) {
    const creatorShareRow = rows.find(
      (r) => r.type === 'earning' && r.description?.includes(':creator_share') && r.amountCents > 0,
    );
    const platformShareRow = rows.find(
      (r) => r.type === 'platform_fee' && r.description?.includes(':platform_fee') && r.amountCents > 0,
    );
    if (creatorShareRow && platformShareRow) {
      const isLegacy = (creatorShareRow.description ?? '').endsWith(':legacy_destination');
      const gross = BigInt(creatorShareRow.amountCents + platformShareRow.amountCents);
      const creatorShare = BigInt(creatorShareRow.amountCents);
      const platformShare = BigInt(platformShareRow.amountCents);
      // Extract identifying fields from groupKey + description so the v2
      // entries carry the SAME Stripe-anchor information that the live
      // shadow-write supplies. Without this, the divergence check would
      // false-positive whenever shadow-write and MIG-1 cross paths.
      const stripeEventId = groupKey.slice('stripe_event:'.length);
      const chargeMatch = (creatorShareRow.description ?? '').match(/:charge:([^:]+)/);
      const chargeId = chargeMatch ? chargeMatch[1] : null;
      const legacyMeta: Record<string, unknown> = isLegacy
        ? { legacy_destination: true, source: 'v1-backfill' }
        : { source: 'v1-backfill' };

      const entries: LedgerEntryInput[] = [
        {
          accountScope: 'stripe_clearing',
          accountId: 'platform',
          eventType: 'EARNING_GROSS',
          debitMinorUnits: gross,
          creditMinorUnits: 0n,
          currency: 'USD',
          idempotencySuffix: 'stripe_clearing',
          stripeObjectKind: 'charge',
          stripeObjectId: chargeId,
          stripeEventId,
          metadata: legacyMeta,
        },
        {
          accountScope: 'creator',
          accountId: creatorShareRow.creatorUserId,
          eventType: 'EARNING_GROSS',
          debitMinorUnits: 0n,
          creditMinorUnits: creatorShare,
          currency: 'USD',
          idempotencySuffix: 'creator_share',
          stripeObjectKind: 'charge',
          stripeObjectId: chargeId,
          stripeEventId,
          metadata: legacyMeta,
        },
        {
          accountScope: 'platform_revenue',
          accountId: 'platform',
          eventType: 'EARNING_GROSS',
          debitMinorUnits: 0n,
          creditMinorUnits: platformShare,
          currency: 'USD',
          idempotencySuffix: 'platform_revenue',
          stripeObjectKind: 'charge',
          stripeObjectId: chargeId,
          stripeEventId,
          metadata: legacyMeta,
        },
      ];

      return {
        kind: 'mapped',
        shape: 'G1.invoice.paid' + (isLegacy ? ':legacy_destination' : ''),
        v1RowIds: ids,
        event: {
          eventGroupId: v1KeyToEventGroupId(groupKey),
          effectiveAt: creatorShareRow.createdAt,
          postedBy: 'migration:mig-1-backfill-v1',
          entries,
        },
      };
    }

    // G2 refund: 2 rows. type='refund' (negative) + type='platform_fee'
    // (negative). Description suffixes :refund_creator / :refund_platform.
    const refundCreatorRow = rows.find(
      (r) => r.type === 'refund' && r.description?.includes(':refund_creator'),
    );
    const refundPlatformRow = rows.find(
      (r) => r.type === 'platform_fee' && r.description?.includes(':refund_platform'),
    );
    if (refundCreatorRow && refundPlatformRow) {
      const creatorDebit = BigInt(Math.abs(refundCreatorRow.amountCents));
      const platformDebit = BigInt(Math.abs(refundPlatformRow.amountCents));
      const stripeCredit = creatorDebit + platformDebit;
      return {
        kind: 'mapped',
        shape: 'G2.charge.refunded',
        v1RowIds: ids,
        event: {
          eventGroupId: v1KeyToEventGroupId(groupKey),
          effectiveAt: refundCreatorRow.createdAt,
          postedBy: 'migration:mig-1-backfill-v1',
          entries: [
            {
              accountScope: 'stripe_clearing', accountId: 'platform', eventType: 'EARNING_REFUNDED',
              debitMinorUnits: 0n, creditMinorUnits: stripeCredit, currency: 'USD',
              idempotencySuffix: 'stripe_clearing',
            },
            {
              accountScope: 'creator', accountId: refundCreatorRow.creatorUserId, eventType: 'EARNING_REFUNDED',
              debitMinorUnits: creatorDebit, creditMinorUnits: 0n, currency: 'USD',
              idempotencySuffix: 'creator_refund',
            },
            {
              accountScope: 'platform_revenue', accountId: 'platform', eventType: 'PLATFORM_FEE_REFUNDED',
              debitMinorUnits: platformDebit, creditMinorUnits: 0n, currency: 'USD',
              idempotencySuffix: 'platform_refund',
            },
          ],
        },
      };
    }

    // ── G4: charge.dispute.closed (won) ───────────────────────────────
    // v1: dispute_fee_reversal (always, type=earning +1500) +
    //     dispute_won_restore_creator (optional, type=earning, |original|) +
    //     dispute_won_restore_platform (optional, type=platform_fee, |original|)
    // v2: stripe_clearing debit (sum of restored amounts) + creator credit
    //     (fee+creator restore) + optional platform_revenue credit
    //     (platform restore). eventType RESTORE_AFTER_DISPUTE_WON on all.
    //
    // Detect BEFORE G3 because the dispute_fee_reversal description contains
    // the substring `dispute_fee` (but with `_reversal` suffix). Matching
    // G4 first avoids the false-positive on G3's dispute_fee detector.
    const feeReversalRow = rows.find(
      (r) => r.type === 'earning' && r.description?.includes(':dispute_fee_reversal'),
    );
    const restoreCreatorRow = rows.find(
      (r) =>
        r.type === 'earning' &&
        r.description?.includes(':dispute_won_restore_creator'),
    );
    const restorePlatformRow = rows.find(
      (r) =>
        r.type === 'platform_fee' &&
        r.description?.includes(':dispute_won_restore_platform'),
    );
    if (feeReversalRow || restoreCreatorRow || restorePlatformRow) {
      // dispute_fee_reversal is the always-written anchor row in v1.
      // If we have restore rows without it, v1 was in an unexpected state.
      if (!feeReversalRow) {
        return {
          kind: 'malformed',
          reason: 'G4 dispute_won: restore rows present but no dispute_fee_reversal anchor',
          v1RowIds: ids,
        };
      }
      const creatorUserId = feeReversalRow.creatorUserId;
      const stripeEventId = groupKey.slice('stripe_event:'.length);
      const chargeMatch =
        (restoreCreatorRow?.description ?? restorePlatformRow?.description ?? '').match(
          /:charge:([^:]+):/,
        );
      const chargeId = chargeMatch ? chargeMatch[1] : null;

      const feeAmount = BigInt(Math.abs(feeReversalRow.amountCents));
      const creatorRestoreAmount = restoreCreatorRow
        ? BigInt(Math.abs(restoreCreatorRow.amountCents))
        : 0n;
      const platformRestoreAmount = restorePlatformRow
        ? BigInt(Math.abs(restorePlatformRow.amountCents))
        : 0n;
      const stripeDebit = feeAmount + creatorRestoreAmount + platformRestoreAmount;
      const creatorCredit = feeAmount + creatorRestoreAmount;

      const sharedMeta: Record<string, unknown> = { source: 'v1-backfill' };
      const entries: LedgerEntryInput[] = [
        {
          accountScope: 'stripe_clearing',
          accountId: 'platform',
          eventType: 'RESTORE_AFTER_DISPUTE_WON',
          debitMinorUnits: stripeDebit,
          creditMinorUnits: 0n,
          currency: 'USD',
          idempotencySuffix: 'stripe_clearing',
          stripeObjectKind: 'dispute',
          stripeObjectId: chargeId,
          stripeEventId,
          metadata: sharedMeta,
        },
        {
          accountScope: 'creator',
          accountId: creatorUserId,
          eventType: 'RESTORE_AFTER_DISPUTE_WON',
          debitMinorUnits: 0n,
          creditMinorUnits: creatorCredit,
          currency: 'USD',
          idempotencySuffix: 'creator',
          stripeObjectKind: 'dispute',
          stripeObjectId: chargeId,
          stripeEventId,
          metadata: sharedMeta,
        },
      ];
      if (platformRestoreAmount > 0n) {
        entries.push({
          accountScope: 'platform_revenue',
          accountId: 'platform',
          eventType: 'RESTORE_AFTER_DISPUTE_WON',
          debitMinorUnits: 0n,
          creditMinorUnits: platformRestoreAmount,
          currency: 'USD',
          idempotencySuffix: 'platform',
          stripeObjectKind: 'dispute',
          stripeObjectId: chargeId,
          stripeEventId,
          metadata: sharedMeta,
        });
      }
      return {
        kind: 'mapped',
        shape: 'G4.dispute.closed_won',
        v1RowIds: ids,
        event: {
          eventGroupId: v1KeyToEventGroupId(groupKey),
          effectiveAt: feeReversalRow.createdAt,
          postedBy: 'migration:mig-1-backfill-v1',
          entries,
        },
      };
    }

    // ── G3: charge.dispute.created ────────────────────────────────────
    // v1: dispute_fee (always, type=refund -1500) +
    //     dispute_clawback_creator (optional, type=refund, -clawback) +
    //     dispute_clawback_platform (optional, type=platform_fee, -clawback)
    // v2: stripe_clearing credit (sum of all amounts pulled back to Stripe)
    //     + creator debit (fee + creator clawback) + optional
    //     platform_revenue debit (platform clawback). eventType
    //     DISPUTE_FROZEN on all.
    //
    // The dispute_fee match must use `:dispute_fee:` with trailing colon
    // so it doesn't accidentally match `:dispute_fee_reversal` (G4 path
    // above already short-circuited on that, but defense-in-depth).
    const disputeFeeRow = rows.find(
      (r) =>
        r.type === 'refund' &&
        r.description?.includes(':dispute_fee:') &&
        !r.description?.includes('dispute_fee_reversal'),
    );
    const clawbackCreatorRow = rows.find(
      (r) =>
        r.type === 'refund' &&
        r.description?.includes(':dispute_clawback_creator'),
    );
    const clawbackPlatformRow = rows.find(
      (r) =>
        r.type === 'platform_fee' &&
        r.description?.includes(':dispute_clawback_platform'),
    );
    if (disputeFeeRow || clawbackCreatorRow || clawbackPlatformRow) {
      // dispute_fee is the always-written anchor row in v1. Clawback rows
      // without the fee anchor mean v1 was in an unexpected state.
      if (!disputeFeeRow) {
        return {
          kind: 'malformed',
          reason: 'G3 dispute.created: clawback rows present but no dispute_fee anchor',
          v1RowIds: ids,
        };
      }
      const creatorUserId = disputeFeeRow.creatorUserId;
      const stripeEventId = groupKey.slice('stripe_event:'.length);
      const chargeMatch =
        (clawbackCreatorRow?.description ?? clawbackPlatformRow?.description ?? '').match(
          /:charge:([^:]+):/,
        );
      const chargeId = chargeMatch ? chargeMatch[1] : null;

      const feeAmount = BigInt(Math.abs(disputeFeeRow.amountCents));
      const creatorClawbackAmount = clawbackCreatorRow
        ? BigInt(Math.abs(clawbackCreatorRow.amountCents))
        : 0n;
      const platformClawbackAmount = clawbackPlatformRow
        ? BigInt(Math.abs(clawbackPlatformRow.amountCents))
        : 0n;
      const stripeCredit = feeAmount + creatorClawbackAmount + platformClawbackAmount;
      const creatorDebit = feeAmount + creatorClawbackAmount;

      const sharedMeta: Record<string, unknown> = { source: 'v1-backfill' };
      const entries: LedgerEntryInput[] = [
        {
          accountScope: 'stripe_clearing',
          accountId: 'platform',
          eventType: 'DISPUTE_FROZEN',
          debitMinorUnits: 0n,
          creditMinorUnits: stripeCredit,
          currency: 'USD',
          idempotencySuffix: 'stripe_clearing',
          stripeObjectKind: 'dispute',
          stripeObjectId: chargeId,
          stripeEventId,
          metadata: sharedMeta,
        },
        {
          accountScope: 'creator',
          accountId: creatorUserId,
          eventType: 'DISPUTE_FROZEN',
          debitMinorUnits: creatorDebit,
          creditMinorUnits: 0n,
          currency: 'USD',
          idempotencySuffix: 'creator',
          stripeObjectKind: 'dispute',
          stripeObjectId: chargeId,
          stripeEventId,
          metadata: sharedMeta,
        },
      ];
      if (platformClawbackAmount > 0n) {
        entries.push({
          accountScope: 'platform_revenue',
          accountId: 'platform',
          eventType: 'DISPUTE_FROZEN',
          debitMinorUnits: platformClawbackAmount,
          creditMinorUnits: 0n,
          currency: 'USD',
          idempotencySuffix: 'platform',
          stripeObjectKind: 'dispute',
          stripeObjectId: chargeId,
          stripeEventId,
          metadata: sharedMeta,
        });
      }
      return {
        kind: 'mapped',
        shape: 'G3.dispute.created',
        v1RowIds: ids,
        event: {
          eventGroupId: v1KeyToEventGroupId(groupKey),
          effectiveAt: disputeFeeRow.createdAt,
          postedBy: 'migration:mig-1-backfill-v1',
          entries,
        },
      };
    }

    return {
      kind: 'malformed',
      reason: `stripe_event group with unrecognized v1 row shape: ${rows.map((r) => `${r.type}:${r.description}`).join(' | ')}`,
      v1RowIds: ids,
    };
  }

  // ── G5a: payout requested (single row) ─────────────────────────────
  // v1: creator+payout row, positive amountCents, description='payout:<id>'.
  // v2: 2 entries — creator debit (outflow), stripe_clearing credit.
  if (groupKey.startsWith('payout:')) {
    if (rows.length !== 1) {
      return { kind: 'malformed', reason: 'payout group should have exactly 1 row', v1RowIds: ids };
    }
    const row = rows[0];
    if (row.type !== 'payout' || row.amountCents <= 0) {
      return { kind: 'malformed', reason: 'payout row must have type=payout and amountCents>0', v1RowIds: ids };
    }
    const amount = BigInt(row.amountCents);
    return {
      kind: 'mapped',
      shape: 'G5a.payout',
      v1RowIds: ids,
      event: {
        eventGroupId: v1KeyToEventGroupId(groupKey),
        effectiveAt: row.createdAt,
        postedBy: 'migration:mig-1-backfill-v1',
        entries: [
          {
            accountScope: 'creator', accountId: row.creatorUserId, eventType: 'PAYOUT_INITIATED',
            debitMinorUnits: amount, creditMinorUnits: 0n, currency: 'USD',
            idempotencySuffix: 'creator_payout',
          },
          {
            accountScope: 'stripe_clearing', accountId: 'platform', eventType: 'PAYOUT_INITIATED',
            debitMinorUnits: 0n, creditMinorUnits: amount, currency: 'USD',
            idempotencySuffix: 'stripe_clearing',
          },
        ],
      },
    };
  }

  // ── G5b: payout_reversal (Stripe transfer failed at the API) ────────
  // v1: creator+earning row, positive (restoring balance), description='payout_reversal:<id>'.
  if (groupKey.startsWith('payout_reversal:')) {
    if (rows.length !== 1) {
      return { kind: 'malformed', reason: 'payout_reversal group should have exactly 1 row', v1RowIds: ids };
    }
    const row = rows[0];
    if (row.amountCents <= 0) {
      return { kind: 'malformed', reason: 'payout_reversal row must have positive amountCents', v1RowIds: ids };
    }
    // Defensive abs() — if a historical row was incorrectly written negative
    // it would propagate to creditMinorUnits and trip assertInv1 in v2.
    const amount = BigInt(Math.abs(row.amountCents));
    return {
      kind: 'mapped',
      shape: 'G5b.payout_reversal',
      v1RowIds: ids,
      event: {
        eventGroupId: v1KeyToEventGroupId(groupKey),
        effectiveAt: row.createdAt,
        postedBy: 'migration:mig-1-backfill-v1',
        entries: [
          {
            accountScope: 'creator', accountId: row.creatorUserId, eventType: 'PAYOUT_FAILED',
            debitMinorUnits: 0n, creditMinorUnits: amount, currency: 'USD',
            idempotencySuffix: 'creator_restore',
          },
          {
            accountScope: 'stripe_clearing', accountId: 'platform', eventType: 'PAYOUT_FAILED',
            debitMinorUnits: amount, creditMinorUnits: 0n, currency: 'USD',
            idempotencySuffix: 'stripe_clearing',
          },
        ],
      },
    };
  }

  // ── G5c: transfer.reversed (post-payout reversal) ───────────────────
  if (groupKey.startsWith('transfer_reversed:')) {
    if (rows.length !== 1) {
      return { kind: 'malformed', reason: 'transfer_reversed group should have exactly 1 row', v1RowIds: ids };
    }
    const row = rows[0];
    if (row.amountCents <= 0) {
      return { kind: 'malformed', reason: 'transfer_reversed row must have positive amountCents', v1RowIds: ids };
    }
    const amount = BigInt(Math.abs(row.amountCents));
    return {
      kind: 'mapped',
      shape: 'G5c.transfer.reversed',
      v1RowIds: ids,
      event: {
        eventGroupId: v1KeyToEventGroupId(groupKey),
        effectiveAt: row.createdAt,
        postedBy: 'migration:mig-1-backfill-v1',
        entries: [
          {
            accountScope: 'creator', accountId: row.creatorUserId, eventType: 'PAYOUT_REVERSED',
            debitMinorUnits: 0n, creditMinorUnits: amount, currency: 'USD',
            idempotencySuffix: 'creator_restore',
          },
          {
            accountScope: 'stripe_clearing', accountId: 'platform', eventType: 'PAYOUT_REVERSED',
            debitMinorUnits: amount, creditMinorUnits: 0n, currency: 'USD',
            idempotencySuffix: 'stripe_clearing',
          },
        ],
      },
    };
  }

  // ── G6: admin_fix ─────────────────────────────────────────────────
  // Deferred: no Stripe anchor; needs an adjustment account that the
  // current chart of accounts doesn't have. Architecture work required.
  if (groupKey.startsWith('admin_fix:')) {
    return { kind: 'deferred', reason: 'G6.admin_fix — needs adjustment account in chart of accounts', v1RowIds: ids };
  }

  return { kind: 'malformed', reason: `Unrecognized group key: ${groupKey}`, v1RowIds: ids };
}

// Bucket v1 rows by group key. Returns a Map<groupKey, rows[]> plus a list
// of unbucketed rows (description didn't match any known shape).
export function bucketV1Rows(rows: V1LedgerRow[]): {
  groups: Map<string, V1LedgerRow[]>;
  unbucketed: V1LedgerRow[];
} {
  const groups = new Map<string, V1LedgerRow[]>();
  const unbucketed: V1LedgerRow[] = [];
  for (const row of rows) {
    const key = v1DescriptionToGroupKey(row.description);
    if (!key) {
      unbucketed.push(row);
      continue;
    }
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  return { groups, unbucketed };
}

// Re-export randomUUID so callers (tests, the backfill CLI) can stay on
// one import surface for crypto utilities.
export { randomUUID };
