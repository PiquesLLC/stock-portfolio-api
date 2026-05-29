// Shadow-write for G5b — payout_reversal (Stripe transfer.create failed at
// the API). v1 writes a creator-credit earning row to restore the balance.
//
// MIG-1 G5b convergence:
//   eventGroupId = v1KeyToEventGroupId('payout_reversal:<id>')
//   eventType    = PAYOUT_FAILED
//   suffixes     = 'creator_restore' + 'stripe_clearing'

import { postTransaction } from '../ledger';
import { LedgerEntryInput, PostTransactionInput } from '../ledger/types';
import { v1KeyToEventGroupId } from '../migration/v1-to-v2-mapper';

export interface ShadowWritePayoutFailedArgs {
  /** The v1 CreatorPayout id (description segment used by v1). */
  payoutId: string;
  creatorUserId: string;
  amountCents: number;
  effectiveAt: Date;
}

export async function shadowWritePayoutFailed(
  args: ShadowWritePayoutFailedArgs,
): Promise<void> {
  if (process.env.V2_SHADOW_WRITE_ENABLED !== 'true') return;
  if (args.amountCents <= 0) {
    console.warn(
      `[v2-shadow] payout-failed skipped — non-positive amount ${args.amountCents}`,
    );
    return;
  }

  const minEffectiveAt = new Date(Date.now() - 720 * 24 * 60 * 60 * 1000);
  const effectiveAt =
    args.effectiveAt > minEffectiveAt ? args.effectiveAt : minEffectiveAt;

  const amount = BigInt(args.amountCents);
  const sharedMeta: Record<string, unknown> = { source: 'v2-shadow-write' };

  const entries: LedgerEntryInput[] = [
    {
      accountScope: 'creator',
      accountId: args.creatorUserId,
      eventType: 'PAYOUT_FAILED',
      debitMinorUnits: 0n,
      creditMinorUnits: amount,
      currency: 'USD',
      idempotencySuffix: 'creator_restore',
      metadata: sharedMeta,
    },
    {
      accountScope: 'stripe_clearing',
      accountId: 'platform',
      eventType: 'PAYOUT_FAILED',
      debitMinorUnits: amount,
      creditMinorUnits: 0n,
      currency: 'USD',
      idempotencySuffix: 'stripe_clearing',
      metadata: sharedMeta,
    },
  ];

  const input: PostTransactionInput = {
    eventGroupId: v1KeyToEventGroupId('payout_reversal:' + args.payoutId),
    effectiveAt,
    postedBy: 'api:request-payout',
    entries,
  };

  try {
    const result = await postTransaction(input);
    if (result.deduplicated) {
      console.info(
        `[v2-shadow] payout-failed dedup eventGroupId=${input.eventGroupId} payoutId=${args.payoutId}`,
      );
    } else {
      console.info(
        `[v2-shadow] payout-failed posted eventGroupId=${input.eventGroupId} payoutId=${args.payoutId}`,
      );
    }
  } catch (err) {
    console.warn(
      `[v2-shadow] payout-failed POST FAILED (v1 unaffected) ` +
        `payoutId=${args.payoutId}: ${(err as Error).message}`,
    );
  }
}
