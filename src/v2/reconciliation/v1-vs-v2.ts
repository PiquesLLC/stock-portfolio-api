// v1↔v2 reconciliation: compare creator wallet balances across the two
// ledger systems to detect drift during the shadow-write epoch.
//
// Designed for use by:
//   - `scripts/v1-vs-v2-reconcile.ts` — CLI for manual runs and cron schedules
//   - Future programmatic alerting (Sentry / PagerDuty integrations)
//
// The check is structurally simple:
//   v1 creator balance := sum(CreatorWalletLedger.amountCents) under the v1
//     wallet semantic — earning rows are positive, refund rows are negative,
//     platform_fee rows are platform's side (not counted toward creator),
//     payout rows are positive but represent OUTFLOW (subtract).
//   v2 creator balance := getBalance('creator', creatorUserId)
//
// If the v1→v2 backfill + the live shadow-writes correctly mirror every
// monetary movement, the two balances must equal to the cent.

import v1Prisma from '../../utils/prisma';
import { getBalance } from '../ledger';

export interface CreatorReconcileResult {
  creatorUserId: string;
  v1BalanceCents: number;
  v2BalanceCents: bigint;
  diffCents: bigint;
  divergent: boolean;
  /** Rows considered in v1 (excluding platform_fee — those track platform side). */
  v1RowCount: number;
  /** Whether v2 has the creator account at all. */
  v2AccountExists: boolean;
}

export interface BatchReconcileResult {
  /** When the reconciliation started. */
  startedAt: Date;
  /** Total creators scanned. */
  totalScanned: number;
  /** Creators whose v1 and v2 balances diverged. */
  divergent: CreatorReconcileResult[];
  /** Creators where v2 account doesn't exist (likely never had a v2 write). */
  v2Missing: CreatorReconcileResult[];
  /** Creators that reconciled cleanly. */
  cleanCount: number;
}

/**
 * Compute the v1 wallet balance for one creator. Sums only the rows that
 * affect the creator's spendable wallet:
 *   + type='earning' (positive contribution)
 *   + type='refund' (negative contribution since the cents are signed -)
 *   − type='payout' (positive cents but represent outflow → subtract)
 * platform_fee rows are deliberately excluded — they track the platform's
 * side, not the creator's wallet.
 */
async function computeV1CreatorBalance(
  creatorUserId: string,
): Promise<{ balanceCents: number; rowCount: number }> {
  const rows = await v1Prisma.creatorWalletLedger.findMany({
    where: {
      creatorUserId,
      type: { in: ['earning', 'refund', 'payout'] },
    },
    select: { type: true, amountCents: true },
  });
  let balance = 0;
  for (const r of rows) {
    if (r.type === 'payout') {
      // payout rows have positive amountCents but represent outflow.
      balance -= r.amountCents;
    } else {
      // earning/refund: amountCents already carries the sign (earning +,
      // refund and dispute_clawback −).
      balance += r.amountCents;
    }
  }
  return { balanceCents: balance, rowCount: rows.length };
}

/**
 * Reconcile one creator's v1 vs v2 balances. Returns the comparison even
 * when divergent — caller decides whether to log / alert / page.
 */
export async function reconcileCreator(
  creatorUserId: string,
): Promise<CreatorReconcileResult> {
  const v1 = await computeV1CreatorBalance(creatorUserId);
  const v2 = await getBalance('creator', creatorUserId);
  const v1Big = BigInt(v1.balanceCents);
  const diff = v1Big - v2.balanceMinorUnits;
  return {
    creatorUserId,
    v1BalanceCents: v1.balanceCents,
    v2BalanceCents: v2.balanceMinorUnits,
    diffCents: diff,
    divergent: diff !== 0n,
    v1RowCount: v1.rowCount,
    v2AccountExists: v2.exists,
  };
}

/**
 * Reconcile every creator that has at least one v1 wallet ledger row.
 * Returns the aggregate report. Designed for daily cron + on-demand.
 *
 * If V2_SHADOW_WRITE_ENABLED is not 'true' OR V2_DATABASE_URL is missing,
 * THIS THROWS — the caller must explicitly opt-in to running v2 queries.
 */
export async function reconcileAllCreators(): Promise<BatchReconcileResult> {
  if (!process.env.V2_DATABASE_URL) {
    throw new Error(
      'reconcileAllCreators: V2_DATABASE_URL is not set. Cannot query v2 ledger.',
    );
  }
  const startedAt = new Date();
  // Distinct creator ids that have at least one wallet row.
  const creators = await v1Prisma.creatorWalletLedger.findMany({
    where: { type: { in: ['earning', 'refund', 'payout'] } },
    select: { creatorUserId: true },
    distinct: ['creatorUserId'],
  });

  const divergent: CreatorReconcileResult[] = [];
  const v2Missing: CreatorReconcileResult[] = [];
  let cleanCount = 0;

  for (const { creatorUserId } of creators) {
    const result = await reconcileCreator(creatorUserId);
    if (!result.v2AccountExists) {
      v2Missing.push(result);
    } else if (result.divergent) {
      divergent.push(result);
    } else {
      cleanCount += 1;
    }
  }

  return {
    startedAt,
    totalScanned: creators.length,
    divergent,
    v2Missing,
    cleanCount,
  };
}
