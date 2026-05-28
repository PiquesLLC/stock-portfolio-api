// postTransaction — the canonical entry point for writing to the v2 ledger.
//
// Every money-moving fact in the system flows through this function. It:
//   1. Validates application-level invariants (INV-1, INV-2, INV-5 shape,
//      unique idempotency suffixes) up-front with friendly error messages.
//   2. Upserts per-creator accounts on demand (with the entry's declared
//      currency — the DB trigger enforces match on subsequent entries).
//   3. Inserts all entries in one DB transaction. The BEFORE INSERT trigger
//      allocates sequence_no and computes running_balance for each.
//   4. Catches P2002 (idempotency collision) and returns the existing
//      entries with deduplicated=true. Callers are retry-safe by construction.
//
// Caller contract:
//   - All entries share `eventGroupId`.
//   - Σdebits = Σcredits across entries (INV-2). Caller must build a balanced
//     event group; this function rejects unbalanced inputs.
//   - Each entry's currency matches its account's declared currency.
//   - Each entry's idempotencySuffix is unique within the call.
//
// What this function does NOT do:
//   - INV-3 per-event-type fee-split check (caller's responsibility — the
//     specific shape depends on event_type, e.g. invoice.paid expects
//     stripe_clearing debit = creator credit + platform credit).
//   - INV-4 no-negative-balance check (this is a payout-time eligibility
//     concern, not a posting concern; the ledger can hold negative
//     intermediate states during dispute clawback).
//   - INV-6 append-only enforcement (DB triggers — can't be done from app).
//
// On the deduplicated=true return: the caller should treat this as success
// (the desired effect was already achieved by a prior call). The returned
// entries are the canonical, currently-stored entries — NOT a partial echo
// of what this call would have inserted.

import { Prisma } from '../../generated/prisma-v2/client';
import { getLedgerClient } from './prisma';
import {
  AccountScope,
  LedgerEventType,
  PostTransactionInput,
  PostTransactionResult,
  PostedEntry,
} from './types';
import {
  assertInv1,
  assertInv2,
  assertInv5Shape,
  assertUniqueIdempotencySuffixes,
} from './invariants';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function postTransaction(
  input: PostTransactionInput,
): Promise<PostTransactionResult> {
  if (input.entries.length === 0) {
    throw new Error('postTransaction called with empty entries array');
  }
  if (!UUID_REGEX.test(input.eventGroupId)) {
    throw new Error(
      `Invalid eventGroupId UUID format: '${input.eventGroupId}'. Use crypto.randomUUID() or pass a Stripe event id derived UUID.`,
    );
  }

  // ── Application-layer invariant checks (fast-fail before DB round-trip) ──
  for (let i = 0; i < input.entries.length; i++) {
    assertInv1(input.entries[i], i);
    assertInv5Shape(input.entries[i], i);
  }
  assertInv2(input);
  assertUniqueIdempotencySuffixes(input);

  const prisma = getLedgerClient();

  try {
    const posted = await prisma.$transaction(async (tx) => {
      // Upsert per-creator accounts. Other scopes (stripe_clearing,
      // platform_revenue, platform_fee, tax_withholding) must be pre-seeded
      // via prisma-v2/seed.ts — if missing, the trigger raises with a
      // user-visible error message naming the missing account.
      const creatorCurrencyByAccountId = new Map<string, string>();
      for (const entry of input.entries) {
        if (entry.accountScope !== 'creator') continue;
        const existing = creatorCurrencyByAccountId.get(entry.accountId);
        if (existing && existing !== entry.currency) {
          throw new Error(
            `Conflicting currencies for creator:${entry.accountId} within one transaction: ` +
              `'${existing}' and '${entry.currency}'. A single transaction may not mix currencies for one account.`,
          );
        }
        creatorCurrencyByAccountId.set(entry.accountId, entry.currency);
      }
      for (const [accountId, currency] of creatorCurrencyByAccountId.entries()) {
        await tx.account.upsert({
          where: { accountScope_accountId: { accountScope: 'creator', accountId } },
          update: {}, // never touch existing — preserves next_sequence_no
          create: { accountScope: 'creator', accountId, currency },
        });
      }

      // If any entry has reversesEntryId, validate the referent exists.
      // Shape check (debit↔credit inversion, currency/account match) is
      // deferred to a tightening pass — for now we just verify the row
      // exists to catch typos / stale ids.
      const reversesIds = input.entries
        .map((e) => e.reversesEntryId)
        .filter((id): id is string => !!id);
      if (reversesIds.length > 0) {
        const found = await tx.ledgerEntry.findMany({
          where: { id: { in: reversesIds } },
          select: { id: true },
        });
        const foundSet = new Set(found.map((r) => r.id));
        for (let i = 0; i < input.entries.length; i++) {
          const referent = input.entries[i].reversesEntryId;
          if (referent && !foundSet.has(referent)) {
            throw new Error(
              `Entry ${i} reverses non-existent ledger entry ${referent}. ` +
                `Verify the id (was the referent rolled back? typo?).`,
            );
          }
        }
      }

      // Insert all ledger entries. The BEFORE INSERT trigger overrides the
      // sequence_no=0 and runningBalance=0 placeholders we supply with the
      // correct values; we pass them only because Prisma requires non-null
      // for the schema's required columns.
      const postedEntries: PostedEntry[] = [];
      for (const entry of input.entries) {
        const idempotencyKey = `${input.eventGroupId}:${entry.idempotencySuffix}`;
        const created = await tx.ledgerEntry.create({
          data: {
            accountScope: entry.accountScope,
            accountId: entry.accountId,
            eventType: entry.eventType,
            eventGroupId: input.eventGroupId,
            debitMinorUnits: entry.debitMinorUnits,
            creditMinorUnits: entry.creditMinorUnits,
            currency: entry.currency,
            stripeObjectKind: entry.stripeObjectKind ?? null,
            stripeObjectId: entry.stripeObjectId ?? null,
            stripeEventId: entry.stripeEventId ?? null,
            idempotencyKey,
            reversesEntryId: entry.reversesEntryId ?? null,
            // Placeholder; trigger overrides.
            sequenceNo: 0n,
            // Placeholder; trigger overrides.
            runningBalanceMinorUnits: 0n,
            effectiveAt: input.effectiveAt,
            postedBy: input.postedBy,
            metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
          },
        });
        postedEntries.push({
          id: created.id,
          accountScope: created.accountScope as AccountScope,
          accountId: created.accountId,
          sequenceNo: created.sequenceNo,
          eventType: created.eventType as LedgerEventType,
          debitMinorUnits: created.debitMinorUnits,
          creditMinorUnits: created.creditMinorUnits,
          runningBalanceMinorUnits: created.runningBalanceMinorUnits,
        });
      }

      return postedEntries;
    });

    return { eventGroupId: input.eventGroupId, entries: posted, deduplicated: false };
  } catch (err) {
    // Only treat P2002 as dedup if it fired on the IDEMPOTENCY or
    // EVENT-GROUP-TYPE constraints. The third unique constraint —
    // (accountScope, accountId, sequenceNo) — would indicate trigger
    // corruption or manual mutation, NOT a legitimate retry. Silently
    // deduping that would mask a serious bug.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      // Prisma's meta.target shape varies by version: sometimes a string
      // (the index name), sometimes a string[] of column names. Normalize.
      const target = err.meta?.target;
      const targetStr = Array.isArray(target)
        ? target.join(',')
        : String(target ?? '');

      const isIdempotencyCollision =
        targetStr.includes('ledger_entry_idempotency_unique') ||
        targetStr.includes('idempotency_key');
      const isEventGroupTypeCollision =
        targetStr.includes('ledger_entry_eventgroup_type_unique') ||
        (targetStr.includes('event_group_id') &&
          targetStr.includes('event_type'));
      const isSequenceCollision =
        targetStr.includes('ledger_entry_seq_unique') ||
        targetStr.includes('sequence_no');

      if (isSequenceCollision) {
        // The trigger's UPDATE-RETURNING on accounts.next_sequence_no
        // should guarantee unique allocation. A collision here means
        // either (a) the trigger is buggy, (b) someone manually inserted
        // a row bypassing the trigger, or (c) the accounts row was
        // tampered with. Surface loudly — do NOT silently dedup.
        throw new Error(
          `CRITICAL: ledger_entry sequence_no collision for event group ` +
            `${input.eventGroupId}. This indicates trigger corruption, ` +
            `manual mutation, or a race condition we don't understand. ` +
            `Investigate immediately. Original error: ${err.message}`,
        );
      }

      if (!isIdempotencyCollision && !isEventGroupTypeCollision) {
        // Some other P2002 we don't recognize. Don't silently swallow.
        throw new Error(
          `Unexpected P2002 on constraint '${targetStr}' for event group ` +
            `${input.eventGroupId}. Original error: ${err.message}`,
        );
      }

      const existing = await prisma.ledgerEntry.findMany({
        where: { eventGroupId: input.eventGroupId },
        orderBy: [
          { accountScope: 'asc' },
          { accountId: 'asc' },
          { sequenceNo: 'asc' },
        ],
      });
      if (existing.length === 0) {
        // P2002 fired but no rows exist for this eventGroupId — must mean
        // the conflict was on a different eventGroupId sharing the same
        // (account_scope, account_id, idempotency_key). That's a caller
        // bug (reused idempotencySuffix across distinct event groups).
        // Surface the original error.
        throw err;
      }
      return {
        eventGroupId: input.eventGroupId,
        entries: existing.map((e) => ({
          id: e.id,
          accountScope: e.accountScope as AccountScope,
          accountId: e.accountId,
          sequenceNo: e.sequenceNo,
          eventType: e.eventType as LedgerEventType,
          debitMinorUnits: e.debitMinorUnits,
          creditMinorUnits: e.creditMinorUnits,
          runningBalanceMinorUnits: e.runningBalanceMinorUnits,
        })),
        deduplicated: true,
      };
    }
    throw err;
  }
}
