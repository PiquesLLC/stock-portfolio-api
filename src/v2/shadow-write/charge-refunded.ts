// Shadow-write the v2 ledger alongside v1 for charge.refunded events.
//
// Mirrors the shape and gating of `invoice-paid.ts`. The only meaningful
// shape differences:
//   - 3 entries with mixed event_types: EARNING_REFUNDED on stripe_clearing
//     + creator side; PLATFORM_FEE_REFUNDED on platform_revenue side.
//   - Idempotency suffix scheme MATCHES MIG-1 G2 exactly:
//     stripe_clearing, creator_refund, platform_refund. Future drift
//     between this writer and the mapper would cause CRITICAL throws on
//     cross-writer convergence via post-transaction.ts's intent-divergence
//     check.
//   - Amounts are INCREMENTAL (per-event delta, not cumulative). The v1
//     handler computes incrementals; the caller passes them through.

import { postTransaction } from '../ledger';
import { LedgerEntryInput, PostTransactionInput } from '../ledger/types';
import { v1KeyToEventGroupId } from '../migration/v1-to-v2-mapper';

export interface ShadowWriteChargeRefundedArgs {
  /** The Stripe event id. */
  stripeEventId: string;
  /** Stripe Charge id (always present on charge.refunded). */
  stripeChargeId: string;
  /** The creator's user id (from the v1 sub lookup). */
  creatorUserId: string;
  /** INCREMENTAL creator-side refund in cents (positive). */
  incrementalCreatorCents: number;
  /** INCREMENTAL platform-side refund in cents (positive; can be 0). */
  incrementalPlatformCents: number;
  /** When the event was economically real (Stripe's event.created). */
  effectiveAt: Date;
}

function stripeEventToV2EventGroupId(stripeEventId: string): string {
  return v1KeyToEventGroupId('stripe_event:' + stripeEventId);
}

/**
 * Fire-and-await shadow-write of a charge.refunded event. Wraps
 * postTransaction in a try/catch and logs failures as warnings without
 * propagating. Safe to call from any v1 webhook commit success path.
 *
 * Gated by `V2_SHADOW_WRITE_ENABLED === 'true'`.
 */
export async function shadowWriteChargeRefunded(args: ShadowWriteChargeRefundedArgs): Promise<void> {
  if (process.env.V2_SHADOW_WRITE_ENABLED !== 'true') return;

  if (args.incrementalCreatorCents <= 0) {
    // No incremental creator refund means v1 already accounted for it
    // (its handler short-circuits on this case). Nothing to mirror.
    return;
  }
  if (args.incrementalPlatformCents < 0) {
    console.warn(
      `[v2-shadow] charge.refunded skipped — negative platform increment ` +
        `${args.incrementalPlatformCents}`,
    );
    return;
  }

  // Same clamp as invoice-paid: defend against Stripe "Resend event"
  // backdated payloads. 720d gives a 10-day buffer under postTransaction's
  // 730d max-past rejection.
  const minEffectiveAt = new Date(Date.now() - 720 * 24 * 60 * 60 * 1000);
  const effectiveAt =
    args.effectiveAt > minEffectiveAt ? args.effectiveAt : minEffectiveAt;

  const creatorDebit = BigInt(args.incrementalCreatorCents);
  const platformDebit = BigInt(args.incrementalPlatformCents);
  const stripeCredit = creatorDebit + platformDebit;

  const sharedMeta: Record<string, unknown> = { source: 'v2-shadow-write' };

  const entries: LedgerEntryInput[] = [
    {
      accountScope: 'stripe_clearing',
      accountId: 'platform',
      eventType: 'EARNING_REFUNDED',
      debitMinorUnits: 0n,
      creditMinorUnits: stripeCredit,
      currency: 'USD',
      idempotencySuffix: 'stripe_clearing',
      stripeObjectKind: 'charge',
      stripeObjectId: args.stripeChargeId || null,
      stripeEventId: args.stripeEventId,
      metadata: sharedMeta,
    },
    {
      accountScope: 'creator',
      accountId: args.creatorUserId,
      eventType: 'EARNING_REFUNDED',
      debitMinorUnits: creatorDebit,
      creditMinorUnits: 0n,
      currency: 'USD',
      idempotencySuffix: 'creator_refund',
      stripeObjectKind: 'charge',
      stripeObjectId: args.stripeChargeId || null,
      stripeEventId: args.stripeEventId,
      metadata: sharedMeta,
    },
  ];

  if (platformDebit > 0n) {
    entries.push({
      accountScope: 'platform_revenue',
      accountId: 'platform',
      eventType: 'PLATFORM_FEE_REFUNDED',
      debitMinorUnits: platformDebit,
      creditMinorUnits: 0n,
      currency: 'USD',
      idempotencySuffix: 'platform_refund',
      stripeObjectKind: 'charge',
      stripeObjectId: args.stripeChargeId || null,
      stripeEventId: args.stripeEventId,
      metadata: sharedMeta,
    });
  }

  const input: PostTransactionInput = {
    eventGroupId: stripeEventToV2EventGroupId(args.stripeEventId),
    effectiveAt,
    postedBy: 'webhook:charge.refunded',
    entries,
  };

  try {
    const result = await postTransaction(input);
    if (result.deduplicated) {
      console.info(
        `[v2-shadow] charge.refunded dedup eventGroupId=${input.eventGroupId} ` +
          `stripeEventId=${args.stripeEventId}`,
      );
    } else {
      console.info(
        `[v2-shadow] charge.refunded posted eventGroupId=${input.eventGroupId} ` +
          `stripeEventId=${args.stripeEventId} entries=${result.entries.length}`,
      );
    }
  } catch (err) {
    console.warn(
      `[v2-shadow] charge.refunded POST FAILED (v1 unaffected) ` +
        `stripeEventId=${args.stripeEventId}: ${(err as Error).message}`,
    );
  }
}
