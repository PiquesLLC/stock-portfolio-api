import prisma from '../utils/prisma';
import { config } from '../config';

type LedgerType = 'earning' | 'platform_fee' | 'refund' | 'payout';

type ReconciliationSubscription = {
  id: string;
  creatorUserId: string;
  status: string;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
};

type ReconciliationLedgerEntry = {
  id: string;
  creatorUserId: string;
  subscriptionId: string | null;
  type: LedgerType;
  amountCents: number;
  description: string | null;
  createdAt: Date;
};

export type CreatorReconciliationIssue = {
  code:
    | 'missing_subscription_reference'
    | 'subscription_not_found'
    | 'creator_mismatch'
    | 'invalid_sign'
    | 'unexpected_subscription_reference'
    | 'missing_platform_fee_pair'
    | 'missing_creator_share_pair'
    | 'missing_refund_platform_pair'
    | 'missing_refund_creator_pair'
    | 'invalid_paid_split'
    | 'invalid_refund_split'
    | 'stale_active_subscription';
  severity: 'warning' | 'critical';
  message: string;
  creatorUserId: string;
  subscriptionId?: string;
  ledgerEntryId?: string;
};

export type CreatorReconciliationReport = {
  checkedAt: Date;
  subscriptionsChecked: number;
  ledgerEntriesChecked: number;
  issues: CreatorReconciliationIssue[];
};

function parseEventDescriptor(description: string | null): {
  eventId: string;
  kind: 'creator_share' | 'platform_fee' | 'refund_creator' | 'refund_platform';
} | null {
  if (!description) return null;
  // Optional :charge:<chargeId> segment (added in 20260527 ledger idempotency
  // change so dispute / refund handlers can look up the original earning by
  // charge id). Older rows without that segment still parse.
  const match = /^stripe_event:([^:]+)(?::charge:[^:]+)?:(creator_share|platform_fee|refund_creator|refund_platform)(?::.*)?$/.exec(description);
  if (!match) return null;
  const eventId = match[1];
  const kind = match[2] as 'creator_share' | 'platform_fee' | 'refund_creator' | 'refund_platform';
  return { eventId, kind };
}

function expectedCreatorShare(totalCents: number): number {
  // Exact integer 80% floor — single source of truth with `splitCreatorRevenueCents`
  // in creator-billing (the writer floors, so the reconciler must expect the floor too).
  return Number((BigInt(totalCents) * 80n) / 100n);
}

export function analyzeCreatorLedgerConsistency(
  subscriptions: ReconciliationSubscription[],
  entries: ReconciliationLedgerEntry[],
  now = new Date()
): CreatorReconciliationReport {
  const checkedAt = new Date();
  const issues: CreatorReconciliationIssue[] = [];
  const subscriptionById = new Map(subscriptions.map((sub) => [sub.id, sub]));
  const groupedByEvent = new Map<string, {
    creatorUserId: string;
    subscriptionId: string;
    creatorShare?: ReconciliationLedgerEntry;
    platformFee?: ReconciliationLedgerEntry;
    refundCreator?: ReconciliationLedgerEntry;
    refundPlatform?: ReconciliationLedgerEntry;
  }>();

  for (const entry of entries) {
    // Compensating earning rows written when a payout fails sync
    // (`payout_reversal:<id>`) or a transfer is reversed
    // (`transfer_reversed:<id>`) intentionally have no subscriptionId — they
    // restore wallet balance for a transfer that has no per-subscription
    // origin. Skip the missing-subscription check for these.
    const isCompensationRow =
      typeof entry.description === 'string' &&
      (entry.description.startsWith('payout_reversal:') ||
       entry.description.startsWith('transfer_reversed:'));
    if (!isCompensationRow && (entry.type === 'earning' || entry.type === 'platform_fee' || entry.type === 'refund') && !entry.subscriptionId) {
      issues.push({
        code: 'missing_subscription_reference',
        severity: 'critical',
        message: `Ledger entry ${entry.id} is missing subscriptionId`,
        creatorUserId: entry.creatorUserId,
        ledgerEntryId: entry.id,
      });
    }

    if (entry.type === 'payout' && entry.subscriptionId) {
      issues.push({
        code: 'unexpected_subscription_reference',
        severity: 'warning',
        message: `Payout entry ${entry.id} should not be tied to a subscription`,
        creatorUserId: entry.creatorUserId,
        subscriptionId: entry.subscriptionId,
        ledgerEntryId: entry.id,
      });
    }

    if (entry.type === 'earning' && entry.amountCents <= 0) {
      issues.push({
        code: 'invalid_sign',
        severity: 'critical',
        message: `Earning entry ${entry.id} must be positive`,
        creatorUserId: entry.creatorUserId,
        subscriptionId: entry.subscriptionId ?? undefined,
        ledgerEntryId: entry.id,
      });
    }

    if (entry.type === 'refund' && entry.amountCents >= 0) {
      issues.push({
        code: 'invalid_sign',
        severity: 'critical',
        message: `Refund entry ${entry.id} must be negative`,
        creatorUserId: entry.creatorUserId,
        subscriptionId: entry.subscriptionId ?? undefined,
        ledgerEntryId: entry.id,
      });
    }

    if (entry.subscriptionId) {
      const sub = subscriptionById.get(entry.subscriptionId);
      if (!sub) {
        issues.push({
          code: 'subscription_not_found',
          severity: 'critical',
          message: `Ledger entry ${entry.id} references unknown subscription ${entry.subscriptionId}`,
          creatorUserId: entry.creatorUserId,
          subscriptionId: entry.subscriptionId,
          ledgerEntryId: entry.id,
        });
        continue;
      }

      if (sub.creatorUserId !== entry.creatorUserId) {
        issues.push({
          code: 'creator_mismatch',
          severity: 'critical',
          message: `Ledger entry ${entry.id} creator ${entry.creatorUserId} does not match subscription creator ${sub.creatorUserId}`,
          creatorUserId: entry.creatorUserId,
          subscriptionId: sub.id,
          ledgerEntryId: entry.id,
        });
      }

      const descriptor = parseEventDescriptor(entry.description);
      if (!descriptor) continue;

      const groupKey = `${sub.id}:${descriptor.eventId}`;
      const group = groupedByEvent.get(groupKey) ?? {
        creatorUserId: entry.creatorUserId,
        subscriptionId: sub.id,
      };
      if (descriptor.kind === 'creator_share') group.creatorShare = entry;
      if (descriptor.kind === 'platform_fee') group.platformFee = entry;
      if (descriptor.kind === 'refund_creator') group.refundCreator = entry;
      if (descriptor.kind === 'refund_platform') group.refundPlatform = entry;
      groupedByEvent.set(groupKey, group);
    }
  }

  for (const group of groupedByEvent.values()) {
    if (group.creatorShare && !group.platformFee) {
      issues.push({
        code: 'missing_platform_fee_pair',
        severity: 'critical',
        message: `Missing platform fee pair for subscription event on ${group.subscriptionId}`,
        creatorUserId: group.creatorUserId,
        subscriptionId: group.subscriptionId,
        ledgerEntryId: group.creatorShare.id,
      });
    }
    if (group.platformFee && !group.creatorShare) {
      issues.push({
        code: 'missing_creator_share_pair',
        severity: 'critical',
        message: `Missing creator share pair for subscription event on ${group.subscriptionId}`,
        creatorUserId: group.creatorUserId,
        subscriptionId: group.subscriptionId,
        ledgerEntryId: group.platformFee.id,
      });
    }
    if (group.refundCreator && !group.refundPlatform) {
      issues.push({
        code: 'missing_refund_platform_pair',
        severity: 'critical',
        message: `Missing refund platform fee pair for subscription event on ${group.subscriptionId}`,
        creatorUserId: group.creatorUserId,
        subscriptionId: group.subscriptionId,
        ledgerEntryId: group.refundCreator.id,
      });
    }
    if (group.refundPlatform && !group.refundCreator) {
      issues.push({
        code: 'missing_refund_creator_pair',
        severity: 'critical',
        message: `Missing creator refund pair for subscription event on ${group.subscriptionId}`,
        creatorUserId: group.creatorUserId,
        subscriptionId: group.subscriptionId,
        ledgerEntryId: group.refundPlatform.id,
      });
    }

    if (group.creatorShare && group.platformFee) {
      const creator = group.creatorShare.amountCents;
      const platform = group.platformFee.amountCents;
      if (creator <= 0 || platform <= 0) {
        issues.push({
          code: 'invalid_paid_split',
          severity: 'critical',
          message: `Paid split has invalid sign for subscription ${group.subscriptionId}`,
          creatorUserId: group.creatorUserId,
          subscriptionId: group.subscriptionId,
        });
      } else {
        const gross = creator + platform;
        const expected = expectedCreatorShare(gross);
        if (Math.abs(creator - expected) > 1) {
          issues.push({
            code: 'invalid_paid_split',
            severity: 'critical',
            message: `Paid split deviates from 80/20 for subscription ${group.subscriptionId}`,
            creatorUserId: group.creatorUserId,
            subscriptionId: group.subscriptionId,
          });
        }
      }
    }

    if (group.refundCreator && group.refundPlatform) {
      const creator = Math.abs(group.refundCreator.amountCents);
      const platform = Math.abs(group.refundPlatform.amountCents);
      if (group.refundCreator.amountCents >= 0 || group.refundPlatform.amountCents >= 0) {
        issues.push({
          code: 'invalid_refund_split',
          severity: 'critical',
          message: `Refund split has invalid sign for subscription ${group.subscriptionId}`,
          creatorUserId: group.creatorUserId,
          subscriptionId: group.subscriptionId,
        });
      } else {
        const grossRefund = creator + platform;
        const expected = expectedCreatorShare(grossRefund);
        if (Math.abs(creator - expected) > 1) {
          issues.push({
            code: 'invalid_refund_split',
            severity: 'critical',
            message: `Refund split deviates from 80/20 for subscription ${group.subscriptionId}`,
            creatorUserId: group.creatorUserId,
            subscriptionId: group.subscriptionId,
          });
        }
      }
    }
  }

  for (const sub of subscriptions) {
    if (sub.status === 'active' && sub.currentPeriodEnd && sub.currentPeriodEnd <= now) {
      issues.push({
        code: 'stale_active_subscription',
        severity: 'warning',
        message: `Active subscription ${sub.id} has expired period end`,
        creatorUserId: sub.creatorUserId,
        subscriptionId: sub.id,
      });
    }
  }

  return {
    checkedAt,
    subscriptionsChecked: subscriptions.length,
    ledgerEntriesChecked: entries.length,
    issues,
  };
}

export async function runCreatorLedgerReconciliation(): Promise<CreatorReconciliationReport | null> {
  if (!config.creatorMonetizationEnabled) return null;

  const [subscriptions, entries] = await Promise.all([
    prisma.creatorSubscription.findMany({
      select: {
        id: true,
        creatorUserId: true,
        status: true,
        stripeSubscriptionId: true,
        currentPeriodEnd: true,
      },
    }),
    prisma.creatorWalletLedger.findMany({
      select: {
        id: true,
        creatorUserId: true,
        subscriptionId: true,
        type: true,
        amountCents: true,
        description: true,
        createdAt: true,
      },
    }),
  ]);

  const report = analyzeCreatorLedgerConsistency(
    subscriptions,
    entries as ReconciliationLedgerEntry[]
  );

  const criticalCount = report.issues.filter((issue) => issue.severity === 'critical').length;
  const warningCount = report.issues.length - criticalCount;
  if (report.issues.length === 0) {
    console.info('[CreatorReconciliation]', JSON.stringify({
      outcome: 'healthy',
      checkedAt: report.checkedAt.toISOString(),
      subscriptionsChecked: report.subscriptionsChecked,
      ledgerEntriesChecked: report.ledgerEntriesChecked,
      issues: 0,
    }));
  } else {
    console.warn('[CreatorReconciliation]', JSON.stringify({
      outcome: 'issues_found',
      checkedAt: report.checkedAt.toISOString(),
      subscriptionsChecked: report.subscriptionsChecked,
      ledgerEntriesChecked: report.ledgerEntriesChecked,
      issues: report.issues.length,
      criticalCount,
      warningCount,
      sample: report.issues.slice(0, 25),
    }));
  }

  return report;
}
