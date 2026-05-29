// Shadow-write the v2 ledger alongside v1 for charge.dispute.created events.
//
// Locks in the scheme designed in commit a49af9a for MIG-1 G3:
//   eventType         : DISPUTE_LOST
//   idempotencySuffix : 'stripe_clearing' / 'creator_clawback' / 'platform_clawback'
//   metadata          : component breakdown so reconciliation can recover
//                       "of $X debit, $1500 was Stripe dispute fee and $Y
//                       was the chargeback principal."
//
// Drift between this writer and the MIG-1 G3 mapper would trip CRITICAL on
// cross-writer convergence in postTransaction's intent-divergence check.
// The convergence test in __tests__/charge-dispute-created.test.ts fails
// CI before any production regression.

import { postTransaction } from '../ledger';
import { LedgerEntryInput, PostTransactionInput } from '../ledger/types';
import { v1KeyToEventGroupId } from '../migration/v1-to-v2-mapper';

export interface ShadowWriteChargeDisputeCreatedArgs {
  stripeEventId: string;
  /** May be empty when v1's `dispute.charge` lookup failed. */
  stripeChargeId: string;
  creatorUserId: string;
  /** Dispute fee debited from creator (1500 cents in v1 today). */
  feeAmountCents: number;
  /** Incremental creator clawback (0 if no original earning found). */
  creatorClawbackCents: number;
  /** Incremental platform clawback (0 if no original platform row found). */
  platformClawbackCents: number;
  effectiveAt: Date;
}

function stripeEventToV2EventGroupId(stripeEventId: string): string {
  return v1KeyToEventGroupId('stripe_event:' + stripeEventId);
}

/**
 * Fire-and-await shadow-write of a charge.dispute.created event. Gated by
 * V2_SHADOW_WRITE_ENABLED. Swallows all errors so v2 outage cannot break
 * the v1 webhook.
 */
export async function shadowWriteChargeDisputeCreated(
  args: ShadowWriteChargeDisputeCreatedArgs,
): Promise<void> {
  if (process.env.V2_SHADOW_WRITE_ENABLED !== 'true') return;

  if (args.feeAmountCents <= 0) {
    console.warn(
      `[v2-shadow] charge.dispute.created skipped — invalid fee ${args.feeAmountCents}`,
    );
    return;
  }
  if (args.creatorClawbackCents < 0 || args.platformClawbackCents < 0) {
    console.warn(
      `[v2-shadow] charge.dispute.created skipped — negative clawback ` +
        `creator=${args.creatorClawbackCents} platform=${args.platformClawbackCents}`,
    );
    return;
  }

  // Clamp backdated effectiveAt (same buffer as invoice-paid/charge-refunded).
  const minEffectiveAt = new Date(Date.now() - 720 * 24 * 60 * 60 * 1000);
  const effectiveAt =
    args.effectiveAt > minEffectiveAt ? args.effectiveAt : minEffectiveAt;

  const feeAmount = BigInt(args.feeAmountCents);
  const creatorClawback = BigInt(args.creatorClawbackCents);
  const platformClawback = BigInt(args.platformClawbackCents);
  const stripeCredit = feeAmount + creatorClawback + platformClawback;
  const creatorDebit = feeAmount + creatorClawback;

  const sharedMeta: Record<string, unknown> = {
    source: 'v2-shadow-write',
    dispute_fee_cents: Number(feeAmount),
    creator_clawback_cents: Number(creatorClawback),
    platform_clawback_cents: Number(platformClawback),
  };

  const stripeObjectId = args.stripeChargeId || null;

  const entries: LedgerEntryInput[] = [
    {
      accountScope: 'stripe_clearing',
      accountId: 'platform',
      eventType: 'DISPUTE_LOST',
      debitMinorUnits: 0n,
      creditMinorUnits: stripeCredit,
      currency: 'USD',
      idempotencySuffix: 'stripe_clearing',
      stripeObjectKind: 'charge',
      stripeObjectId,
      stripeEventId: args.stripeEventId,
      metadata: sharedMeta,
    },
    {
      accountScope: 'creator',
      accountId: args.creatorUserId,
      eventType: 'DISPUTE_LOST',
      debitMinorUnits: creatorDebit,
      creditMinorUnits: 0n,
      currency: 'USD',
      idempotencySuffix: 'creator_clawback',
      stripeObjectKind: 'charge',
      stripeObjectId,
      stripeEventId: args.stripeEventId,
      metadata: sharedMeta,
    },
  ];

  if (platformClawback > 0n) {
    entries.push({
      accountScope: 'platform_revenue',
      accountId: 'platform',
      eventType: 'DISPUTE_LOST',
      debitMinorUnits: platformClawback,
      creditMinorUnits: 0n,
      currency: 'USD',
      idempotencySuffix: 'platform_clawback',
      stripeObjectKind: 'charge',
      stripeObjectId,
      stripeEventId: args.stripeEventId,
      metadata: sharedMeta,
    });
  }

  const input: PostTransactionInput = {
    eventGroupId: stripeEventToV2EventGroupId(args.stripeEventId),
    effectiveAt,
    postedBy: 'webhook:charge.dispute.created',
    entries,
  };

  try {
    const result = await postTransaction(input);
    if (result.deduplicated) {
      console.info(
        `[v2-shadow] charge.dispute.created dedup eventGroupId=${input.eventGroupId} ` +
          `stripeEventId=${args.stripeEventId}`,
      );
    } else {
      console.info(
        `[v2-shadow] charge.dispute.created posted eventGroupId=${input.eventGroupId} ` +
          `stripeEventId=${args.stripeEventId} entries=${result.entries.length}`,
      );
    }
  } catch (err) {
    console.warn(
      `[v2-shadow] charge.dispute.created POST FAILED (v1 unaffected) ` +
        `stripeEventId=${args.stripeEventId}: ${(err as Error).message}`,
    );
  }
}
