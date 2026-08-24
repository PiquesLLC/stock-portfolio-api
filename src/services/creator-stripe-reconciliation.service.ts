import Stripe from 'stripe';
import prisma from '../utils/prisma';
import { config } from '../config';
import { payoutTransferGroup } from './creator-billing.service';
import { v1LedgerCreate, isV1WalletFrozen } from './v1-wallet-freeze';

// Lookback covers settlement-tail and webhook-retry slack. 48h was chosen
// because Stripe transfer `created` timestamps and our local `updatedAt`
// can drift by 10-30 minutes across timezone-edge cases / webhook retries;
// keeping the local window 6h WIDER than Stripe's makes window-edge
// false-positive missingTransfers extremely rare.
const LOOKBACK_WINDOW_HOURS = 48;
// Safety bound: bail rather than OOM the process if Stripe ever returns
// an unexpectedly huge list (e.g. someone enabled monetization without
// the kill switch and dumped 50k transfers in a day).
const MAX_ITEMS_PER_LIST = 10_000;
// Cap the array samples we persist in the MonitoringReport JSON column so
// one runaway day doesn't blow out the row size. Counts are always preserved.
const REPORT_ARRAY_CAP = 50;

type GhostTransfer = {
  id: string;
  amountCents: number;
  destination: string | null;
  createdAt: string;
};

type MissingTransfer = {
  payoutId: string;
  creatorUserId: string;
  stripeTransferId: string;
  amountCents: number;
  status: string;
};

type AmountMismatch = {
  transferId: string;
  stripeAmountCents: number;
  localAmountCents: number;
  creatorUserId: string;
};

type ReversedMismatch = {
  transferId: string;
  stripeReversed: boolean;
  localStatus: string;
};

type ChargeDrift =
  | { kind: 'missing_pair'; chargeId: string; haveEarning: boolean; havePlatformFee: boolean }
  | { kind: 'amount_mismatch'; chargeId: string; stripeAmountCents: number; ledgerGrossCents: number };

export type CreatorStripeReconciliationReport = {
  checkedAt: Date;
  windowHours: number;
  transfers: {
    stripeCount: number;
    localCount: number;
    ghostTransfers: GhostTransfer[];
    missingTransfers: MissingTransfer[];
    amountMismatches: AmountMismatch[];
    reversedMismatches: ReversedMismatch[];
    /** F-1: payouts stranded 'pending' with no transfer id, and how each resolved. */
    strandedPending: StrandedOutcome[];
  };
  charges: {
    balanceTxnsChecked: number;
    chargeDrift: ChargeDrift[];
  };
};

let stripeClient: Stripe | null = null;
function getStripeClient(): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(config.stripeSecretKey, { maxNetworkRetries: 2 });
  }
  return stripeClient;
}

async function listTransfersInWindow(stripe: Stripe, sinceUnix: number): Promise<Stripe.Transfer[]> {
  const out: Stripe.Transfer[] = [];
  for await (const transfer of stripe.transfers.list({
    created: { gte: sinceUnix },
    limit: 100,
  })) {
    out.push(transfer);
    if (out.length > MAX_ITEMS_PER_LIST) {
      throw new Error(`Stripe transfer list exceeded ${MAX_ITEMS_PER_LIST} items in ${LOOKBACK_WINDOW_HOURS}h window; reconciliation aborted to prevent memory exhaustion`);
    }
  }
  return out;
}

async function listChargeBalanceTransactions(stripe: Stripe, sinceUnix: number): Promise<Stripe.BalanceTransaction[]> {
  const out: Stripe.BalanceTransaction[] = [];
  for await (const bt of stripe.balanceTransactions.list({
    type: 'charge',
    created: { gte: sinceUnix },
    limit: 100,
  })) {
    out.push(bt);
    if (out.length > MAX_ITEMS_PER_LIST) {
      throw new Error(`Stripe balance-transaction list exceeded ${MAX_ITEMS_PER_LIST} items in ${LOOKBACK_WINDOW_HOURS}h window; reconciliation aborted to prevent memory exhaustion`);
    }
  }
  return out;
}

async function reconcileTransfers(
  stripeTransfers: Stripe.Transfer[],
  lookbackStart: Date,
): Promise<{
  localCount: number;
  ghostTransfers: GhostTransfer[];
  missingTransfers: MissingTransfer[];
  amountMismatches: AmountMismatch[];
  reversedMismatches: ReversedMismatch[];
}> {
  const localPayouts = await prisma.creatorPayout.findMany({
    where: {
      stripeTransferId: { not: null },
      // Widen the local window — webhook retries can land our row's
      // updatedAt slightly outside Stripe's `created` timestamp window.
      updatedAt: { gte: new Date(lookbackStart.getTime() - 6 * 60 * 60 * 1000) },
    },
    select: { id: true, creatorUserId: true, stripeTransferId: true, status: true, amountCents: true },
  });

  const stripeById = new Map(stripeTransfers.map((t) => [t.id, t]));
  const localById = new Map(localPayouts.map((p) => [p.stripeTransferId as string, p]));

  const ghostTransfers: GhostTransfer[] = stripeTransfers
    .filter((t) => !localById.has(t.id))
    .map((t) => ({
      id: t.id,
      amountCents: t.amount,
      destination: typeof t.destination === 'string' ? t.destination : null,
      createdAt: new Date(t.created * 1000).toISOString(),
    }));

  const missingTransfers: MissingTransfer[] = localPayouts
    .filter((p) => !stripeById.has(p.stripeTransferId as string))
    .map((p) => ({
      payoutId: p.id,
      creatorUserId: p.creatorUserId,
      stripeTransferId: p.stripeTransferId as string,
      amountCents: p.amountCents,
      status: p.status,
    }));

  const amountMismatches: AmountMismatch[] = [];
  const reversedMismatches: ReversedMismatch[] = [];
  for (const t of stripeTransfers) {
    const local = localById.get(t.id);
    if (!local) continue;
    if (local.amountCents !== t.amount) {
      amountMismatches.push({
        transferId: t.id,
        stripeAmountCents: t.amount,
        localAmountCents: local.amountCents,
        creatorUserId: local.creatorUserId,
      });
    }
    // Stripe says reversed = true → our local row should be 'reversed'.
    // Or: Stripe reversed = false → local should NOT be 'reversed'.
    const stripeReversed = !!t.reversed;
    const localReversed = local.status === 'reversed';
    if (stripeReversed !== localReversed) {
      reversedMismatches.push({
        transferId: t.id,
        stripeReversed,
        localStatus: local.status,
      });
    }
  }

  return {
    localCount: localPayouts.length,
    ghostTransfers,
    missingTransfers,
    amountMismatches,
    reversedMismatches,
  };
}

async function reconcileCharges(
  balanceTxns: Stripe.BalanceTransaction[],
): Promise<{ chargeDrift: ChargeDrift[] }> {
  const chargeDrift: ChargeDrift[] = [];
  for (const bt of balanceTxns) {
    const chargeId = typeof bt.source === 'string' ? bt.source : bt.source?.id;
    if (!chargeId || !chargeId.startsWith('ch_')) continue;

    const ledgerRows = await prisma.creatorWalletLedger.findMany({
      where: { description: { contains: `charge:${chargeId}` } },
      select: { type: true, amountCents: true, description: true },
    });

    // Skip rows from the legacy destination-charge model — those charges
    // were settled by Stripe's auto-transfer at invoice.paid time and the
    // platform balance does NOT carry the full charge amount, so a per-row
    // gross check against bt.amount would falsely flag them.
    const isLegacy = ledgerRows.some(
      (r) => typeof r.description === 'string' && r.description.includes(':legacy_destination'),
    );
    if (isLegacy) continue;

    const earningRow = ledgerRows.find(
      (r) => r.type === 'earning' && typeof r.description === 'string' && r.description.endsWith(':creator_share'),
    );
    const platformFeeRow = ledgerRows.find(
      (r) => r.type === 'platform_fee' && typeof r.description === 'string' && r.description.endsWith(':platform_fee') && r.amountCents > 0,
    );

    if (!earningRow || !platformFeeRow) {
      chargeDrift.push({
        kind: 'missing_pair',
        chargeId,
        haveEarning: !!earningRow,
        havePlatformFee: !!platformFeeRow,
      });
      continue;
    }

    const ledgerGross = earningRow.amountCents + platformFeeRow.amountCents;
    if (Math.abs(bt.amount - ledgerGross) > 1) {
      chargeDrift.push({
        kind: 'amount_mismatch',
        chargeId,
        stripeAmountCents: bt.amount,
        ledgerGrossCents: ledgerGross,
      });
    }
  }
  return { chargeDrift };
}

function buildReportPayload(report: CreatorStripeReconciliationReport): string {
  return JSON.stringify({
    checkedAt: report.checkedAt.toISOString(),
    windowHours: report.windowHours,
    transfers: {
      stripeCount: report.transfers.stripeCount,
      localCount: report.transfers.localCount,
      ghostTransferCount: report.transfers.ghostTransfers.length,
      missingTransferCount: report.transfers.missingTransfers.length,
      amountMismatchCount: report.transfers.amountMismatches.length,
      reversedMismatchCount: report.transfers.reversedMismatches.length,
      ghostTransfers: report.transfers.ghostTransfers.slice(0, REPORT_ARRAY_CAP),
      missingTransfers: report.transfers.missingTransfers.slice(0, REPORT_ARRAY_CAP),
      amountMismatches: report.transfers.amountMismatches.slice(0, REPORT_ARRAY_CAP),
      reversedMismatches: report.transfers.reversedMismatches.slice(0, REPORT_ARRAY_CAP),
      strandedPendingCount: report.transfers.strandedPending.length,
      strandedPendingUnresolved: report.transfers.strandedPending.filter((s) => s.resolution === 'ambiguous').length,
      strandedPending: report.transfers.strandedPending.slice(0, REPORT_ARRAY_CAP),
    },
    charges: {
      balanceTxnsChecked: report.charges.balanceTxnsChecked,
      chargeDriftCount: report.charges.chargeDrift.length,
      chargeDrift: report.charges.chargeDrift.slice(0, REPORT_ARRAY_CAP * 2),
    },
  });
}

/**
 * F-1 — recover payouts stranded by a process crash.
 *
 * requestPayout commits the payout row ('pending') and its `payout:<id>` ledger
 * debit in ONE transaction, then calls Stripe. A crash in that window leaves:
 * status 'pending', stripeTransferId null, ledger debited, and possibly no
 * transfer at all. Nothing saw it — the transfer scan above only loads rows
 * WHERE stripeTransferId IS NOT NULL, the ghost scan needs a Stripe-side
 * transfer, and process death runs no catch block so no alert fires. Worse, the
 * pending row blocks every future payout for that creator via the partial
 * unique index, and the balance is reduced twice over (once by the ledger
 * debit, once by the pending-payout subtraction in getPayoutBalance).
 *
 * Recovery lives here rather than in requestPayout: that path has converged and
 * should not be reopened. We NEVER issue a transfer from reconciliation — the
 * only actions are "adopt what Stripe already did" or "give the money back".
 */
const STRANDED_PENDING_MIN_AGE_MS = 30 * 60 * 1000;

type StrandedOutcome = {
  payoutId: string;
  creatorUserId: string;
  amountCents: number;
  resolution: 'adopted' | 'released' | 'ambiguous';
  detail: string;
};

async function recoverStrandedPendingPayouts(stripe: Stripe): Promise<StrandedOutcome[]> {
  const cutoff = new Date(Date.now() - STRANDED_PENDING_MIN_AGE_MS);
  const stranded = await prisma.creatorPayout.findMany({
    where: { status: 'pending', stripeTransferId: null, createdAt: { lt: cutoff } },
    select: { id: true, creatorUserId: true, amountCents: true, createdAt: true },
  });
  if (stranded.length === 0) return [];

  const outcomes: StrandedOutcome[] = [];

  for (const payout of stranded) {
    const base = { payoutId: payout.id, creatorUserId: payout.creatorUserId, amountCents: payout.amountCents };

    // Ask Stripe whether it ever received this payout. transfer_group is an
    // exact, indexed filter — metadata is NOT filterable on transfers.list and
    // there is no transfers.search, so this is the only reliable handle.
    let transfers: Stripe.Transfer[];
    try {
      const res = await stripe.transfers.list({
        transfer_group: payoutTransferGroup(payout.id),
        limit: 2,
      });
      transfers = res.data ?? [];
    } catch (err) {
      outcomes.push({ ...base, resolution: 'ambiguous', detail: `stripe lookup failed: ${(err as Error).message}` });
      continue;
    }

    if (transfers.length === 1) {
      // Stripe DID receive it — the crash happened after acceptance. Adopt the
      // transfer id so the row rejoins normal reconciliation. No credit: the
      // money moved and the debit standing is correct.
      const transfer = transfers[0];
      await prisma.creatorPayout.update({
        where: { id: payout.id },
        data: { stripeTransferId: transfer.id, status: 'completed', paidAt: new Date() },
      });
      outcomes.push({ ...base, resolution: 'adopted', detail: `adopted ${transfer.id}` });
      continue;
    }

    if (transfers.length > 1) {
      // Should be impossible under one transfer_group; never guess with money.
      outcomes.push({ ...base, resolution: 'ambiguous', detail: `${transfers.length} transfers share this group` });
      continue;
    }

    // Stripe has no transfer for this payout, and the row is older than any
    // in-flight request, so no money moved. Give the balance back and free the
    // pending slot. Releasing to 'failed' (rather than deleting) frees the
    // partial unique index while keeping the audit row.
    if (isV1WalletFrozen()) {
      // The compensating credit would silently no-op under the freeze, marking
      // the payout failed while returning nothing. Leave it for a human.
      outcomes.push({ ...base, resolution: 'ambiguous', detail: 'V1_WALLET_FREEZE active — cannot credit' });
      continue;
    }

    try {
      await prisma.$transaction([
        prisma.creatorPayout.update({
          where: { id: payout.id },
          data: { status: 'failed' },
        }),
        v1LedgerCreate(prisma, {
          data: {
            creatorUserId: payout.creatorUserId,
            type: 'earning',
            amountCents: payout.amountCents,
            description: `payout_reversal:${payout.id}`,
          },
        }),
      ]);
      outcomes.push({ ...base, resolution: 'released', detail: 'no Stripe transfer exists; balance restored' });
    } catch (err) {
      outcomes.push({ ...base, resolution: 'ambiguous', detail: `release failed: ${(err as Error).message}` });
    }
  }

  return outcomes;
}

export async function runCreatorStripeReconciliation(): Promise<CreatorStripeReconciliationReport | null> {
  if (!config.creatorMonetizationEnabled) {
    console.log('[CreatorStripeReconciliation] Skipped (creator monetization disabled)');
    return null;
  }
  if (!config.stripeSecretKey) {
    console.warn('[CreatorStripeReconciliation] Skipped — STRIPE_SECRET_KEY not configured');
    return null;
  }

  const stripe = getStripeClient();
  const checkedAt = new Date();
  const lookbackStart = new Date(checkedAt.getTime() - LOOKBACK_WINDOW_HOURS * 60 * 60 * 1000);
  const sinceUnix = Math.floor(lookbackStart.getTime() / 1000);

  const [stripeTransfers, balanceTxns] = await Promise.all([
    listTransfersInWindow(stripe, sinceUnix),
    listChargeBalanceTransactions(stripe, sinceUnix),
  ]);

  // F-1: resolve crash-stranded payouts BEFORE the normal scan, so any row we
  // adopt a transfer id for is reconciled in the same run rather than a day later.
  const strandedPending = await recoverStrandedPendingPayouts(stripe);

  const transferResult = await reconcileTransfers(stripeTransfers, lookbackStart);
  const chargeResult = await reconcileCharges(balanceTxns);

  const report: CreatorStripeReconciliationReport = {
    checkedAt,
    windowHours: LOOKBACK_WINDOW_HOURS,
    transfers: {
      stripeCount: stripeTransfers.length,
      strandedPending,
      ...transferResult,
    },
    charges: {
      balanceTxnsChecked: balanceTxns.length,
      ...chargeResult,
    },
  };

  // "missing_pair" is downgraded from the critical-severity classification
  // because pre-migration charges (no :charge:<id> segment in description)
  // and charges whose invoice.paid landed outside the lookback window will
  // legitimately produce missing_pair entries. The other charge-drift kinds
  // (amount_mismatch) ARE critical. Filter accordingly.
  const criticalChargeDrift = report.charges.chargeDrift.filter((d) => d.kind !== 'missing_pair');
  // An 'adopted' or 'released' stranded payout was RESOLVED by this run, but it
  // still means a process died mid-payout — surface it. An 'ambiguous' one is
  // unresolved and needs a human.
  const hasIssues =
    report.transfers.strandedPending.length > 0 ||
    report.transfers.ghostTransfers.length > 0 ||
    report.transfers.missingTransfers.length > 0 ||
    report.transfers.amountMismatches.length > 0 ||
    report.transfers.reversedMismatches.length > 0 ||
    criticalChargeDrift.length > 0;

  await prisma.monitoringReport.create({
    data: {
      type: 'security',
      status: hasIssues ? 'critical' : 'ok',
      source: 'creator_stripe_reconciliation',
      data: buildReportPayload(report),
    },
  });

  const logFn = hasIssues ? console.error : console.info;
  logFn('[CreatorStripeReconciliation]', JSON.stringify({
    status: hasIssues ? 'critical' : 'ok',
    windowHours: LOOKBACK_WINDOW_HOURS,
    stripeTransferCount: stripeTransfers.length,
    localPayoutCount: report.transfers.localCount,
    ghostTransfers: report.transfers.ghostTransfers.length,
    missingTransfers: report.transfers.missingTransfers.length,
    amountMismatches: report.transfers.amountMismatches.length,
    reversedMismatches: report.transfers.reversedMismatches.length,
    balanceTxnsChecked: balanceTxns.length,
    chargeDrift: report.charges.chargeDrift.length,
  }));

  return report;
}
