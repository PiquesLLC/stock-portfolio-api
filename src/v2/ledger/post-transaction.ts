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

// UUID v4 or v7 only (third group's first nibble must be 4 or 7).
// Rejects nil UUID and arbitrary uuid-shaped strings.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  // Validate per-account currency consistency within this call. Cross-call
  // currency drift is caught below by loading existing accounts and
  // comparing — we do this here (pre-DB) to fail fast with a clear message.
  const currencyByAccount = new Map<string, string>();
  for (const entry of input.entries) {
    const key = `${entry.accountScope}:${entry.accountId}`;
    const existing = currencyByAccount.get(key);
    if (existing && existing !== entry.currency) {
      throw new Error(
        `Conflicting currencies for ${key} within one transaction: ` +
          `'${existing}' and '${entry.currency}'. A single transaction may not mix ` +
          `currencies for one account.`,
      );
    }
    currencyByAccount.set(key, entry.currency);
  }

  const prisma = getLedgerClient();

  try {
    // READ COMMITTED is REQUIRED by the trigger's UPDATE-RETURNING sequence
    // allocator. REPEATABLE READ / SERIALIZABLE would either deadlock or
    // produce running_balance corruption. Pin it explicitly so a future
    // Prisma default change or DATABASE_URL parameter can't silently shift.
    const posted = await prisma.$transaction(
      async (tx) => {
        // ── Account setup ────────────────────────────────────────────────
        //
        // 1. Load all referenced accounts in one query.
        // 2. For any non-creator that's MISSING: fail loud (misconfigured
        //    seed — these must be pre-seeded by prisma-v2/seed.ts).
        // 3. For any existing account whose currency differs from what this
        //    call declares: fail loud (currency drift — would otherwise
        //    surface as an opaque trigger plpgsql error).
        // 4. For creator accounts that don't exist yet: insert via
        //    `INSERT ... ON CONFLICT DO NOTHING`. Prisma's `upsert` is NOT
        //    atomic on Postgres (it issues SELECT then INSERT/UPDATE) so
        //    two concurrent first-time calls for the same creator can both
        //    INSERT and the loser receives P2002 on accounts_pkey.
        const accountKeys = Array.from(currencyByAccount.keys()).map((k) => {
          const [scope, ...rest] = k.split(':');
          return { accountScope: scope as AccountScope, accountId: rest.join(':') };
        });

        const existingAccounts = await tx.account.findMany({
          where: {
            OR: accountKeys.map((a) => ({
              accountScope: a.accountScope,
              accountId: a.accountId,
            })),
          },
          select: { accountScope: true, accountId: true, currency: true },
        });
        const existingByKey = new Map(
          existingAccounts.map((a) => [`${a.accountScope}:${a.accountId}`, a]),
        );

        for (const [key, declaredCurrency] of currencyByAccount.entries()) {
          const existing = existingByKey.get(key);
          if (existing) {
            const stored = existing.currency.trim();
            if (stored !== declaredCurrency) {
              throw new Error(
                `Account ${key} exists with currency '${stored}' but this ` +
                  `transaction declares '${declaredCurrency}'. A creator/system ` +
                  `account's currency is immutable after the first entry.`,
              );
            }
            continue;
          }
          // Missing account.
          const [scope, ...rest] = key.split(':');
          const accountId = rest.join(':');
          if (scope !== 'creator') {
            throw new Error(
              `System account ${key} is missing. Non-creator accounts ` +
                `(stripe_clearing, platform_revenue, platform_fee, ` +
                `tax_withholding) must be pre-seeded via prisma-v2/seed.ts. ` +
                `Run: npm run prisma:v2:seed`,
            );
          }
          // Race-safe creator account insert.
          await tx.$executeRaw`
            INSERT INTO accounts (account_scope, account_id, currency, next_sequence_no, created_at)
            VALUES (${scope}, ${accountId}, ${declaredCurrency}, 1, NOW())
            ON CONFLICT (account_scope, account_id) DO NOTHING
          `;
        }

        // ── Reversal shape validation (INV-5) ────────────────────────────
        //
        // For each entry with reversesEntryId set: load the referent and
        // verify (a) it exists, (b) same account, (c) same currency, (d) it
        // is the EXACT inverse (referent.debit == this.credit and vice
        // versa). The FK guarantees only existence post-commit — the shape
        // check protects against e.g. a clawback for $5 against a referent
        // that recorded $50, which would otherwise post happily and leave
        // the books permanently $45 off.
        const reversesIds = input.entries
          .map((e) => e.reversesEntryId)
          .filter((id): id is string => !!id);
        if (reversesIds.length > 0) {
          const referents = await tx.ledgerEntry.findMany({
            where: { id: { in: reversesIds } },
            select: {
              id: true,
              accountScope: true,
              accountId: true,
              currency: true,
              debitMinorUnits: true,
              creditMinorUnits: true,
            },
          });
          const referentById = new Map(referents.map((r) => [r.id, r]));
          for (let i = 0; i < input.entries.length; i++) {
            const entry = input.entries[i];
            if (!entry.reversesEntryId) continue;
            const referent = referentById.get(entry.reversesEntryId);
            if (!referent) {
              throw new Error(
                `Entry ${i} reverses non-existent ledger entry ` +
                  `${entry.reversesEntryId}. Verify the id (typo / rolled back?).`,
              );
            }
            if (
              referent.accountScope !== entry.accountScope ||
              referent.accountId !== entry.accountId
            ) {
              throw new Error(
                `INV-5: entry ${i} reverses ${entry.reversesEntryId} but ` +
                  `accounts differ. Referent: ${referent.accountScope}:${referent.accountId}. ` +
                  `Reversal: ${entry.accountScope}:${entry.accountId}.`,
              );
            }
            if (referent.currency.trim() !== entry.currency) {
              throw new Error(
                `INV-5: entry ${i} reverses ${entry.reversesEntryId} but ` +
                  `currencies differ. Referent: '${referent.currency.trim()}'. ` +
                  `Reversal: '${entry.currency}'.`,
              );
            }
            if (
              referent.debitMinorUnits !== entry.creditMinorUnits ||
              referent.creditMinorUnits !== entry.debitMinorUnits
            ) {
              throw new Error(
                `INV-5: entry ${i} reverses ${entry.reversesEntryId} but is ` +
                  `not the exact inverse. ` +
                  `Referent: debit=${referent.debitMinorUnits} credit=${referent.creditMinorUnits}. ` +
                  `Reversal: debit=${entry.debitMinorUnits} credit=${entry.creditMinorUnits}. ` +
                  `A reversal must satisfy: referent.debit == reversal.credit AND ` +
                  `referent.credit == reversal.debit.`,
              );
            }
          }
        }

        // ── Ledger entry insert ──────────────────────────────────────────
        //
        // createManyAndReturn batches all inserts into one round-trip. The
        // BEFORE INSERT trigger fires per row, overriding the sequence_no=0
        // and running_balance=0 placeholders we supply. We pass placeholders
        // because Prisma requires non-null for required columns.
        //
        // RETURNING order matches the VALUES order, but we map by
        // idempotency_key defensively in case Postgres reorders.
        const rowsToInsert = input.entries.map((entry) => ({
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
          idempotencyKey: `${input.eventGroupId}:${entry.idempotencySuffix}`,
          reversesEntryId: entry.reversesEntryId ?? null,
          // Placeholder; trigger overrides.
          sequenceNo: 0n,
          // Placeholder; trigger overrides.
          runningBalanceMinorUnits: 0n,
          effectiveAt: input.effectiveAt,
          postedBy: input.postedBy,
          metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
        }));

        const created = await tx.ledgerEntry.createManyAndReturn({
          data: rowsToInsert,
        });

        const createdByKey = new Map(created.map((c) => [c.idempotencyKey, c]));
        const postedEntries: PostedEntry[] = input.entries.map((entry) => {
          const key = `${input.eventGroupId}:${entry.idempotencySuffix}`;
          const row = createdByKey.get(key);
          if (!row) {
            throw new Error(
              `Internal: createManyAndReturn missing row for idempotency_key '${key}'. ` +
                `Prisma version may have changed RETURNING semantics.`,
            );
          }
          return {
            id: row.id,
            accountScope: row.accountScope as AccountScope,
            accountId: row.accountId,
            sequenceNo: row.sequenceNo,
            eventType: row.eventType as LedgerEventType,
            debitMinorUnits: row.debitMinorUnits,
            creditMinorUnits: row.creditMinorUnits,
            runningBalanceMinorUnits: row.runningBalanceMinorUnits,
          };
        });

        return postedEntries;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

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

      // ── Intent-divergence check ────────────────────────────────────────
      //
      // A P2002 on idempotency means: an entry with this exact
      // idempotency_key already exists. If the caller is retrying the SAME
      // intent, the stored entry's amounts/types match the requested
      // entry's — fine, that's a benign retry, ack as deduped.
      //
      // But if the caller is sending DIFFERENT amounts or event-types
      // against the same key, the system has been instructed to record two
      // conflicting facts under one key. That's a caller bug OR a malicious
      // replay attack. Either way, do NOT silently ack — surface loudly.
      //
      // Check: same number of entries, same (account, event_type, debit,
      // credit, currency) for every key.
      if (existing.length !== input.entries.length) {
        throw new Error(
          `CRITICAL: dedup intent divergence for event group ${input.eventGroupId}. ` +
            `Stored ${existing.length} entries but request has ${input.entries.length}. ` +
            `Caller is reusing an event group id with a different entry shape. ` +
            `Investigate: this may be a buggy caller or a replay attack.`,
        );
      }
      const storedByKey = new Map(existing.map((e) => [e.idempotencyKey, e]));
      for (let i = 0; i < input.entries.length; i++) {
        const requested = input.entries[i];
        const key = `${input.eventGroupId}:${requested.idempotencySuffix}`;
        const stored = storedByKey.get(key);
        if (!stored) {
          throw new Error(
            `CRITICAL: dedup intent divergence for event group ${input.eventGroupId}. ` +
              `Requested entry ${i} (suffix '${requested.idempotencySuffix}') has no ` +
              `matching stored row. Caller is reusing the event group id with different ` +
              `idempotency suffixes than the original call.`,
          );
        }
        if (
          stored.accountScope !== requested.accountScope ||
          stored.accountId !== requested.accountId ||
          stored.eventType !== requested.eventType ||
          stored.debitMinorUnits !== requested.debitMinorUnits ||
          stored.creditMinorUnits !== requested.creditMinorUnits ||
          stored.currency.trim() !== requested.currency
        ) {
          throw new Error(
            `CRITICAL: idempotency key '${key}' reused for different intent. ` +
              `Stored: ${stored.accountScope}:${stored.accountId} ` +
              `type=${stored.eventType} debit=${stored.debitMinorUnits} ` +
              `credit=${stored.creditMinorUnits} currency='${stored.currency.trim()}'. ` +
              `Requested: ${requested.accountScope}:${requested.accountId} ` +
              `type=${requested.eventType} debit=${requested.debitMinorUnits} ` +
              `credit=${requested.creditMinorUnits} currency='${requested.currency}'. ` +
              `This indicates either a buggy caller reusing keys for different events, ` +
              `or a replay attack with modified amounts. Do NOT ack as success.`,
          );
        }
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
