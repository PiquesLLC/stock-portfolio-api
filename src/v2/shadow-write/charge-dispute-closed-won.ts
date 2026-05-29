// Shadow-write the v2 ledger alongside v1 for charge.dispute.closed (won)
// events. Mirror of charge-dispute-created.ts in the restoring direction.
//
// Locks in the scheme designed in commit a49af9a for MIG-1 G4:
//   eventType         : RESTORE_AFTER_DISPUTE_WON
//   idempotencySuffix : 'stripe_clearing' / 'creator_restore' / 'platform_restore'
//   metadata          : component breakdown

import { postTransaction } from '../ledger';
import { LedgerEntryInput, PostTransactionInput } from '../ledger/types';
import { v1KeyToEventGroupId } from '../migration/v1-to-v2-mapper';

export interface ShadowWriteChargeDisputeClosedWonArgs {
  stripeEventId: string;
  stripeChargeId: string;
  creatorUserId: string;
  /** Dispute fee restored to creator (1500 cents in v1 today). */
  feeReversalCents: number;
  /** Creator-side restore (0 if no prior G3 creator-clawback). */
  creatorRestoreCents: number;
  /** Platform-side restore (0 if no prior G3 platform-clawback). */
  platformRestoreCents: number;
  effectiveAt: Date;
}

function stripeEventToV2EventGroupId(stripeEventId: string): string {
  return v1KeyToEventGroupId('stripe_event:' + stripeEventId);
}

/**
 * Fire-and-await shadow-write of a charge.dispute.closed (won) event.
 * Should only be invoked when dispute.status === 'won'.
 */
export async function shadowWriteChargeDisputeClosedWon(
  args: ShadowWriteChargeDisputeClosedWonArgs,
): Promise<void> {
  if (process.env.V2_SHADOW_WRITE_ENABLED !== 'true') return;

  if (args.feeReversalCents <= 0) {
    console.warn(
      `[v2-shadow] charge.dispute.closed-won skipped — invalid fee_reversal ${args.feeReversalCents}`,
    );
    return;
  }
  if (args.creatorRestoreCents < 0 || args.platformRestoreCents < 0) {
    console.warn(
      `[v2-shadow] charge.dispute.closed-won skipped — negative restore ` +
        `creator=${args.creatorRestoreCents} platform=${args.platformRestoreCents}`,
    );
    return;
  }

  const minEffectiveAt = new Date(Date.now() - 720 * 24 * 60 * 60 * 1000);
  const effectiveAt =
    args.effectiveAt > minEffectiveAt ? args.effectiveAt : minEffectiveAt;

  const feeReversal = BigInt(args.feeReversalCents);
  const creatorRestore = BigInt(args.creatorRestoreCents);
  const platformRestore = BigInt(args.platformRestoreCents);
  const stripeDebit = feeReversal + creatorRestore + platformRestore;
  const creatorCredit = feeReversal + creatorRestore;

  const sharedMeta: Record<string, unknown> = {
    source: 'v2-shadow-write',
    fee_reversal_cents: Number(feeReversal),
    creator_restore_cents: Number(creatorRestore),
    platform_restore_cents: Number(platformRestore),
  };

  const stripeObjectId = args.stripeChargeId || null;

  const entries: LedgerEntryInput[] = [
    {
      accountScope: 'stripe_clearing',
      accountId: 'platform',
      eventType: 'RESTORE_AFTER_DISPUTE_WON',
      debitMinorUnits: stripeDebit,
      creditMinorUnits: 0n,
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
      eventType: 'RESTORE_AFTER_DISPUTE_WON',
      debitMinorUnits: 0n,
      creditMinorUnits: creatorCredit,
      currency: 'USD',
      idempotencySuffix: 'creator_restore',
      stripeObjectKind: 'charge',
      stripeObjectId,
      stripeEventId: args.stripeEventId,
      metadata: sharedMeta,
    },
  ];

  if (platformRestore > 0n) {
    entries.push({
      accountScope: 'platform_revenue',
      accountId: 'platform',
      eventType: 'RESTORE_AFTER_DISPUTE_WON',
      debitMinorUnits: 0n,
      creditMinorUnits: platformRestore,
      currency: 'USD',
      idempotencySuffix: 'platform_restore',
      stripeObjectKind: 'charge',
      stripeObjectId,
      stripeEventId: args.stripeEventId,
      metadata: sharedMeta,
    });
  }

  const input: PostTransactionInput = {
    eventGroupId: stripeEventToV2EventGroupId(args.stripeEventId),
    effectiveAt,
    postedBy: 'webhook:charge.dispute.closed',
    entries,
  };

  try {
    const result = await postTransaction(input);
    if (result.deduplicated) {
      console.info(
        `[v2-shadow] charge.dispute.closed-won dedup eventGroupId=${input.eventGroupId} ` +
          `stripeEventId=${args.stripeEventId}`,
      );
    } else {
      console.info(
        `[v2-shadow] charge.dispute.closed-won posted eventGroupId=${input.eventGroupId} ` +
          `stripeEventId=${args.stripeEventId} entries=${result.entries.length}`,
      );
    }
  } catch (err) {
    console.warn(
      `[v2-shadow] charge.dispute.closed-won POST FAILED (v1 unaffected) ` +
        `stripeEventId=${args.stripeEventId}: ${(err as Error).message}`,
    );
  }
}
