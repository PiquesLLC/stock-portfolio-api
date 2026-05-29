// Shadow-write the v2 ledger alongside v1 for payout requests (G5a).
//
// G5a is NOT a webhook — it's the API endpoint `requestPayout`. v1 writes
// one creator+payout ledger row inside a Serializable transaction; the
// shadow-write fires AFTER the v1 transaction commits and AFTER the Stripe
// transfer attempt completes (success or failure). On failure, the G5b
// helper (payout-failed) fires its own restoring entry.
//
// MIG-1 G5a convergence: eventGroupId = v1KeyToEventGroupId('payout:<id>')
// eventType = PAYOUT_INITIATED, suffixes: 'creator_payout' + 'stripe_clearing'.

import { postTransaction } from '../ledger';
import { LedgerEntryInput, PostTransactionInput } from '../ledger/types';
import { v1KeyToEventGroupId } from '../migration/v1-to-v2-mapper';

export interface ShadowWritePayoutRequestedArgs {
  /** The v1 CreatorPayout id (also the description-segment used by v1). */
  payoutId: string;
  creatorUserId: string;
  amountCents: number;
  effectiveAt: Date;
}

export async function shadowWritePayoutRequested(
  args: ShadowWritePayoutRequestedArgs,
): Promise<void> {
  if (process.env.V2_SHADOW_WRITE_ENABLED !== 'true') return;

  if (args.amountCents <= 0) {
    console.warn(
      `[v2-shadow] payout-requested skipped — non-positive amount ${args.amountCents}`,
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
      eventType: 'PAYOUT_INITIATED',
      debitMinorUnits: amount,
      creditMinorUnits: 0n,
      currency: 'USD',
      idempotencySuffix: 'creator_payout',
      metadata: sharedMeta,
    },
    {
      accountScope: 'stripe_clearing',
      accountId: 'platform',
      eventType: 'PAYOUT_INITIATED',
      debitMinorUnits: 0n,
      creditMinorUnits: amount,
      currency: 'USD',
      idempotencySuffix: 'stripe_clearing',
      metadata: sharedMeta,
    },
  ];

  const input: PostTransactionInput = {
    eventGroupId: v1KeyToEventGroupId('payout:' + args.payoutId),
    effectiveAt,
    postedBy: 'api:request-payout',
    entries,
  };

  try {
    const result = await postTransaction(input);
    if (result.deduplicated) {
      console.info(
        `[v2-shadow] payout-requested dedup eventGroupId=${input.eventGroupId} payoutId=${args.payoutId}`,
      );
    } else {
      console.info(
        `[v2-shadow] payout-requested posted eventGroupId=${input.eventGroupId} payoutId=${args.payoutId}`,
      );
    }
  } catch (err) {
    console.warn(
      `[v2-shadow] payout-requested POST FAILED (v1 unaffected) ` +
        `payoutId=${args.payoutId}: ${(err as Error).message}`,
    );
  }
}
