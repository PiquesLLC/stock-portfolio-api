// Shadow-write for G5c — transfer.reversed webhook. v1 writes a
// creator-credit earning row to restore the balance after a post-payout
// reversal (manual ops action in Stripe dashboard or a Connect compliance
// hold).
//
// MIG-1 G5c convergence:
//   eventGroupId = v1KeyToEventGroupId('transfer_reversed:<id>')
//   eventType    = PAYOUT_REVERSED
//   suffixes     = 'creator_restore' + 'stripe_clearing'

import { postTransaction } from '../ledger';
import { LedgerEntryInput, PostTransactionInput } from '../ledger/types';
import { v1KeyToEventGroupId } from '../migration/v1-to-v2-mapper';

export interface ShadowWriteTransferReversedArgs {
  /** Stripe transferId — used both as eventGroupId namespace and stripeObjectId. */
  stripeTransferId: string;
  /** Stripe webhook event id, for observability. */
  stripeEventId: string;
  creatorUserId: string;
  amountCents: number;
  effectiveAt: Date;
}

export async function shadowWriteTransferReversed(
  args: ShadowWriteTransferReversedArgs,
): Promise<void> {
  if (process.env.V2_SHADOW_WRITE_ENABLED !== 'true') return;
  if (args.amountCents <= 0) {
    console.warn(
      `[v2-shadow] transfer-reversed skipped — non-positive amount ${args.amountCents}`,
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
      eventType: 'PAYOUT_REVERSED',
      debitMinorUnits: 0n,
      creditMinorUnits: amount,
      currency: 'USD',
      idempotencySuffix: 'creator_restore',
      stripeObjectKind: 'transfer',
      stripeObjectId: args.stripeTransferId || null,
      stripeEventId: args.stripeEventId,
      metadata: sharedMeta,
    },
    {
      accountScope: 'stripe_clearing',
      accountId: 'platform',
      eventType: 'PAYOUT_REVERSED',
      debitMinorUnits: amount,
      creditMinorUnits: 0n,
      currency: 'USD',
      idempotencySuffix: 'stripe_clearing',
      stripeObjectKind: 'transfer',
      stripeObjectId: args.stripeTransferId || null,
      stripeEventId: args.stripeEventId,
      metadata: sharedMeta,
    },
  ];

  const input: PostTransactionInput = {
    eventGroupId: v1KeyToEventGroupId('transfer_reversed:' + args.stripeTransferId),
    effectiveAt,
    postedBy: 'webhook:transfer.reversed',
    entries,
  };

  try {
    const result = await postTransaction(input);
    if (result.deduplicated) {
      console.info(
        `[v2-shadow] transfer-reversed dedup eventGroupId=${input.eventGroupId} ` +
          `transferId=${args.stripeTransferId}`,
      );
    } else {
      console.info(
        `[v2-shadow] transfer-reversed posted eventGroupId=${input.eventGroupId} ` +
          `transferId=${args.stripeTransferId}`,
      );
    }
  } catch (err) {
    console.warn(
      `[v2-shadow] transfer-reversed POST FAILED (v1 unaffected) ` +
        `transferId=${args.stripeTransferId}: ${(err as Error).message}`,
    );
  }
}
