// Integration tests for the v2 ledger service against real Postgres.
//
// HOW TO RUN:
//   1. docker compose up -d postgres-v2
//   2. npm run prisma:v2:generate
//   3. npm run test:v2:integration
//
// (The npm script sets RUN_V2_INTEGRATION=1 and V2_DATABASE_URL.)
//
// These tests intentionally hit the live DB end-to-end. They:
//   - Apply migrations + seed (idempotent) in beforeAll.
//   - Truncate + re-seed between tests so each starts from a known shape.
//   - Cover the contract that 7 hardening passes touched but no test
//     has ever actually exercised: triggers, partial uniques, dedup,
//     reversal shape, concurrency.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { postTransaction } from '../../post-transaction';
import { getBalance } from '../../get-balance';
import { replay } from '../../replay';
import { disconnectLedgerClientForTesting, getLedgerClient } from '../../prisma';
import { LedgerEntryInput, PostTransactionInput } from '../../types';
import {
  applyMigrationsAndSeedIfNeeded,
  shouldRunIntegrationTests,
  truncateLedgerForTest,
} from './setup-helper';

// All integration `describe` blocks gate on this. If RUN_V2_INTEGRATION
// isn't set, the suite skips silently — CI without Postgres stays green.
const run = shouldRunIntegrationTests();

// ── Test data helpers ───────────────────────────────────────────────────
function newEventGroupId(): string {
  return randomUUID();
}

function newCreatorId(): string {
  return randomUUID();
}

function balancedInvoicePaidEntries(creatorId: string, gross: bigint): LedgerEntryInput[] {
  // Mirrors the canonical invoice.paid 4-leg structure:
  //   stripe_clearing: gross debit  (Stripe sent us money)
  //   creator:         creator_share credit (80%)
  //   platform_revenue: platform_share credit (20%)
  //   platform_fee:    take debit/credit pair against platform_revenue
  // Simplified here: stripe_clearing → creator + platform_revenue.
  const creatorShare = (gross * 80n) / 100n;
  const platformShare = gross - creatorShare;
  return [
    {
      accountScope: 'stripe_clearing',
      accountId: 'platform',
      eventType: 'EARNING_GROSS',
      debitMinorUnits: gross,
      creditMinorUnits: 0n,
      currency: 'USD',
      idempotencySuffix: 'stripe_clearing',
    },
    {
      accountScope: 'creator',
      accountId: creatorId,
      eventType: 'EARNING_GROSS',
      debitMinorUnits: 0n,
      creditMinorUnits: creatorShare,
      currency: 'USD',
      idempotencySuffix: 'creator_share',
    },
    {
      accountScope: 'platform_revenue',
      accountId: 'platform',
      eventType: 'EARNING_GROSS',
      debitMinorUnits: 0n,
      creditMinorUnits: platformShare,
      currency: 'USD',
      idempotencySuffix: 'platform_revenue',
    },
  ];
}

function makeInput(entries: LedgerEntryInput[], overrides: Partial<PostTransactionInput> = {}): PostTransactionInput {
  return {
    eventGroupId: newEventGroupId(),
    effectiveAt: new Date(),
    postedBy: 'test:integration',
    entries,
    ...overrides,
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────
describe.skipIf(!run)('v2 ledger integration (against Postgres)', () => {
  beforeAll(async () => {
    await applyMigrationsAndSeedIfNeeded();
  }, 120_000);

  beforeEach(async () => {
    await truncateLedgerForTest();
  });

  afterAll(async () => {
    await disconnectLedgerClientForTesting();
  });

  // ── 1. Happy path ──────────────────────────────────────────────────
  describe('happy path', () => {
    it('posts a balanced single-currency event and returns sequenced entries', async () => {
      const creatorId = newCreatorId();
      const input = makeInput(balancedInvoicePaidEntries(creatorId, 1000n));
      const result = await postTransaction(input);

      expect(result.deduplicated).toBe(false);
      expect(result.entries).toHaveLength(3);
      for (const e of result.entries) {
        expect(e.sequenceNo).toBe(1n); // First entry per account
        expect(e.runningBalanceMinorUnits).toBeDefined();
      }
      // Creator got +800
      const creatorEntry = result.entries.find((e) => e.accountScope === 'creator')!;
      expect(creatorEntry.runningBalanceMinorUnits).toBe(800n);
      // platform_revenue got +200
      const platformEntry = result.entries.find((e) => e.accountScope === 'platform_revenue')!;
      expect(platformEntry.runningBalanceMinorUnits).toBe(200n);
      // stripe_clearing went -1000 (debit)
      const clearingEntry = result.entries.find((e) => e.accountScope === 'stripe_clearing')!;
      expect(clearingEntry.runningBalanceMinorUnits).toBe(-1000n);
    });

    it('auto-creates the creator account on first earning; reuses on second', async () => {
      const creatorId = newCreatorId();
      await postTransaction(makeInput(balancedInvoicePaidEntries(creatorId, 1000n)));
      // A second post for the same creator must reuse the account (no P2002).
      const r2 = await postTransaction(makeInput(balancedInvoicePaidEntries(creatorId, 500n)));
      const creatorEntry = r2.entries.find((e) => e.accountScope === 'creator')!;
      expect(creatorEntry.sequenceNo).toBe(2n); // Second entry on this account
      expect(creatorEntry.runningBalanceMinorUnits).toBe(800n + 400n); // 1200
    });
  });

  // ── 2. Rejection paths (DB-confirmed) ──────────────────────────────
  describe('rejections (verify zero rows landed)', () => {
    it('INV-2 unbalanced event throws and writes nothing', async () => {
      const creatorId = newCreatorId();
      const entries = balancedInvoicePaidEntries(creatorId, 1000n);
      // Sabotage the balance: shrink the creator credit.
      entries[1].creditMinorUnits = 700n;
      await expect(postTransaction(makeInput(entries))).rejects.toThrow(/unbalanced for currency/);

      const count = await getLedgerClient().ledgerEntry.count();
      expect(count).toBe(0);
    });

    it('multi-entry-same-account rejected at app layer; zero rows landed', async () => {
      const creatorId = newCreatorId();
      const dup: LedgerEntryInput[] = [
        {
          accountScope: 'creator',
          accountId: creatorId,
          eventType: 'EARNING_GROSS',
          debitMinorUnits: 0n,
          creditMinorUnits: 500n,
          currency: 'USD',
          idempotencySuffix: 'a',
        },
        {
          accountScope: 'creator',
          accountId: creatorId,
          eventType: 'PLATFORM_FEE',
          debitMinorUnits: 500n,
          creditMinorUnits: 0n,
          currency: 'USD',
          idempotencySuffix: 'b',
        },
      ];
      await expect(postTransaction(makeInput(dup))).rejects.toThrow(/Multi-entry-same-account batches are not supported/);

      const count = await getLedgerClient().ledgerEntry.count();
      expect(count).toBe(0);
    });

    it('currency mismatch against existing account rejected', async () => {
      const creatorId = newCreatorId();
      // Seed the creator as USD.
      await postTransaction(makeInput(balancedInvoicePaidEntries(creatorId, 1000n)));

      // Try posting a EUR entry to the same creator.
      const eurEntries: LedgerEntryInput[] = [
        {
          accountScope: 'stripe_clearing', accountId: 'platform', eventType: 'EARNING_GROSS',
          debitMinorUnits: 100n, creditMinorUnits: 0n, currency: 'USD', idempotencySuffix: 's',
        },
        {
          accountScope: 'creator', accountId: creatorId, eventType: 'EARNING_GROSS',
          debitMinorUnits: 0n, creditMinorUnits: 100n, currency: 'EUR', idempotencySuffix: 'c',
        },
      ];
      await expect(postTransaction(makeInput(eurEntries))).rejects.toThrow(/currency.*immutable|exists with currency/);
    });
  });

  // ── 3. Idempotency ─────────────────────────────────────────────────
  describe('idempotency', () => {
    it('same eventGroupId + identical entries returns deduplicated=true', async () => {
      const creatorId = newCreatorId();
      const eventGroupId = newEventGroupId();
      const entries = balancedInvoicePaidEntries(creatorId, 1000n);
      const baseInput: PostTransactionInput = {
        eventGroupId,
        effectiveAt: new Date('2026-01-15T00:00:00Z'),
        postedBy: 'test:integration',
        entries,
      };
      const r1 = await postTransaction(baseInput);
      const r2 = await postTransaction(baseInput);

      expect(r1.deduplicated).toBe(false);
      expect(r2.deduplicated).toBe(true);
      expect(r2.entries).toHaveLength(3);
      // No duplicate DB rows.
      const total = await getLedgerClient().ledgerEntry.count();
      expect(total).toBe(3);
    });

    it('intent divergence throws CRITICAL and does not write extra rows', async () => {
      const creatorId = newCreatorId();
      const eventGroupId = newEventGroupId();
      const entries = balancedInvoicePaidEntries(creatorId, 1000n);
      const baseInput = {
        eventGroupId,
        effectiveAt: new Date('2026-01-15T00:00:00Z'),
        postedBy: 'test:integration' as const,
        entries,
      };
      await postTransaction(baseInput);

      const tampered = balancedInvoicePaidEntries(creatorId, 1000n);
      tampered[1].creditMinorUnits = 700n; // Pretend creator gets less
      tampered[2].creditMinorUnits = 300n; // Platform gets more
      await expect(
        postTransaction({ ...baseInput, entries: tampered }),
      ).rejects.toThrow(/CRITICAL.*reused for different intent/);

      // Original 3 rows still there; no extras.
      const total = await getLedgerClient().ledgerEntry.count();
      expect(total).toBe(3);
    });

    it('metadata canonicalization: key-order variation does NOT trigger divergence', async () => {
      const creatorId = newCreatorId();
      const eventGroupId = newEventGroupId();
      const entries1 = balancedInvoicePaidEntries(creatorId, 1000n);
      entries1[1].metadata = { a: 1, b: 2 };
      const entries2 = balancedInvoicePaidEntries(creatorId, 1000n);
      entries2[1].metadata = { b: 2, a: 1 }; // Same JSON, different key order

      const baseInput = {
        eventGroupId,
        effectiveAt: new Date('2026-01-15T00:00:00Z'),
        postedBy: 'test:integration' as const,
      };
      await postTransaction({ ...baseInput, entries: entries1 });
      const r2 = await postTransaction({ ...baseInput, entries: entries2 });
      expect(r2.deduplicated).toBe(true);
    });
  });

  // ── 4. Reversal ────────────────────────────────────────────────────
  describe('reversal', () => {
    it('valid exact-inverse reversal accepted', async () => {
      const creatorId = newCreatorId();
      const original = await postTransaction(makeInput(balancedInvoicePaidEntries(creatorId, 1000n)));
      const creatorRow = original.entries.find((e) => e.accountScope === 'creator')!;
      const clearingRow = original.entries.find((e) => e.accountScope === 'stripe_clearing')!;
      const platformRow = original.entries.find((e) => e.accountScope === 'platform_revenue')!;

      // Full reversal: invert every leg with reversesEntryId + reason.
      const reversal: LedgerEntryInput[] = [
        {
          accountScope: 'stripe_clearing', accountId: 'platform', eventType: 'EARNING_REFUNDED',
          debitMinorUnits: 0n, creditMinorUnits: 1000n, currency: 'USD', idempotencySuffix: 'rev_s',
          reversesEntryId: clearingRow.id, metadata: { reversalReason: 'dispute_won' },
        },
        {
          accountScope: 'creator', accountId: creatorId, eventType: 'EARNING_REFUNDED',
          debitMinorUnits: 800n, creditMinorUnits: 0n, currency: 'USD', idempotencySuffix: 'rev_c',
          reversesEntryId: creatorRow.id, metadata: { reversalReason: 'dispute_won' },
        },
        {
          accountScope: 'platform_revenue', accountId: 'platform', eventType: 'EARNING_REFUNDED',
          debitMinorUnits: 200n, creditMinorUnits: 0n, currency: 'USD', idempotencySuffix: 'rev_p',
          reversesEntryId: platformRow.id, metadata: { reversalReason: 'dispute_won' },
        },
      ];
      await expect(postTransaction(makeInput(reversal))).resolves.toBeDefined();

      // Creator net balance: 800 (original) - 800 (reversal) = 0
      const bal = await getBalance('creator', creatorId);
      expect(bal.balanceMinorUnits).toBe(0n);
    });

    it('non-inverse magnitude rejected with INV-5 message', async () => {
      const creatorId = newCreatorId();
      const original = await postTransaction(makeInput(balancedInvoicePaidEntries(creatorId, 1000n)));
      const creatorRow = original.entries.find((e) => e.accountScope === 'creator')!;

      const partialReversal: LedgerEntryInput[] = [
        {
          accountScope: 'creator', accountId: creatorId, eventType: 'EARNING_REFUNDED',
          debitMinorUnits: 400n, // not 800 — partial, not allowed
          creditMinorUnits: 0n, currency: 'USD', idempotencySuffix: 'rev_c',
          reversesEntryId: creatorRow.id, metadata: { reversalReason: 'partial_refund' },
        },
        {
          accountScope: 'platform_revenue', accountId: 'platform', eventType: 'EARNING_REFUNDED',
          debitMinorUnits: 0n, creditMinorUnits: 400n, currency: 'USD', idempotencySuffix: 'rev_p',
        },
      ];
      await expect(postTransaction(makeInput(partialReversal))).rejects.toThrow(/INV-5.*not the exact inverse/);
    });

    it('double-clawback prevented: two reversals of same referent → second rejected', async () => {
      const creatorId = newCreatorId();
      const original = await postTransaction(makeInput(balancedInvoicePaidEntries(creatorId, 1000n)));
      const creatorRow = original.entries.find((e) => e.accountScope === 'creator')!;
      const clearingRow = original.entries.find((e) => e.accountScope === 'stripe_clearing')!;
      const platformRow = original.entries.find((e) => e.accountScope === 'platform_revenue')!;

      const fullReversal = (): LedgerEntryInput[] => [
        {
          accountScope: 'stripe_clearing', accountId: 'platform', eventType: 'EARNING_REFUNDED',
          debitMinorUnits: 0n, creditMinorUnits: 1000n, currency: 'USD', idempotencySuffix: 's',
          reversesEntryId: clearingRow.id, metadata: { reversalReason: 'dispute_won' },
        },
        {
          accountScope: 'creator', accountId: creatorId, eventType: 'EARNING_REFUNDED',
          debitMinorUnits: 800n, creditMinorUnits: 0n, currency: 'USD', idempotencySuffix: 'c',
          reversesEntryId: creatorRow.id, metadata: { reversalReason: 'dispute_won' },
        },
        {
          accountScope: 'platform_revenue', accountId: 'platform', eventType: 'EARNING_REFUNDED',
          debitMinorUnits: 200n, creditMinorUnits: 0n, currency: 'USD', idempotencySuffix: 'p',
          reversesEntryId: platformRow.id, metadata: { reversalReason: 'dispute_won' },
        },
      ];
      await postTransaction(makeInput(fullReversal()));
      // Second reversal of the same referent with DIFFERENT eventGroupId.
      await expect(postTransaction(makeInput(fullReversal()))).rejects.toThrow(/already been reversed/);
    });
  });

  // ── 5. Read path (getBalance + replay) ─────────────────────────────
  describe('read path', () => {
    it('getBalance: non-existent account returns exists=false', async () => {
      const bal = await getBalance('creator', newCreatorId());
      expect(bal.exists).toBe(false);
      expect(bal.balanceMinorUnits).toBe(0n);
      expect(bal.currency).toBeNull();
    });

    it('getBalance: existing account with entries reports the latest running balance', async () => {
      const creatorId = newCreatorId();
      await postTransaction(makeInput(balancedInvoicePaidEntries(creatorId, 1000n)));
      const bal = await getBalance('creator', creatorId);
      expect(bal.exists).toBe(true);
      expect(bal.balanceMinorUnits).toBe(800n);
      expect(bal.currency).toBe('USD');
      expect(bal.lastSequenceNo).toBe(1n);
    });

    it('replay converges with getBalance after multiple posts', async () => {
      const creatorId = newCreatorId();
      await postTransaction(makeInput(balancedInvoicePaidEntries(creatorId, 1000n)));
      await postTransaction(makeInput(balancedInvoicePaidEntries(creatorId, 500n)));
      await postTransaction(makeInput(balancedInvoicePaidEntries(creatorId, 250n)));

      const replayResult = await replay('creator', creatorId);
      expect(replayResult.isConvergent).toBe(true);
      expect(replayResult.fromRunningBalance).toBe(replayResult.fromReplay);
      expect(replayResult.entriesScanned).toBe(3);

      const bal = await getBalance('creator', creatorId);
      expect(bal.balanceMinorUnits).toBe(replayResult.fromRunningBalance);
    });

    it('replay on empty account returns 0n/0n/convergent', async () => {
      const r = await replay('creator', newCreatorId());
      expect(r.entriesScanned).toBe(0);
      expect(r.fromRunningBalance).toBe(0n);
      expect(r.fromReplay).toBe(0n);
      expect(r.isConvergent).toBe(true);
    });
  });

  // ── 6. Concurrency ─────────────────────────────────────────────────
  describe('concurrency', () => {
    it('sequence allocation is monotonic under parallel posts to same creator', async () => {
      const creatorId = newCreatorId();
      // Five parallel posts. Each should see a unique sequence_no [1..5].
      const posts = Array.from({ length: 5 }, () =>
        postTransaction(makeInput(balancedInvoicePaidEntries(creatorId, 100n))),
      );
      await Promise.all(posts);

      const replayResult = await replay('creator', creatorId);
      expect(replayResult.isConvergent).toBe(true);
      expect(replayResult.entriesScanned).toBe(5);

      // Final balance: 5 * 80 = 400
      const bal = await getBalance('creator', creatorId);
      expect(bal.balanceMinorUnits).toBe(400n);
      expect(bal.lastSequenceNo).toBe(5n);

      // No sequence gaps.
      const entries = await getLedgerClient().ledgerEntry.findMany({
        where: { accountScope: 'creator', accountId: creatorId },
        orderBy: { sequenceNo: 'asc' },
        select: { sequenceNo: true },
      });
      expect(entries.map((e) => e.sequenceNo)).toEqual([1n, 2n, 3n, 4n, 5n]);
    });
  });

  // ── 7. DB-level enforcement (append-only triggers + CHECK) ─────────
  describe('DB-level enforcement (triggers must fire on direct SQL too)', () => {
    it('UPDATE on ledger_entry is rejected by the trigger', async () => {
      const creatorId = newCreatorId();
      await postTransaction(makeInput(balancedInvoicePaidEntries(creatorId, 1000n)));
      const prisma = getLedgerClient();
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE ledger_entry SET debit_minor_units = 0 WHERE account_scope = 'creator'`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('DELETE on ledger_entry is rejected', async () => {
      const creatorId = newCreatorId();
      await postTransaction(makeInput(balancedInvoicePaidEntries(creatorId, 1000n)));
      const prisma = getLedgerClient();
      await expect(
        prisma.$executeRawUnsafe(`DELETE FROM ledger_entry WHERE account_scope = 'creator'`),
      ).rejects.toThrow(/append-only/);
    });

    it('CHECK constraint rejects insert violating XOR debit/credit', async () => {
      const creatorId = newCreatorId();
      // First create the account so the FK passes.
      await postTransaction(makeInput(balancedInvoicePaidEntries(creatorId, 1000n)));
      const prisma = getLedgerClient();

      // Direct insert with both debit AND credit > 0 should be rejected.
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO ledger_entry
            (sequence_no, account_scope, account_id, event_type, event_group_id,
             debit_minor_units, credit_minor_units, currency, idempotency_key,
             running_balance_minor_units, effective_at, posted_by)
           VALUES (999, 'creator', '${creatorId}', 'EARNING_GROSS',
                   '${newEventGroupId()}', 100, 100, 'USD', 'direct_test',
                   0, NOW(), 'ops:test')`,
        ),
      ).rejects.toThrow(/ledger_entry_xor_debit_credit|check constraint/i);
    });
  });
});

// Tell developers running locally without docker that the suite was skipped.
if (!run) {
  // eslint-disable-next-line no-console
  console.info(
    '[v2-ledger-integration] RUN_V2_INTEGRATION not set — skipping integration suite. ' +
      'Run `npm run test:v2:integration` to exercise these tests against Postgres.',
  );
}
