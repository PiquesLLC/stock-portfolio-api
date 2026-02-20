import { describe, expect, it } from 'vitest';
import { analyzeCreatorLedgerConsistency } from '../services/creator-reconciliation.service';

describe('creator reconciliation analysis', () => {
  it('returns healthy report for balanced paid and refund pairs', () => {
    const now = new Date('2026-02-20T00:00:00.000Z');
    const subscriptions = [{
      id: 'sub_1',
      creatorUserId: 'creator_1',
      status: 'active',
      stripeSubscriptionId: 'stripe_sub_1',
      currentPeriodEnd: new Date('2026-03-01T00:00:00.000Z'),
    }];
    const entries = [
      {
        id: 'l1',
        creatorUserId: 'creator_1',
        subscriptionId: 'sub_1',
        type: 'earning' as const,
        amountCents: 800,
        description: 'stripe_event:evt_paid:creator_share',
        createdAt: now,
      },
      {
        id: 'l2',
        creatorUserId: 'creator_1',
        subscriptionId: 'sub_1',
        type: 'platform_fee' as const,
        amountCents: 200,
        description: 'stripe_event:evt_paid:platform_fee',
        createdAt: now,
      },
      {
        id: 'l3',
        creatorUserId: 'creator_1',
        subscriptionId: 'sub_1',
        type: 'refund' as const,
        amountCents: -80,
        description: 'stripe_event:evt_refund:refund_creator',
        createdAt: now,
      },
      {
        id: 'l4',
        creatorUserId: 'creator_1',
        subscriptionId: 'sub_1',
        type: 'platform_fee' as const,
        amountCents: -20,
        description: 'stripe_event:evt_refund:refund_platform',
        createdAt: now,
      },
    ];

    const report = analyzeCreatorLedgerConsistency(subscriptions, entries, now);
    expect(report.issues).toHaveLength(0);
  });

  it('flags missing paid pair and stale active subscriptions', () => {
    const now = new Date('2026-02-20T00:00:00.000Z');
    const subscriptions = [{
      id: 'sub_2',
      creatorUserId: 'creator_2',
      status: 'active',
      stripeSubscriptionId: 'stripe_sub_2',
      currentPeriodEnd: new Date('2026-01-01T00:00:00.000Z'),
    }];
    const entries = [{
      id: 'l5',
      creatorUserId: 'creator_2',
      subscriptionId: 'sub_2',
      type: 'earning' as const,
      amountCents: 1200,
      description: 'stripe_event:evt_paid_only:creator_share',
      createdAt: now,
    }];

    const report = analyzeCreatorLedgerConsistency(subscriptions, entries, now);
    const codes = report.issues.map((issue) => issue.code);
    expect(codes).toContain('missing_platform_fee_pair');
    expect(codes).toContain('stale_active_subscription');
  });

  it('flags creator mismatch and invalid signs', () => {
    const now = new Date('2026-02-20T00:00:00.000Z');
    const subscriptions = [{
      id: 'sub_3',
      creatorUserId: 'creator_3',
      status: 'canceled',
      stripeSubscriptionId: 'stripe_sub_3',
      currentPeriodEnd: null,
    }];
    const entries = [
      {
        id: 'l6',
        creatorUserId: 'creator_wrong',
        subscriptionId: 'sub_3',
        type: 'earning' as const,
        amountCents: -100,
        description: 'stripe_event:evt_bad:creator_share',
        createdAt: now,
      },
      {
        id: 'l7',
        creatorUserId: 'creator_3',
        subscriptionId: null,
        type: 'refund' as const,
        amountCents: 100,
        description: null,
        createdAt: now,
      },
    ];

    const report = analyzeCreatorLedgerConsistency(subscriptions, entries, now);
    const codes = report.issues.map((issue) => issue.code);
    expect(codes).toContain('creator_mismatch');
    expect(codes).toContain('invalid_sign');
    expect(codes).toContain('missing_subscription_reference');
  });
});
