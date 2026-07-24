# Postgres Migration Plan — v1 App Database (SQLite → PostgreSQL)

Status: PLAN (phase 0 not started) · Author: incident follow-up 2026-07-15 · Owner: Jon + Claude

## Why now

Four database incidents in seven days, all rooted in SQLite-on-one-volume with a
single serialized write connection on a chronically saturated shared host
(PSI CPU `some` ≈ 99.7%):

1. 2026-07-11/12 — `BackgroundJobRun` b-tree corruption → rebuild-and-swap.
2. 2026-07-14 — boot-anchored maintenance stampede + `copyFileSync` event-loop
   freeze → 4h45m write-timeout storm.
3. 2026-07-15 — retention job's correlated-subquery chunks held the write lock
   for ~8h overnight (P1008 brownout waves; fixed in `2ff37e2`).
4. 2026-07-15 — delisted-symbol quote cascade (not SQLite-caused, but every
   mitigation was constrained by the single-writer model).

Every fix so far manages symptoms of the same ceiling. Postgres removes the
ceiling: real concurrent writers, real isolation levels, MVCC instead of one
write lock, `pg_dump`/PITR instead of file copies, no WAL-checkpoint
starvation, no VACUUM-needs-1×-disk games.

## Current state (verified 2026-07-15)

- **v1 (this migration):** Prisma + `@prisma/adapter-libsql`, `DATABASE_URL=file:/data/nala.db`
  (~1.16 GB, 86 models, 29 users). All DateTimes stored by libsql; JSON stored
  as TEXT strings; every PK is a String (mostly `@default(uuid())`, four
  natural keys: `Settings.id`, `ScreenerUniverse.ticker`,
  `ValueRadarTierSnapshot.ticker`, `Politician.bioguideId`); no autoincrement/
  Decimal/Bytes/Json Prisma types anywhere (clean type surface for a port).
- **v2 ledger (already Postgres, already live):** `prisma-v2/` +
  `src/v2/` — `PrismaPg` client, `V2_DATABASE_URL` →
  `postgres-xf5d.railway.internal`, **shadow-writes enabled in prod**
  (`V2_SHADOW_WRITE_ENABLED=true`), daily v1↔v2 reconciliation, partial unique
  indexes + plpgsql triggers in raw migration SQL, offsite job already ships a
  nightly `pg_dump`. This is the in-repo template for everything below.
- **Railway services:** `stock-portfolio-api` (app + volume), `Postgres`
  (postgres-ssl:18, ~empty — **proposed v1 target**), `Postgres-XF5D`
  (postgres-ssl:18 — v2 ledger; leave dedicated).
  - Note: a v2 doc mentions Aurora Postgres 16 for prod — reality on Railway is
    postgres-ssl:18 templates. Verify which doc is stale during P0.
- **Monitoring:** BetterStack + hourly cloud watchdog on `/health/deep`
  (write-probe + brownout + backup freshness) — keeps working through the
  migration; the WAL fields become pg-stats fields in P2.

## Target architecture

- v1 app database moves to the **`Postgres`** service (dedicated database,
  isolated from the ledger). `DATABASE_URL` becomes the pg connection string;
  `src/utils/prisma.ts` swaps `PrismaLibSql` → `PrismaPg` (pattern:
  `src/v2/ledger/prisma.ts`).
- The SQLite file stays frozen on the volume post-cutover as the rollback
  target until decommission (P6).

## Phases and gates

Rule: each phase has a **gate**; do not start the next phase until the gate
passes. One variable at a time — P0 does not start until the retention-fix
watch (first clean 06:40 UTC run, probe `trig_011Gv91yDw9Nn2tEida82i2W`) is
green.

### P0 — Ground-truth audit (½ day) — BLOCKS EVERYTHING

The inventory found **two contradictory assumptions about the same column**:

- `snapshot-retention.service.ts` treats `PortfolioSnapshot.timestamp` as
  TEXT ISO-8601 (`'2026-07-11T23:13:38.075+00:00'`, ground-truthed on prod
  2026-07-11) and compares strings.
- `snapshot.service.ts:446-453, 479-488` treats the same column as INTEGER
  epoch-milliseconds (`ps.timestamp / 1000, 'unixepoch'`, numeric cutoffs).
  *(Resolved 2026-07-24 — the retention service was right, these two queries
  were wrong. Now `:459-501` after the fix.)*

Both cannot be right. Under SQLite affinity rules the wrong one **silently
misbehaves** instead of erroring. Since these queries feed the daily-values /
chart / streak engines, this may be a live v1 bug today, independent of the
migration.

Actions:
1. On prod (`railway ssh` + libsql, gotcha: `railway ssh -- sh -c "true; <cmd>"`):
   `SELECT typeof(timestamp), timestamp FROM PortfolioSnapshot LIMIT 5` and the
   same for `HoldingSnapshot`, `User.createdAt`, `AnalyticsEvent.createdAt`,
   plus `SELECT COUNT(*), typeof(timestamp) FROM PortfolioSnapshot GROUP BY 1,2`
   (detect mixed-type columns from the old boot-DDL `DATETIME DEFAULT
   CURRENT_TIMESTAMP` era — a third, space-separated shape may exist).
2. Run the two `snapshot.service.ts` raw queries manually against prod values;
   record whether their grouping is actually correct today. If broken → file as
   a separate v1 bug (fix lands with the P2 rewrite either way).
3. Baseline metrics snapshot for later parity checks: per-table row counts,
   min/max timestamps, per-user holding counts, latest EOD values for 5 users.

**Gate P0:** a written matrix of actual storage type per DateTime column, and
the daily-values query verdict.

> **✅ P0 PASSED — 2026-07-24. Full result:
> [`postgres-p0-ground-truth-2026-07-24.md`](./postgres-p0-ground-truth-2026-07-24.md)**
>
> - **Daily-values verdict: was genuinely broken.** The old query bucketed 91
>   real calendar days into one `1970-01-01` row. Fixed and deployed (`4cc73d5`).
> - **Hot path is clean.** `PortfolioSnapshot.timestamp` (366,573) and
>   `HoldingSnapshot.timestamp` (3,385,768) are 100% uniform TEXT `ISO+00:00`.
> - **But the assumption problem is far wider than these two files.** All 86
>   tables were introspected rather than the four spot-checks listed above:
>   **161 anomalies**, ~40 columns storing BOTH `text` and `integer` in the same
>   column (incl. `Transaction.date`, `Holding.createdAt`, `User.createdAt`,
>   `ConsentRecord.consentedAt`, `DividendEvent.exDate` at a near 50/50 split),
>   plus two columns carrying a space-separated shape (`Portfolio.updatedAt`,
>   `EmailOtpCode.usedAt` — which holds all three shapes at once).
> - **New live finding (A):** a TEXT cutoff on `Transaction.date` matches **0 of
>   16** integer-stored rows — 12 deposits + 4 withdrawals invisible to TWR flow
>   adjustment. Latent today only because all 16 predate the retained snapshot
>   window (prod snapshots now start 2026-04-16).
>
> **Impact on later phases:** the ETL must convert **per row, not per column**
> (`typeof(col)` → integer = epoch-ms, text = ISO, possibly space-separated). A
> pre-ETL normalisation pass on v1 is now recommended new scope, so P1/P2 map a
> single known type.

### P1 — Schema port (1 day)

1. New branch `feat/postgres-v1`. Flip `prisma/schema.prisma` datasource to
   `postgresql`; flip `prisma/migrations/migration_lock.toml`.
2. Discard the ~50 SQLite migrations for pg purposes: generate ONE fresh
   baseline migration against an empty pg (keep the SQLite history in git; the
   file DB never runs `migrate deploy` again).
3. Recreate the Prisma-inexpressible constraints from raw SQL (pattern:
   `prisma-v2/migrations/*`). Audit finding: the only one in v1 is the
   `creator_payout_pending_unique` PARTIAL unique index (payout race
   protection — on SQLite this index is the ONLY guarantee; see
   `creator-billing.service.ts:1559-1587`). The wallet-ledger idempotency
   index is a plain `@@unique` already in the schema (Prisma emits it), and
   v1 needs no `pgcrypto` (IDs are generated application-side).
4. Fold the boot-time migration-repair DDL (`src/index.ts:457-548` — the
   `HealthProbe` bootstrap table at 457 plus the SQLite-dialect blocks:
   `RAISE(ABORT)` triggers, `randomblob`, `DATETIME` defaults, the
   social-platform `kycVerified`/`kycVerifiedAt` `ALTER TABLE` patches) into
   the baseline, then delete those boot blocks. Same for `scripts/start.sh`'s
   libsql `PRAGMA table_info` gating.
5. **Deliberately deferred (do NOT bundle):** Float→numeric for money columns,
   TEXT-JSON→jsonb, citext for usernames. Like-for-like first; type upgrades
   are separate post-migration changes with their own tests.

**Gate P1:** `prisma migrate deploy` onto a scratch pg database succeeds;
`npx tsc --noEmit` clean with the generated pg client.

### P2 — Code port (2-3 days, the real work)

Workstreams, from the dependency inventory (file:line refs are audit-branch;
re-locate on master where this week's fixes moved things):

| # | Workstream | What changes |
|---|---|---|
| 1 | Client + pragmas | `src/utils/prisma.ts`: `PrismaPg`, pool sizing; delete `initSqlitePragmas` (WAL/busy_timeout/auto_vacuum). |
| 2 | Retention job | `snapshot-retention.service.ts` (master = keeper-table version from `2ff37e2`): becomes SIMPLER — keeper set as a CTE/temp table, `DELETE ... USING`, `ctid` batches or plain indexed deletes (MVCC: no write-lock storms), `now() - interval '30 days'` instead of frozen ISO strings, drop wal_checkpoint/incremental_vacuum. Keep the yield/cap structure. |
| 3 | Cleanup + disk-guard | `cleanup.service.ts` rowid/datetime chunks → portable deletes. `disk-guard.service.ts`: **retire** (its reason to exist is the SQLite file); replace with a pg bloat/size monitor in `/health/deep`. |
| 4 | Backup/offsite | `backup.service.ts` (current machinery: WAL checkpoint + `VACUUM INTO` on a dedicated libsql connection + quick_check — the old copyFileSync is already gone) → `pg_dump` (the offsite job's v2 half already does exactly this — extend to the v1 database). `/health/deep.lastBackup` keeps its contract. Railway pg volume snapshots as second layer. |
| 5 | Health + brownout | `/health/deep` (master): WAL fields → pg equivalents (`pg_stat_activity` waits, connection saturation); write-probe unchanged (its `HealthProbe` table + upsert are pg-portable). **Retire `db-watchdog.service.ts` entirely** — it stats the `-wal` file and runs `PRAGMA wal_checkpoint(PASSIVE)`; post-cutover it would report misleading zeros. Brownout breaker: keep, add pg transient codes (40001, 40P01, 57014, P2024) alongside P1008. Sentry corruption matcher: SQLITE_CORRUPT → pg fatal classes. |
| 6 | Bare-MAX chart queries | `snapshot.service.ts:459-501` (was `:446-488`) → `DISTINCT ON (user, day) ... ORDER BY day, timestamp DESC` (or window functions). **Parity harness required** (below) — these feed EOD/TWR. |
| 7 | Raw-SQL sweep | **Placeholder syntax first:** every `$queryRawUnsafe`/`$executeRawUnsafe` using SQLite `?` positional params (5 sites in `analytics.service.ts` alone) must become `$1/$2` — on pg these THROW at runtime, they don't degrade. Then the semantic swaps: `analytics.service.ts` DATE() groupings → `date_trunc`; `post.service.ts` `deleted = 0` → boolean; `app.ts` `COLLATE NOCASE` → `LOWER()`/citext-later; `activity.service.ts` `JSON_EXTRACT` → `payload::jsonb->>`; `users/auth` LOWER() lookups fine; admin routes' PRAGMA panels → pg stats or delete. |
| 8 | Transactions | Import flow (`portfolio.controller.ts` ~2031-2290): shorten the interactive tx (precompute outside, write inside), set explicit isolation, add 40001/40P01 retry wrapper (small util). Review the other `$transaction` sites — **~42 occurrences across 20 v1 files** (audited count); payout path can now genuinely use Serializable (keep the partial index too). |
| 9 | Scheduled jobs wiring | `scheduleDailyAtUTC` stays; backup/retention/cleanup keep their 06:40/07:10/08:10 slots; disk-guard schedule removed with the service. |

**Gate P2:** full vitest suite green against a pg test database (integration
tests that currently use `:memory:` libsql get a pg-backed twin or testcontainer
equivalent — Docker is currently NOT installed on the dev machine; use the
Railway `Postgres` service's scratch database for CI-style runs until Docker
is restored); `npm run build` clean.

### P3 — ETL + rehearsal #1 (1 day)

1. `scripts/migrate-to-postgres/`: table-manifest-driven copier —
   libsql SELECT batches → pg `COPY`/multi-row INSERT, explicit type mapping
   (TEXT-ISO → timestamptz, 0/1 → boolean, TEXT JSON passthrough), FK-safe
   table order (or `session_replication_role=replica` during load), per-table
   verification (row count + numeric column sums + min/max timestamps),
   resumable, `--dry-run`.
2. Rehearse from the local backup (`C:/dev/nala/backups/rehearsal-rebuilt.db`,
   980 MB, quick_check ok) into a scratch database on the `Postgres` service.
   Wipe and re-run until clean.
3. **Parity harness:** with the app branch pointed at the rehearsal pg, replay
   the P0 baseline queries + golden financial checks (per-user latest EOD
   value, 30d TWR, holdings breakdowns for the 5 baseline users) and diff
   against v1 answers to the cent. Reuse the financial-audit test fixtures.

**Gate P3:** two consecutive clean rehearsals; parity harness zero-diff.

### P4 — Staging soak (1-2 days, calendar)

Deploy the branch as a separate Railway service (or PR environment) pointed at
the rehearsal database. Let the full job fleet run ≥24h (quote refresh,
snapshots, retention at 06:40, backup at 07:10, billionaire, milestone).
Watch `/health/deep`, Sentry, and job dead-letters.

**Gate P4:** 24h with zero DB-layer errors and correct job outputs.

### P5 — Cutover (30-min window, off-hours, Jon present)

Runbook (also the rollback story):

1. T-24h: announce window; confirm P4 gate; fresh SQLite backup + R2 copy.
2. T-0: enable maintenance flag (reads stay up; writes 503 with friendly
   message — small middleware, ships in P2).
3. Final ETL run (full re-copy: ~1 GB is minutes co-located; no dual-write
   complexity needed at this size).
4. Parity harness against the freshly loaded pg — **hard gate; abort on any
   diff** (abort = drop maintenance flag, nothing changed).
5. Flip `DATABASE_URL` on the app service → auto-redeploy → smoke
   (`npm run smoke:test:prod` + `/health/deep` + 3 golden users).
6. Unfreeze. Watch 2h. Watchdog + BetterStack + retention probe stay armed.
7. **Rollback at any point:** flip `DATABASE_URL` back to `file:/data/nala.db`
   and redeploy — the file was frozen during the window, zero loss. Rollback
   stays valid until first post-cutover writes matter (call it 24h); after
   that, roll forward only.

### P6 — Decommission (later, no urgency)

Retire backup/disk-guard/pre-cutover scripts, ship v1 `pg_dump` to R2 nightly
(extend the v2 job), keep the final SQLite file + one R2 copy as archaeology,
shrink/repurpose the volume (Jon's 5→10 GB grow becomes unnecessary — do NOT
buy it if cutover lands first), update runbooks + `docs/HANDOFF.md`.

## Risk register (top 5)

| Risk | Mitigation |
|---|---|
| DateTime double-assumption hides a live data-shape surprise | P0 ground-truth before any code; ETL maps from MEASURED types, not assumed |
| Bare-MAX rewrite silently changes EOD/TWR numbers | Golden-user parity harness to the cent; gate P3/P5 |
| Long import tx behaves differently under MVCC (locks/retries) | Explicit isolation + retry wrapper + soak test with a real CSV import in P4 |
| Railway pg service sizing (shared-CPU template) | Soak measures p95 under real fleet; upgrade plan knob before cutover if needed |
| Split-brain (writes landing in SQLite after cutover) | Maintenance-freeze middleware + boot-time assert: refuse to start with `file:` URL when `MIGRATED_TO_PG=true` |

## Decision points for Jon (blocking, in order)

1. **Target:** dedicated `Postgres` service for v1 (recommended) vs shared
   instance with the ledger.
2. **Go for P0-P4** (no user impact, no prod writes touched) — recommend
   starting after tomorrow's 06:40 UTC retention run verifies clean.
3. **Cutover window** (P5): a weekday evening after close, or weekend morning.
4. Post-migration type upgrades (numeric money, jsonb) — separate decision,
   separate PRs.

## Timeline estimate

P0 ½d → P1 1d → P2 2-3d → P3 1d → P4 1-2d (calendar) → P5 30min window.
Roughly one focused week end-to-end, cutover the following weekend.
