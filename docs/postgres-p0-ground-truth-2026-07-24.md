# Postgres migration — P0 ground-truth audit RESULT

**Date:** 2026-07-24 · **Source:** prod `file:/data/nala.db` via `railway ssh`, read-only
(SELECT + PRAGMA only) · **Gate:** `docs/postgres-migration-plan.md:63-92`

Method: every table introspected via `sqlite_master` + `PRAGMA table_info`, then
`SELECT typeof(col), COUNT(*), MIN, MAX ... GROUP BY typeof(col)` per DateTime
column. **86 tables, ~150 DateTime columns, 161 anomalies.** The plan named four
columns to spot-check; introspecting all of them is what surfaced the findings
below, none of which were in the four.

---

## Gate deliverable 1 — storage type per DateTime column

### The hot path is uniform (good news)

| Column | Rows | Storage | Shape |
|---|---|---|---|
| `PortfolioSnapshot.timestamp` | 366,573 | `text` × 366,573 | 100% `ISO+00:00` |
| `HoldingSnapshot.timestamp` | 3,385,768 | `text` × 3,385,768 | 100% `ISO+00:00` |
| `BillionaireSnapshot.timestamp` | 135,375 | `text` | 100% `ISO+00:00` |
| `BackgroundJobRun.startedAt/completedAt` | 101,674 | `text` | 100% `ISO+00:00` |
| `AnalyticsEvent.createdAt` | 389 | `text` | 100% `ISO+00:00` |

**Verdict:** the timestamp fix shipped today (master `4cc73d5`) is correct for
100% of prod rows, and `snapshot-retention.service.ts`'s string-comparison
approach was right all along. No mixed-type risk on the two tables that carry
3.75M of the 4.1M total rows.

### ~40 columns store BOTH text and integer in the same column

The plan predicted "a third, space-separated shape may exist." Reality is worse:
the same column holds TEXT ISO-8601 *and* INTEGER epoch-ms *and* (twice) a
space-separated shape. Under SQLite affinity this never errors — it silently
misbehaves.

Business-relevant instances:

| Column | Split | Consequence |
|---|---|---|
| `Transaction.date` | text 83 / **int 16** | text cutoff matches **0 of 16** — see finding A |
| `Transaction.createdAt` | text 83 / int 16 | same |
| `DividendEvent.exDate` | text 2,558 / **int 2,407** | ~49% integer — near even split |
| `DividendEvent.payDate` | text 2,558 / int 2,407 | same |
| `Holding.createdAt` | **int 130** / text 19 | majority integer |
| `Holding.updatedAt` | **int 120** / text 29 | majority integer |
| `User.createdAt` | **int 17** / text 12 | majority integer |
| `User.trackingStartAt` | **int 15** / text 12 | feeds Since-Tracking-Start math |
| `User.leaderboardEligibleAt` | int 10 (all) | 100% integer |
| `ConsentRecord.consentedAt` | text 12 / int 3 | **GDPR record** |
| `ConsentRecord.createdAt` | text 12 / int 3 | **GDPR record** |
| `PortfolioCompositionChange.timestamp` | text 94 / int 5 | composition-change filter |
| `ActivityEvent.createdAt` | **int 297** / text 84 | majority integer |
| `Follow.createdAt` | **int 147** / text 7 | majority integer |
| `DividendCredit.creditedAt` | text 323 / int 69 | |
| `MilestoneEvent.createdAt` | text 1,300 / int 195 | |
| `WatchlistHolding.createdAt/updatedAt` | int 13 (all) | 100% integer |
| `EconomicIndicatorCache.createdAt` | int 14 (all) | 100% integer |

### Two columns carry a space-separated shape

| Column | Shapes |
|---|---|
| `Portfolio.updatedAt` | `SPACE-SEP` + `ISO+00:00` (e.g. `2026-03-05 18:31:24`) |
| `EmailOtpCode.usedAt` | `ISO+00:00` + `SPACE-SEP` + `INTEGER` — three shapes in one column |

`'T'` (0x54) > `' '` (0x20), so space-separated rows sort below every ISO row.
This is the same edge `snapshot-retention.service.ts:20-23` documents avoiding.

---

## Gate deliverable 2 — daily-values query verdict

**Broken, confirmed, fixed, shipped.** Both raw queries in `snapshot.service.ts`
treated the TEXT column as INTEGER epoch-ms. Measured on prod data: the old
`GROUP BY date(ps.timestamp / 1000, 'unixepoch')` bucketed **91 real calendar
days into a single `1970-01-01` row**, and the numeric cutoff was a no-op.
Fixed in `3029741`, merged `4cc73d5`, deployed and verified Online.

---

## Finding A (new) — `Transaction.date` silently drops 16 of 99 rows

Measured directly on prod with the production predicate (a bound TEXT ISO cutoff,
which is what Prisma emits):

```
total=99   matched by TEXT cutoff=83
integer-stored=16   of those matched=0   -> DROPPED=16
```

Every integer-stored row is invisible to any text-cutoff range query. Of the 16:
**12 deposits and 4 withdrawals.**

```
e9dfca4a  2026-02-10  withdrawal   4,000.00
e26f625f  2026-02-10  withdrawal  13,000.00
e26f625f  2026-02-10  withdrawal  18,000.00
3d003e8f  2026-02-27  deposit     30,000.00
f9bfda78  2026-03-14  deposit     80,443.00
f9bfda78  2026-03-14  deposit      1,963.92
f9bfda78  2026-03-14  deposit      5,536.86
(+ 9 more with NULL userId, all 2026-02-10)
```

`getDailyRiskSeries` (`insights.service.ts:74-79`) reads exactly this table to
neutralise deposits/withdrawals from TWR returns. Missing flows fabricate
apparent gains/losses — the precise artifact class that series exists to remove.

**Currently latent, not active.** All 16 rows date 2026-02-10 → 2026-03-14, and
prod's retained snapshot history now begins **2026-04-16**. `flowByDay` is only
consulted for days that have a snapshot, so these are never looked up today. It
becomes live the moment any new integer-dated transaction is written, or if the
snapshot window ever extends back past mid-March.

Also worth noting: **9 of the 16 rows have a NULL `userId`.** Separate integrity
question, not investigated here.

---

## Finding B — task #3's symptom has aged off prod

The false 112% volatility / 69% drawdown for `0143cfb4` came from a −66.5%
single day on **2026-04-06**. Prod's earliest retained snapshot for that user is
now **2026-04-16** (99 days, already at ~$71k — post-drop). The user has **zero**
`Transaction` rows of any storage type.

So the user-facing wrongness is not currently occurring in production. The
underlying gap — portfolio edits are not modelled as cash flows — is unchanged
and will reproduce on the next such event. Tracked as task #3.

---

## Baseline metrics (for ETL parity checks)

Row counts, largest first: `HoldingSnapshot` 3,385,917 · `PortfolioSnapshot`
366,589 · `BillionaireSnapshot` 135,375 · `BackgroundJobRun` 101,689 ·
`DeadLetterEntry` 12,976 · `SocialNotification` 12,405 · `AnomalyEvent` 9,343 ·
`DividendEvent` 4,965 · `ApiUsageLog` 4,956 · `CongressTrade` 1,620 ·
`MilestoneEvent` 1,495 · `JobIdempotencyKey` 1,018 · `ScreenerCache` 1,007 ·
`ScreenerUniverse` 945 · `Politician` 537 · `DividendCredit` 392 ·
`AnalyticsEvent` 389 · `ActivityEvent` 381 · `FundamentalsCache` 335 ·
`Holding` 149 · `Follow` 154 · `Transaction` 99 ·
`PortfolioCompositionChange` 99 · `User` 29 · `Portfolio` 28 · `UserSettings` 28.

Top 5 users by snapshot volume (all 99 days, 2026-04-16 → 2026-07-24):

| user | snaps | holdings | latest EOD totalValue |
|---|---|---|---|
| `300939e0` | 23,532 | 10 | 75,883.38 |
| `0143cfb4` | 23,457 | 11 | 69,715.04 |
| `0ea0d955` | 23,425 | 8 | 59,992.45 |
| `8cef8379` | 23,382 | 5 | 77,526.37 |
| `e5cdce2f` | 23,252 | 13 | 101,247.61 |

`netEquity == totalValue` for all five (no margin debt).

---

## What this changes for the migration

1. **The ETL cannot assume one storage type per column.** The plan's line-201
   risk ("DateTime double-assumption hides a live data-shape surprise") is
   confirmed and larger than scoped. Conversion must be per-row, not per-column:
   `typeof(col)` → integer means epoch-ms, text means ISO (and may be
   space-separated). A per-column cast will corrupt whichever minority it misses.
2. **A pre-ETL normalisation pass is now warranted** — rewrite every DateTime
   column to a single canonical shape on v1 *before* the migration, so the ETL
   maps one known type. This is new scope not in the current plan.
3. **Workstream 6 line reference is stale**: `snapshot.service.ts:446-488` is now
   `:459-501` after today's fix.
4. **The bare-column MAX rewrite is still required** — `SELECT ps.totalValue ...
   GROUP BY date(ps.timestamp)` is a hard error in Postgres, and `date(expr)` on
   `timestamptz` converts using the session TimeZone rather than UTC.

## Gate status

**P0 PASSED.** Both deliverables produced. Finding A and the normalisation pass
should be folded into P1/P2 scope before the schema port begins.
