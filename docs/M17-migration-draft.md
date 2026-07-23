# M-17 Migration Draft — portfolio-scope the holding-delete cascade

**Status:** CODE IMPLEMENTED on branch `fix/financial-audit-2026-07-13` — schema (Step 1),
write-site `portfolioId` threading (Step 4), and the scoped `deleteHolding` (Step 5), with
tests. Verified: `prisma generate` clean, `tsc` 0 errors, full suite green. **REMAINING = the
DATABASE steps 2 (add columns) and 3 (backfill), to be run by an operator against a backup**
(the code is safe before they run: unscoped delete for single-portfolio tickers, and the
multi-portfolio scoped delete simply matches nothing until portfolioId is populated). No
database has been modified.
**Author:** audit 2026-07-12. **Severity:** data loss (High).

## Problem

`deleteHolding` (`src/services/portfolio.service.ts:150-157`) removes a ticker's
history by `(ticker, userId)` with **no portfolio scope**:

```ts
await tx.lot.deleteMany({ where: { ticker: normalizedTicker, userId } });
await tx.portfolioTrade.deleteMany({ where: { ticker: normalizedTicker, userId } });
await tx.dividendCredit.deleteMany({ where: { ticker: normalizedTicker, userId } });
await tx.dividendReinvestment.deleteMany({ where: { ticker: normalizedTicker, userId } });
await tx.holding.delete({ where: { id: existing.id } });
```

`Lot`, `PortfolioTrade`, `DividendCredit`, and `DividendReinvestment` have **no
`portfolioId`** column (schema lines 538, 1022, 500, 520). So a user who holds the
same ticker in two portfolios and removes it from one **loses that ticker's lots,
trades, and dividend history for the OTHER portfolio too**, corrupting its cost
basis and realized/ledger-replay history. The `Holding.delete` itself is correctly
scoped (one row); only the four cascades are unscoped.

Scope of impact: any user with the same ticker in >1 portfolio who deletes it from
one. Single-portfolio users (the majority) are unaffected in outcome but still rely
on unscoped deletes.

## Design

1. Add a **nullable** `portfolioId` FK to the four tables (nullable so existing rows
   validate and genuinely ambiguous rows can stay `NULL`).
2. Set `portfolioId` on all **new** writes.
3. **Backfill** existing rows whose `(userId, ticker)` maps to exactly one holding;
   leave `NULL` for ambiguous (ticker in >1 portfolio) or orphaned (ticker fully
   removed) rows and report them.
4. **Scope `deleteHolding`** by `portfolioId`, with safe `NULL` handling.

Nullable-first keeps every step additive and reversible.

---

## Step 0 — Immediate mitigation (safe to ship NOW, independent of the schema change)

Stops the data loss today without any migration: when the ticker exists in more than
one of the user's portfolios, skip the four cascades (delete only the `Holding` row).
This leaves orphaned history rows (harmless) instead of wiping another portfolio's
data. Single-portfolio deletes are unchanged.

```ts
const cascade = async (tx: Prisma.TransactionClient) => {
  const holdingCount = await tx.holding.count({
    where: { userId, ticker: normalizedTicker },
  });
  // Only cascade history deletes when this is the user's ONLY holding of the ticker.
  // With the ticker in >1 portfolio we cannot tell which rows belong to this
  // portfolio (no portfolioId yet), so we must NOT delete history — that wiped the
  // other portfolio's lots/trades/dividends (M-17). Full fix = Steps 1-4 below.
  if (holdingCount <= 1) {
    await tx.lot.deleteMany({ where: { ticker: normalizedTicker, userId } });
    await tx.portfolioTrade.deleteMany({ where: { ticker: normalizedTicker, userId } });
    await tx.dividendCredit.deleteMany({ where: { ticker: normalizedTicker, userId } });
    await tx.dividendReinvestment.deleteMany({ where: { ticker: normalizedTicker, userId } });
  }
  await tx.holding.delete({ where: { id: existing.id } });
};
```

This is strictly safer than today (it only ever deletes FEWER rows). Recommend
shipping this immediately; do Steps 1-4 for the complete fix (clean orphan handling +
proper per-portfolio deletes).

---

## Step 1 — Schema (`prisma/schema.prisma`)

Add a **plain nullable column** (NOT a Prisma `@relation`) to **each** of `Lot`,
`PortfolioTrade`, `DividendCredit`, `DividendReinvestment`:

```prisma
  portfolioId   String?

  @@index([portfolioId, ticker])
```

**Why a plain column, not `@relation` (review refinement):** the scoped-delete fix
only needs the id to filter on. Step 2 adds the column via raw `ALTER TABLE ADD
COLUMN`, which in SQLite creates a column with **no enforced foreign key** (SQLite
cannot add an enforced FK to an existing table without a full table rebuild).
Declaring a `@relation` would make `prisma db push` try to reconcile a FK the raw
ALTER never created — risking a table rebuild and drift from the manual-ALTER
convention. Keep it a plain `String?` field now; add a real FK later (a separate,
table-rebuild migration) only if you want DB-enforced referential integrity. No
back-relations on `model Portfolio` are needed for a plain field.

**Portfolio deletion (review refinement):** with no DB FK, deleting a `Portfolio`
will NOT auto-null these rows. Today Nala deletes *holdings*, not portfolios (confirm
before relying on this); if a portfolio-delete path exists, add explicit null-out or
cleanup there. Not required for the M-17 fix.

## Step 2 — Add the columns (matches the existing db-push + startup-ALTER convention)

This repo has **no `prisma/migrations/` folder** — schema reaches prod via
`prisma db push` plus idempotent `$executeRawUnsafe` ALTERs in `src/index.ts`
startup. Follow that pattern (or run `prisma db push` against the volume). SQL:

```sql
ALTER TABLE "Lot" ADD COLUMN "portfolioId" TEXT;
ALTER TABLE "PortfolioTrade" ADD COLUMN "portfolioId" TEXT;
ALTER TABLE "DividendCredit" ADD COLUMN "portfolioId" TEXT;
ALTER TABLE "DividendReinvestment" ADD COLUMN "portfolioId" TEXT;

CREATE INDEX IF NOT EXISTS "Lot_portfolioId_ticker_idx"                 ON "Lot"("portfolioId","ticker");
CREATE INDEX IF NOT EXISTS "PortfolioTrade_portfolioId_ticker_idx"      ON "PortfolioTrade"("portfolioId","ticker");
CREATE INDEX IF NOT EXISTS "DividendCredit_portfolioId_ticker_idx"      ON "DividendCredit"("portfolioId","ticker");
CREATE INDEX IF NOT EXISTS "DividendReinvestment_portfolioId_ticker_idx" ON "DividendReinvestment"("portfolioId","ticker");
```

Each `ALTER` wrapped in `try/catch` (column-exists) exactly like the existing
`20260319_add_social_platform` fix block in `index.ts`.

## Step 3 — Backfill existing rows (idempotent)

Assign `portfolioId` only when `(userId, ticker)` resolves to exactly ONE holding.
Repeat the two statements below for each of the four tables (shown for `Lot`):

```sql
UPDATE "Lot"
SET "portfolioId" = (
  SELECT h."portfolioId" FROM "Holding" h
  WHERE h."userId" = "Lot"."userId" AND h."ticker" = "Lot"."ticker"
)
WHERE "portfolioId" IS NULL
  AND (
    SELECT COUNT(*) FROM "Holding" h2
    WHERE h2."userId" = "Lot"."userId" AND h2."ticker" = "Lot"."ticker"
  ) = 1;
```

Ambiguity / orphan report (rows the backfill intentionally left `NULL` — review
before Step 5's stricter mode):

```sql
SELECT 'Lot' AS tbl, "userId", "ticker", COUNT(*) AS rows
FROM "Lot" WHERE "portfolioId" IS NULL GROUP BY "userId","ticker"
UNION ALL SELECT 'PortfolioTrade', "userId","ticker",COUNT(*) FROM "PortfolioTrade" WHERE "portfolioId" IS NULL GROUP BY "userId","ticker"
UNION ALL SELECT 'DividendCredit', "userId","ticker",COUNT(*) FROM "DividendCredit" WHERE "portfolioId" IS NULL GROUP BY "userId","ticker"
UNION ALL SELECT 'DividendReinvestment', "userId","ticker",COUNT(*) FROM "DividendReinvestment" WHERE "portfolioId" IS NULL GROUP BY "userId","ticker";
```

**Null `userId` rows (review refinement):** `Lot`, `DividendCredit`, and
`DividendReinvestment` allow a null `userId`. The backfill intentionally leaves those
`NULL` — the `h."userId" = <table>."userId"` join matches nothing under SQL NULL
semantics and the `COUNT(*) = 1` guard fails — which is the safe outcome (they're
orphaned/system rows with no owning portfolio to attribute).

**Take a backup before running the backfill** (see the DB rebuild runbook). The
UPDATEs are idempotent (only touch `portfolioId IS NULL`) and non-destructive.

## Step 4 — Set `portfolioId` on new writes (code)

| Table | Write site | Change |
|---|---|---|
| `DividendReinvestment` | `drip.service.ts:160` | add `portfolioId: current.portfolioId ?? null` (the tx-read holding `current`) |
| `Lot` | `drip.service.ts:189` | add `portfolioId: current.portfolioId ?? null` |
| `DividendCredit` | `dividend-post.service.ts:53` | add `portfolioId: holding.portfolioId ?? null` (loop var `holding`) |
| `PortfolioTrade` | `portfolio.controller.ts:2032, 2129, 2137, 2237` | add `portfolioId: <import target portfolioId>` to each `tradeRecords` element — confirm the resolved import portfolio variable (`importPortfolioId` is used at ~2225 for the compensating cash-flow) |

All four already run inside the relevant holding/import scope, so the portfolio id
is in hand — no extra queries.

## Step 5 — Scope `deleteHolding` (`portfolio.service.ts:150-157`)

Once new rows carry `portfolioId` and the backfill has run:

```ts
const cascade = async (tx: Prisma.TransactionClient) => {
  const holdingCount = await tx.holding.count({
    where: { userId, ticker: normalizedTicker },
  });

  if (holdingCount <= 1) {
    // Ticker lives only in this portfolio → all its history rows (incl. legacy
    // NULL-portfolioId ones) belong here; safe to delete by (ticker,userId).
    await tx.lot.deleteMany({ where: { ticker: normalizedTicker, userId } });
    await tx.portfolioTrade.deleteMany({ where: { ticker: normalizedTicker, userId } });
    await tx.dividendCredit.deleteMany({ where: { ticker: normalizedTicker, userId } });
    await tx.dividendReinvestment.deleteMany({ where: { ticker: normalizedTicker, userId } });
  } else {
    // Ticker in multiple portfolios → delete ONLY this portfolio's rows. Legacy
    // NULL-portfolioId rows (unresolved by backfill) are intentionally left intact
    // to avoid cross-portfolio loss; resolve them via the Step 3 report.
    const scope = { ticker: normalizedTicker, userId, portfolioId: existing.portfolioId };
    await tx.lot.deleteMany({ where: scope });
    await tx.portfolioTrade.deleteMany({ where: scope });
    await tx.dividendCredit.deleteMany({ where: scope });
    await tx.dividendReinvestment.deleteMany({ where: scope });
  }

  await tx.holding.delete({ where: { id: existing.id } });
};
```

`existing.portfolioId` is the holding being removed (deleteHolding already resolves
`existing` by `(ticker, portfolioId)`).

## Rollout order (each step reversible)

1. **Step 0 interim mitigation** — ship now; stops the loss immediately.
2. **Step 1 + 2** — add nullable columns (additive; safe).
3. **Step 4** — deploy write-site changes (new rows get `portfolioId`).
4. **Step 3** — backup, then run backfill; review the ambiguity report.
5. **Step 5** — deploy the scoped `deleteHolding` (supersedes Step 0).
6. *(Later, optional)* once the ambiguity report is empty/resolved, consider making
   `portfolioId` `NOT NULL` with a real FK — a second migration, not required for
   the fix.

## Risks & notes

- **Ambiguous multi-portfolio same-ticker rows** can't be attributed from history
  alone — they stay `NULL` and are only ever deleted in the single-portfolio path.
  This is the safe default (never deletes another portfolio's data); the report lets
  an operator resolve them by hand if desired.
- **`Lot` is currently only written by DRIP** (`drip.service.ts:189`) — no CSV/manual
  lot-entry path was found — so lot backfill volume is small. `PortfolioTrade`
  (import) and `DividendCredit` (dividend posting) are the higher-volume tables.
- **SQLite `ALTER TABLE ADD COLUMN`** is safe and fast (no table rewrite); the new
  index builds are the only cost.
- No production data was modified in producing this draft.

## Test plan (regression)

- Unit: `deleteHolding` with the same ticker in two portfolios deletes only the
  target portfolio's Lot/Trade/Credit/Reinvest rows and leaves the other's intact
  (mock `holding.count` → 2). Single-portfolio case still deletes all rows.
- Unit: Step 0 interim — `holdingCount > 1` skips all four cascades.
- Backfill: seed one single-portfolio ticker (gets portfolioId) and one
  multi-portfolio ticker (stays NULL); assert the UPDATE assigns/skips correctly.
