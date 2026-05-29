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

// Valid AccountScope values. Runtime check guards against callers casting
// strings to AccountScope via `as` — TypeScript can't enforce that.
const VALID_SCOPES = new Set<AccountScope>([
  'creator',
  'stripe_clearing',
  'platform_revenue',
  'platform_fee',
  'tax_withholding',
]);

// Valid system (non-creator) account ids. Hardcoded list — these accounts
// are all pre-seeded; an entry against a non-listed system account is a bug.
const VALID_SYSTEM_ACCOUNT_IDS = new Set(['platform']);

// Valid event types. Runtime check defends against typos like
// `'EARNING_GROSS '` (trailing space) which would bypass the
// (eventGroupId, accountScope, eventType) unique constraint and allow
// duplicate "real" entries to coexist under the same event.
const VALID_EVENT_TYPES = new Set<LedgerEventType>([
  'EARNING_GROSS',
  'PLATFORM_FEE',
  'STRIPE_FEE_PASS',
  'TAX_WITHHOLDING',
  'PAYOUT_INITIATED',
  'PAYOUT_PAID',
  'ADJUSTMENT_CREDIT',
  'ADJUSTMENT_DEBIT',
  'EARNING_REFUNDED',
  'PLATFORM_FEE_REFUNDED',
  'DISPUTE_FROZEN',
  'DISPUTE_LOST',
  'DISPUTE_WON',
  'RESTORE_AFTER_DISPUTE_WON',
  'PAYOUT_FAILED',
  'PAYOUT_REVERSED',
]);

const VALID_STRIPE_OBJECT_KINDS = new Set<string>([
  'charge',
  'transfer',
  'payout',
  'dispute',
  'refund',
]);

// postedBy shape. Format is `<actor>:<context>` where actor names the source
// of the write and context disambiguates within that actor. Examples:
//   'webhook:invoice.paid', 'job:payout-runner', 'cron:reconciliation-tier-2',
//   'ops:userid-237198da', 'migration:backfill-v1', 'test:integration'.
const POSTED_BY_REGEX = /^(webhook|job|cron|ops|api|migration|test):[a-z0-9_:.\-]{1,200}$/;

// ISO-4217 currency: 3 uppercase letters. We never auto-uppercase — silent
// case mutation hides bugs and creates currency-string-case schism in storage.
const CURRENCY_REGEX = /^[A-Z]{3}$/;

// effectiveAt bounds: protect reconciliation from gibberish dates.
// 1 day in the future allows clock skew / forward-dated effective times.
// 730 days in the past covers annual-subscription chargeback reversals,
// dispute arbitration outcomes, and 1099-K year-end true-ups that can
// arrive >365 days after the original event. Backfills beyond this need
// migration tooling (which is exempt via `migration:` postedBy prefix).
const EFFECTIVE_AT_MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const EFFECTIVE_AT_MAX_PAST_MS = 730 * 24 * 60 * 60 * 1000;

// Canonical JSON for metadata comparison in the dedup intent-divergence
// check. The fundamental challenge: JS values that JSON can't natively
// represent (Date, BigInt, undefined) round-trip ASYMMETRICALLY through
// Postgres JSONB. Two examples:
//   - Date instance has no own enumerable string keys, so a naive
//     `Object.keys().sort()` recursion returns '{}' for any Date — making
//     all Dates compare equal. Postgres stores Date as the ISO-8601 string
//     produced by Date.toJSON().
//   - `undefined` values are stripped by JSON.stringify; Postgres stores
//     no such key. A requested-side `{x: undefined}` vs stored-side `{}`
//     must compare equal.
//   - BigInt isn't JSON-representable and JSON.stringify throws on it.
//
// Solution: validate metadata is JSON-serializable up-front (rejects
// BigInt and circular refs), then round-trip through JSON to apply
// Date.toJSON and strip undefined symmetrically before canonical sort.
export function validateMetadataIsJsonable(metadata: unknown, entryIndex: number): void {
  if (metadata === undefined) return;
  // ORDER MATTERS: stringify FIRST to catch BigInt / cycles via the native
  // TypeError. rejectNonFiniteNumbers below has no cycle protection — it
  // would stack-overflow on a cyclic input. If you reorder these calls,
  // add a WeakSet-based visited check inside rejectNonFiniteNumbers first.
  try {
    JSON.stringify(metadata);
  } catch (e) {
    throw new Error(
      `Entry ${entryIndex}: metadata is not JSON-serializable. ` +
        `BigInt values, circular refs, and other non-JSON types are forbidden in metadata. ` +
        `Cause: ${(e as Error).message}`,
    );
  }
  // Walk the tree and reject values that JSON.stringify silently mangles
  // (non-finite numbers, functions, symbols). These would otherwise be
  // serialized as null or dropped entirely — asymmetric corruption identical
  // to the BigInt bug caught by the stringify above. Safe to recurse without
  // cycle protection because stringify already verified the tree is acyclic.
  rejectNonStorageValues(metadata, entryIndex, '');
}

function rejectNonStorageValues(v: unknown, entryIndex: number, path: string): void {
  if (v === null) return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(
        `Entry ${entryIndex}: metadata${path} contains non-finite number ${String(v)}. ` +
          `NaN, Infinity, and -Infinity are silently coerced to null by JSON and ` +
          `would corrupt the stored value asymmetrically. Reject up-front.`,
      );
    }
    return;
  }
  if (typeof v === 'function') {
    // JSON.stringify silently DROPS function values (returns no key for
    // them) — same asymmetric-corruption class as NaN/Infinity. Reject.
    throw new Error(
      `Entry ${entryIndex}: metadata${path} contains a function. ` +
        `Functions are silently dropped by JSON serialization and have no ` +
        `defensible place in a financial audit log. Reject up-front.`,
    );
  }
  if (typeof v === 'symbol') {
    // JSON.stringify silently DROPS symbol-keyed values and produces
    // 'undefined' for top-level symbols — same corruption class.
    throw new Error(
      `Entry ${entryIndex}: metadata${path} contains a Symbol. ` +
        `Symbols are silently dropped by JSON serialization and have no ` +
        `defensible place in a financial audit log. Reject up-front.`,
    );
  }
  if (typeof v !== 'object') return;
  if (Array.isArray(v)) {
    v.forEach((item, i) => rejectNonStorageValues(item, entryIndex, `${path}[${i}]`));
    return;
  }
  for (const k of Object.keys(v as Record<string, unknown>)) {
    rejectNonStorageValues((v as Record<string, unknown>)[k], entryIndex, `${path}.${k}`);
  }
}

// Strip the writer-identity `source` key from a metadata object before
// canonicalizing for divergence comparison. Lets shadow-write tag
// `{source: 'v2-shadow-write'}` and MIG-1 tag `{source: 'v1-backfill'}`
// without tripping the divergence check on cross-writer convergence.
//
// Also collapses the resulting empty-object case (`{}`) to `null` so that
// a writer that supplied ONLY a source tag normalizes identically to a
// writer that supplied no metadata at all.
export function stripSourceTag(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return v;
  const obj = v as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (k !== 'source') stripped[k] = obj[k];
  }
  return Object.keys(stripped).length === 0 ? null : stripped;
}

export function canonicalMetadata(v: unknown): string {
  // Normalize through JSON round-trip first — this applies Date.toJSON
  // (Date → ISO string), strips undefined values, and produces a tree of
  // only JSON-native types. Mirrors what Postgres JSONB stores.
  const normalized = v === undefined ? null : JSON.parse(JSON.stringify(v));
  return canonicalJsonInner(normalized);
}

function canonicalJsonInner(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJsonInner).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ':' +
          canonicalJsonInner((v as Record<string, unknown>)[k]),
      )
      .join(',') +
    '}'
  );
}

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

  // ── effectiveAt bounds ───────────────────────────────────────────────────
  // Block sentinel/gibberish dates that would corrupt reconciliation date
  // ranges. 1-day forward window covers clock skew; 730-day backward window
  // covers Stripe replay + late-arriving dispute arbitration + annual-sub
  // chargeback reversals. `migration:` actor bypasses the past-window bound
  // for explicit deeper backfills.
  if (!(input.effectiveAt instanceof Date) || Number.isNaN(input.effectiveAt.getTime())) {
    throw new Error(
      `Invalid effectiveAt: must be a valid Date. Got: ${String(input.effectiveAt)}`,
    );
  }
  // ── postedBy shape (must come before effectiveAt bounds — migration
  //    actor bypasses past-window restriction) ───────────────────────────
  if (!POSTED_BY_REGEX.test(input.postedBy)) {
    throw new Error(
      `Invalid postedBy '${input.postedBy}'. Must match ` +
        `<actor>:<context> where actor ∈ {webhook, job, cron, ops, api, migration, test} ` +
        `and context is 1-200 chars of [a-z0-9_:.-].`,
    );
  }
  const isMigrationPath = input.postedBy.startsWith('migration:');
  // `migration:` prefix bypasses the 730-day past-window, but is only
  // honored when the deploy explicitly sets NALA_ALLOW_MIGRATION_BACKFILL.
  // This prevents an attacker who can influence postedBy (e.g. via a
  // webhook payload that controls part of the actor string) from
  // backdating arbitrarily. Migration jobs set the env explicitly; the
  // webhook deploy does not.
  if (isMigrationPath && process.env.NALA_ALLOW_MIGRATION_BACKFILL !== 'true') {
    throw new Error(
      `postedBy '${input.postedBy}' uses the migration: prefix, but ` +
        `NALA_ALLOW_MIGRATION_BACKFILL is not set in this environment. ` +
        `Migration backfills require explicit env opt-in. Set the env to 'true' ` +
        `in the migration job's environment, not in the webhook/API deploy.`,
    );
  }

  const nowMs = Date.now();
  const effMs = input.effectiveAt.getTime();
  if (effMs > nowMs + EFFECTIVE_AT_MAX_FUTURE_MS) {
    throw new Error(
      `effectiveAt ${input.effectiveAt.toISOString()} is more than 1 day in the future. ` +
        `Reject as suspect — verify the source event's timestamp.`,
    );
  }
  if (!isMigrationPath && effMs < nowMs - EFFECTIVE_AT_MAX_PAST_MS) {
    throw new Error(
      `effectiveAt ${input.effectiveAt.toISOString()} is more than 730 days in the past. ` +
        `Live posting paths reject this as suspect; use postedBy='migration:<name>' ` +
        `in a deploy with NALA_ALLOW_MIGRATION_BACKFILL=true for explicit deeper backfills.`,
    );
  }

  // ── accountScope + accountId shape per scope ─────────────────────────────
  for (let i = 0; i < input.entries.length; i++) {
    const e = input.entries[i];
    if (!VALID_SCOPES.has(e.accountScope)) {
      // Runtime guard — TypeScript can't prevent `as AccountScope` casts at
      // call sites, and a misspelled scope ('creators') would otherwise
      // reach the DB and fail with an opaque FK error.
      throw new Error(
        `Entry ${i}: unknown accountScope '${e.accountScope}'. ` +
          `Valid: ${Array.from(VALID_SCOPES).join(', ')}.`,
      );
    }
    if (e.accountScope === 'creator') {
      // Creator accountId == userId, which is a UUID in v1 and v2.
      if (!UUID_REGEX.test(e.accountId)) {
        throw new Error(
          `Entry ${i}: creator accountId '${e.accountId}' must be a UUID v4 or v7. ` +
            `Creator account ids are user ids.`,
        );
      }
    } else if (!VALID_SYSTEM_ACCOUNT_IDS.has(e.accountId)) {
      throw new Error(
        `Entry ${i}: system account ${e.accountScope}:${e.accountId} has an unknown account id. ` +
          `Valid system account ids: ${Array.from(VALID_SYSTEM_ACCOUNT_IDS).join(', ')}.`,
      );
    }
    if (!VALID_EVENT_TYPES.has(e.eventType)) {
      // Typos like 'EARNING_GROSS ' (trailing space) would bypass the
      // (eventGroupId, accountScope, eventType) unique constraint.
      throw new Error(
        `Entry ${i}: unknown eventType '${e.eventType}'. ` +
          `Valid: ${Array.from(VALID_EVENT_TYPES).join(', ')}.`,
      );
    }
    if (e.stripeObjectKind !== undefined && e.stripeObjectKind !== null &&
        !VALID_STRIPE_OBJECT_KINDS.has(e.stripeObjectKind)) {
      throw new Error(
        `Entry ${i}: unknown stripeObjectKind '${e.stripeObjectKind}'. ` +
          `Valid: ${Array.from(VALID_STRIPE_OBJECT_KINDS).join(', ')}.`,
      );
    }
    if (!CURRENCY_REGEX.test(e.currency)) {
      throw new Error(
        `Entry ${i}: currency '${e.currency}' must be 3 uppercase letters (ISO-4217). ` +
          `Lowercase / non-letters are rejected to prevent case-schism in storage.`,
      );
    }
    validateMetadataIsJsonable(e.metadata, i);
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
  //
  // ALSO: enforce ONE-ENTRY-PER-ACCOUNT-PER-CALL. The BEFORE INSERT trigger
  // computes running_balance by SELECT-ing the predecessor row's value.
  // Under Postgres MVCC, the predecessor inserted by the SAME multi-row
  // INSERT statement has cmin == current command id and is NOT visible to
  // the next row's trigger SELECT. So if a call posts 2+ entries against
  // the same (account_scope, account_id), entries 2..N would compute
  // running_balance from a NULL predecessor (COALESCEd to 0), silently
  // corrupting the cached running balance. replay() would catch the
  // divergence later, but getBalance() would return wrong totals in the
  // meantime — and a payout consulting a corrupt cached balance could
  // overpay.
  //
  // This restriction matches the v2 architecture (each event group writes
  // one entry per affected account — creator, platform_revenue,
  // platform_fee, stripe_clearing, etc., each a distinct account). If a
  // future workflow needs multiple entries on the same account, split it
  // into multiple postTransaction calls (each gets its own statement and
  // its own snapshot).
  const currencyByAccount = new Map<string, string>();
  const entryCountByAccount = new Map<string, number>();
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
    entryCountByAccount.set(key, (entryCountByAccount.get(key) ?? 0) + 1);
  }
  for (const [key, count] of entryCountByAccount.entries()) {
    if (count > 1) {
      throw new Error(
        `${count} entries against account ${key} in one postTransaction call. ` +
          `Multi-entry-same-account batches are not supported: the running_balance ` +
          `trigger reads the predecessor via SELECT, which does NOT see same-` +
          `statement inserts under Postgres MVCC. Split into ${count} separate ` +
          `postTransaction calls (each its own statement, its own snapshot).`,
      );
    }
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
          // Race-window: another concurrent first-time call for this same
          // new creator may have inserted with a DIFFERENT currency
          // moments before us. ON CONFLICT DO NOTHING silently no-ops in
          // that case; without this re-check, we'd proceed to the ledger
          // insert and the trigger's currency-match check would surface
          // as an opaque plpgsql error. Re-SELECT and validate explicitly.
          const justInserted = await tx.account.findUnique({
            where: { accountScope_accountId: { accountScope: scope as AccountScope, accountId } },
            select: { currency: true },
          });
          const justInsertedCurrency = justInserted?.currency.trim();
          if (justInsertedCurrency && justInsertedCurrency !== declaredCurrency) {
            throw new Error(
              `Account ${key} was just created by a concurrent transaction ` +
                `with currency '${justInsertedCurrency}', but this transaction ` +
                `declares '${declaredCurrency}'. Currency drift detected at ` +
                `creation race. Investigate which caller is wrong.`,
            );
          }
        }

        // ── Reversal shape validation (INV-5) ────────────────────────────
        //
        // `reversesEntryId` is for FULL reversals only — a $50 charge fully
        // reversed by a $50 debit. The exact-inverse check below protects
        // against e.g. a $5 clawback against a $50 referent that would
        // otherwise leave the books permanently $45 off.
        //
        // PARTIAL REVERSALS (Stripe partial refunds, partial dispute losses)
        // are CURRENTLY UNSUPPORTED at this layer. The structural double-
        // clawback guarantee (partial unique on reverses_entry_id → one
        // referent at most one reversal) cannot be expressed for partials
        // without per-referent cumulative magnitude tracking, which is
        // a deferred architecture item. Callers that need partial-refund
        // semantics today must implement out-of-band magnitude tracking
        // (e.g. a separate refund-state table that records "of $X
        // original, $Y refunded so far, $Z remaining") BEFORE posting any
        // partial. The ledger has no built-in protection against e.g. two
        // distinct webhook calls each posting a $50 EARNING_REFUNDED for
        // the same $50 EARNING_GROSS — without external magnitude
        // tracking, the books would silently go $50 negative.
        // DO NOT route partial refunds through this function as
        // standalone entries until magnitude tracking lands.
        //
        // For each entry with reversesEntryId set: load the referent and
        // verify (a) it exists, (b) same account, (c) same currency, (d) it
        // is the EXACT inverse (referent.debit == this.credit and vice
        // versa).
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
                  `referent.credit == reversal.debit. ` +
                  `PARTIAL refunds/clawbacks are NOT supported at this layer — ` +
                  `the ledger has no magnitude tracking against the referent, so ` +
                  `posting partials as standalone EARNING_REFUNDED entries without ` +
                  `external state tracking can over-refund (two distinct webhook ` +
                  `deliveries each posting a $50 refund of a $50 charge → $50 ` +
                  `negative balance). If you need partial-refund handling, ` +
                  `implement an out-of-band refund-state table FIRST and consult ` +
                  `the architecture doc on magnitude tracking.`,
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
      const isReversesCollision =
        targetStr.includes('ledger_entry_reverses_unique') ||
        targetStr.includes('reverses_entry_id');

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

      if (isReversesCollision) {
        // The partial unique on reverses_entry_id prevents double clawback —
        // a single referent may be reversed at most once. Two concurrent
        // dispute handlers attempting to reverse the same charge both fire
        // here; the loser surfaces this error. This is NOT a bug in our
        // code — it's the constraint working as designed. Caller should
        // treat as "referent already reversed, do nothing further" but we
        // surface as a distinct error so the caller can decide.
        const reversesId = input.entries.find((e) => e.reversesEntryId)?.reversesEntryId;
        throw new Error(
          `Referent ledger entry ${reversesId ?? '<unknown>'} has already been reversed. ` +
            `A referent may be reversed at most once. If this is a concurrent ` +
            `dispute/clawback handler, the other handler won — drop this attempt. ` +
            `If this is unexpected, investigate the prior reversal. ` +
            `Original error: ${err.message}`,
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
      // Map by FULL (accountScope, accountId, idempotency_key) triple — the
      // DB's idempotency unique is on this triple, NOT on idempotency_key
      // alone. Two entries in one event group CAN legitimately share the
      // same idempotency_key if they're on different accounts (e.g., a
      // shared suffix like 'share' used on both creator:X and
      // platform_revenue:platform). Keying by just `idempotencyKey` would
      // collapse them in the map and false-positive on dedup.
      const storedByKey = new Map(
        existing.map((e) => [
          `${e.accountScope}|${e.accountId}|${e.idempotencyKey}`,
          e,
        ]),
      );
      for (let i = 0; i < input.entries.length; i++) {
        const requested = input.entries[i];
        const idemKey = `${input.eventGroupId}:${requested.idempotencySuffix}`;
        const lookupKey = `${requested.accountScope}|${requested.accountId}|${idemKey}`;
        const stored = storedByKey.get(lookupKey);
        if (!stored) {
          throw new Error(
            `CRITICAL: dedup intent divergence for event group ${input.eventGroupId}. ` +
              `Requested entry ${i} (account ${requested.accountScope}:${requested.accountId}, ` +
              `suffix '${requested.idempotencySuffix}') has no matching stored row. ` +
              `Caller is reusing the event group id with a different entry shape ` +
              `than the original call.`,
          );
        }
        // Compare every per-entry field that represents MONETARY INTENT.
        // Writer-identity fields (effectiveAt, postedBy, stripeObjectKind,
        // stripeObjectId, stripeEventId, metadata.source) are EXCLUDED
        // because two legitimate writers of the same source event — e.g.,
        // the live webhook shadow-writer and the MIG-1 backfill — produce
        // different values for those fields but represent the SAME money
        // movement. The eventGroupId is derived deterministically from the
        // source event id, so identity of the source is already pinned;
        // comparing writer-side observational metadata would cause
        // CRITICAL throws on legitimate cross-writer convergence.
        //
        // Trigger-populated fields (sequence_no, running_balance_minor_units,
        // posted_at) are also NOT compared — derived state.
        //
        // What CAN'T drift: account, eventType, amounts, currency, and the
        // reversal pointer. An attacker replaying with modified amounts
        // still trips the check.
        const divergences: string[] = [];
        if (stored.accountScope !== requested.accountScope) {
          divergences.push(`accountScope: stored='${stored.accountScope}' vs requested='${requested.accountScope}'`);
        }
        if (stored.accountId !== requested.accountId) {
          divergences.push(`accountId: stored='${stored.accountId}' vs requested='${requested.accountId}'`);
        }
        if (stored.eventType !== requested.eventType) {
          divergences.push(`eventType: stored='${stored.eventType}' vs requested='${requested.eventType}'`);
        }
        if (stored.debitMinorUnits !== requested.debitMinorUnits) {
          divergences.push(`debit: stored=${stored.debitMinorUnits} vs requested=${requested.debitMinorUnits}`);
        }
        if (stored.creditMinorUnits !== requested.creditMinorUnits) {
          divergences.push(`credit: stored=${stored.creditMinorUnits} vs requested=${requested.creditMinorUnits}`);
        }
        if (stored.currency.trim() !== requested.currency) {
          divergences.push(`currency: stored='${stored.currency.trim()}' vs requested='${requested.currency}'`);
        }
        if ((stored.reversesEntryId ?? null) !== (requested.reversesEntryId ?? null)) {
          divergences.push(`reversesEntryId: stored=${stored.reversesEntryId ?? 'null'} vs requested=${requested.reversesEntryId ?? 'null'}`);
        }
        // Metadata comparison strips the 'source' key (writer-identity tag)
        // before canonicalizing. Other metadata still compared strictly —
        // a caller changing `metadata.note` from "first attempt" to
        // "second attempt" still trips the check (caller bug indicator).
        const storedMetaCanon = canonicalMetadata(stripSourceTag(stored.metadata ?? {}));
        const requestedMetaCanon = canonicalMetadata(stripSourceTag(requested.metadata ?? {}));
        if (storedMetaCanon !== requestedMetaCanon) {
          divergences.push(`metadata: stored=${storedMetaCanon} vs requested=${requestedMetaCanon}`);
        }

        if (divergences.length > 0) {
          throw new Error(
            `CRITICAL: idempotency key '${idemKey}' (account ${requested.accountScope}:${requested.accountId}) ` +
              `reused for different intent. ` +
              `Divergence(s): ${divergences.join('; ')}. ` +
              `This indicates either a buggy caller reusing keys for different events, ` +
              `or a replay attack with modified fields. Do NOT ack as success.`,
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
