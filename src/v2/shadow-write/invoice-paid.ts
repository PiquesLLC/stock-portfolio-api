// Shadow-write the v2 ledger alongside v1 for invoice.paid events.
//
// Purpose: exercise the v2 ledger in production at the lowest possible
// blast radius. Every successful v1 invoice.paid commit is mirrored into
// v2 as a balanced double-entry event group. v2 failures DO NOT propagate
// — they're caught and logged so v1 (the source of truth) is never
// affected by v2 instability.
//
// GATED BY:
//   process.env.V2_SHADOW_WRITE_ENABLED === 'true'
//   process.env.V2_DATABASE_URL must also be set (the v2 client throws
//     a clear error otherwise; we surface it as a non-fatal warn here).
//
// IDEMPOTENT: the event group id is a deterministic UUID v4 derived from
// the Stripe event id, so retries (Stripe re-delivery, manual replay,
// or this code firing after a v1 dedup hit) collapse to v2's
// postTransaction idempotency dedup.
//
// FAILURE SEMANTICS:
//   - Connection error / V2_DATABASE_URL missing → warn, return.
//   - postTransaction throws (validation, schema, etc.) → warn, return.
//   - Never throws to the caller. Never blocks the v1 commit.

import { postTransaction } from '../ledger';
import { LedgerEntryInput, PostTransactionInput } from '../ledger/types';
import { v1KeyToEventGroupId } from '../migration/v1-to-v2-mapper';

export interface ShadowWriteInvoicePaidArgs {
  /** The Stripe event id (event.id from the webhook payload). */
  stripeEventId: string;
  /** Stripe Invoice id (for stripeObjectId linkage). May be empty if absent. */
  stripeInvoiceId: string;
  /** Resolved Stripe charge id (via extractInvoiceChargeId). May be empty. */
  stripeChargeId: string;
  /** The creator's user id (from the v1 sub lookup). */
  creatorUserId: string;
  /** Cents going to the creator (already split by the v1 handler). */
  creatorShareCents: number;
  /** Cents going to the platform (already split by the v1 handler). */
  platformShareCents: number;
  /** True iff the v1 row was tagged :legacy_destination. */
  isLegacyDestination: boolean;
  /** When the event was economically real (Stripe's event.created). */
  effectiveAt: Date;
}

// Same derivation as MIG-1 so backfilled rows + live shadow-writes
// converge on the same eventGroupId for the same Stripe event. We import
// MIG-1's helper rather than duplicating the SHA-256 algorithm so a
// future change is enforced on both sides at compile time.
function stripeEventToV2EventGroupId(stripeEventId: string): string {
  return v1KeyToEventGroupId('stripe_event:' + stripeEventId);
}

/**
 * Fire-and-await shadow-write of an invoice.paid event into v2. Wraps
 * postTransaction in a try/catch and logs failures as warnings without
 * propagating. Safe to call from any v1 webhook commit success path.
 */
export async function shadowWriteInvoicePaid(args: ShadowWriteInvoicePaidArgs): Promise<void> {
  if (process.env.V2_SHADOW_WRITE_ENABLED !== 'true') return;

  // Defensive sanity checks — the v1 handler should have validated these,
  // but a shadow-write must never crash the caller.
  if (args.creatorShareCents <= 0 || args.platformShareCents < 0) {
    console.warn(
      `[v2-shadow] invoice.paid skipped — invalid amounts ` +
        `creator=${args.creatorShareCents} platform=${args.platformShareCents}`,
    );
    return;
  }

  // Clamp effectiveAt to within the live posting path's 730-day past-window.
  // 10-day buffer to absorb clock skew between this host and the Postgres
  // host plus the few-ms gap between this clamp and postTransaction's check.
  // Stripe's "Resend event" admin tool and migration replay tooling can emit
  // events with `event.created` from > 2 years ago; without the clamp, the
  // shadow-write would silently drop them.
  const minEffectiveAt = new Date(Date.now() - 720 * 24 * 60 * 60 * 1000);
  const effectiveAt =
    args.effectiveAt > minEffectiveAt ? args.effectiveAt : minEffectiveAt;

  const gross = BigInt(args.creatorShareCents + args.platformShareCents);
  const creatorCredit = BigInt(args.creatorShareCents);
  const platformCredit = BigInt(args.platformShareCents);

  const metadata = args.isLegacyDestination
    ? { legacy_destination: true, source: 'v2-shadow-write' }
    : { source: 'v2-shadow-write' };

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
      stripeObjectId: args.stripeChargeId || null,
      stripeEventId: args.stripeEventId,
      metadata,
    },
    {
      accountScope: 'creator',
      accountId: args.creatorUserId,
      eventType: 'EARNING_GROSS',
      debitMinorUnits: 0n,
      creditMinorUnits: creatorCredit,
      currency: 'USD',
      idempotencySuffix: 'creator_share',
      stripeObjectKind: 'charge',
      stripeObjectId: args.stripeChargeId || null,
      stripeEventId: args.stripeEventId,
      metadata,
    },
    {
      accountScope: 'platform_revenue',
      accountId: 'platform',
      eventType: 'EARNING_GROSS',
      debitMinorUnits: 0n,
      creditMinorUnits: platformCredit,
      currency: 'USD',
      idempotencySuffix: 'platform_revenue',
      stripeObjectKind: 'charge',
      stripeObjectId: args.stripeChargeId || null,
      stripeEventId: args.stripeEventId,
      metadata,
    },
  ];

  const input: PostTransactionInput = {
    eventGroupId: stripeEventToV2EventGroupId(args.stripeEventId),
    effectiveAt,
    postedBy: 'webhook:invoice.paid',
    entries,
  };

  try {
    const result = await postTransaction(input);
    if (result.deduplicated) {
      // Stripe re-delivery or backfilled by MIG-1 — fine, expected.
      console.info(
        `[v2-shadow] invoice.paid dedup eventGroupId=${input.eventGroupId} ` +
          `stripeEventId=${args.stripeEventId}`,
      );
    } else {
      console.info(
        `[v2-shadow] invoice.paid posted eventGroupId=${input.eventGroupId} ` +
          `stripeEventId=${args.stripeEventId} entries=${result.entries.length}`,
      );
    }
  } catch (err) {
    // v2 ledger failure must NEVER break v1. Log loudly so operators see
    // the regression in monitoring, but swallow.
    console.warn(
      `[v2-shadow] invoice.paid POST FAILED (v1 unaffected) ` +
        `stripeEventId=${args.stripeEventId}: ${(err as Error).message}`,
    );
  }
}
