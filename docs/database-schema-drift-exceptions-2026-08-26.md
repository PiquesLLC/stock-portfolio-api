# Accepted production schema exceptions

After the reconciliation in `fix/db-migration-history-reconciliation`, the
invariant is:

> **Replayed migration history == `schema.prisma`, exactly.**
> **Production == that intended schema, except for the exceptions registered below.**

`prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma`
reports *No difference detected*, and a test asserts it stays that way.

Production carries three differences that are deliberate, not drift. Each is
listed with the exact observed difference, why it is accepted, and what would
make us revisit it. Anything appearing in a production diff that is **not** on
this list is real drift and must be investigated.

## Where these came from

`src/index.ts` runs a block of 21 idempotent `CREATE TABLE / INDEX IF NOT EXISTS`
statements at every boot. It predates the migration workflow and is now a no-op
against an existing database, but it is what originally created several objects
in production — which is why their shape follows the application code rather than
a migration.

That block is also implicated in the 2026-07-24 write-lock incident (~33
exclusive-lock DDL statements on every boot). Removing it is tracked separately;
it is out of scope here because deleting boot DDL is a behavioural change, not a
schema-history repair.

---

## 1. `HealthProbe` — table exists in production, absent from `schema.prisma`

**Observed:** production has `HealthProbe(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL)`.
A diff of production against the intended schema proposes `DROP TABLE "HealthProbe"`.

**Why accepted:** it is runtime-owned infrastructure, not application data. It is
created by `src/index.ts` and written by the write-liveness probe in
`src/controllers/health.controller.ts`, which issues raw SQL and never uses a
Prisma delegate. Modelling it in `schema.prisma` would put a health-check
implementation detail into the customer data model for no benefit, and the probe
must keep working even if Prisma's client is unhealthy — which is the entire
point of a write-liveness probe.

**Revisit if:** the probe starts holding data anything else reads, or the boot DDL
block is removed (then the table needs an owner).

**Never:** act on the proposed `DROP TABLE`. That would disable the write-lock
watchdog this repository added after a production write-lock incident.

---

## 2. `ProfileStatsCache.userId` — implicit vs named unique index

**Observed:** production enforces uniqueness through the implicit
`sqlite_autoindex_ProfileStatsCache_2`, created by an inline `UNIQUE` column
constraint in the boot DDL. `schema.prisma` expresses the same rule as a named
index, `ProfileStatsCache_userId_key`.

**Why accepted:** the constraint is identical — one unique value of `userId` per
row, enforced by SQLite either way. Only the index's name and form differ.
Prisma's suggested fix is:

```sql
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_ProfileStatsCache_2" ...
Pragma writable_schema=0;
```

`writable_schema` edits `sqlite_master` directly, bypassing SQLite's own
consistency checks. Running that against a 1.38 GB production database to rename
an object that already enforces the correct rule is a real corruption risk taken
for a cosmetic gain.

**Revisit if:** the uniqueness rule itself changes (e.g. becomes composite), at
which point the table gets a proper migration and the index is rebuilt honestly.

---

## 3. `Appeal`, `Post`, `ValueRadarCache` — `updatedAt DEFAULT CURRENT_TIMESTAMP`

**Observed:** production declares `"updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`.
The intended schema declares `"updatedAt" DATETIME NOT NULL`, because Prisma's
`@updatedAt` supplies the value from the client. Prisma proposes rebuilding all
three tables (create `new_X`, copy rows, drop, rename).

**Why accepted:** the columns are otherwise **identical** — verified against
production's `sqlite_master` DDL, column by column. The default is a strict
superset of the intended behaviour: it only matters for an INSERT that omits
`updatedAt`, and no such write exists.

Checked before accepting: there are **zero** raw `INSERT INTO` statements against
these three tables anywhere in `src/`. Every write goes through a Prisma delegate
(`prisma.appeal.*`, `prisma.post.*`, `prisma.valueRadarCache.*`), and `@updatedAt`
always supplies a value. Fresh environments and production therefore behave
identically on every write path that exists.

`Post`'s shape comes from the boot DDL block; `Appeal` and `ValueRadarCache` are
not in that block and their default has an older origin.

**Why not fixed:** the proposed remedy rebuilds three live tables — copy every
row, drop, rename — inside a 1.38 GB database, to delete a default that no code
path can reach. That is meaningful risk for zero behavioural change.

**Revisit if:** a raw `INSERT` into any of these tables is ever added, or one of
the tables needs a genuine migration anyway — then the default can be dropped as
part of that work, for free.

---

## What is NOT an accepted exception

These were considered and deliberately **repaired** instead, because production
was wrong rather than intentionally different:

- **`MonitoringReport`** — absent in production while `schema.prisma` declares it
  and `admin.routes.ts` / `creator-stripe-reconciliation.service.ts` write to it.
  A call against production fails with *no such table*; it is latent only because
  creator monetization is disabled. Restored by
  `20260826_restore_missing_schema_objects`.
- **Four declared indexes** — `ContentStrike_createdAt_idx`,
  `CreatorPayout_stripePayoutId_idx`, `CreatorPayout_stripeTransferId_idx`,
  `CreatorSubscription_stripeSubscriptionId_idx`. Restored by the same migration.
- **`portfolioId` columns and indexes** — production had them, history did not.
  Described by `20260826_reconcile_schema_history_baseline`, which production
  records as applied without executing.

## Follow-up required: the remaining unconditional startup resolves

`scripts/start.sh` still contains eleven unconditional commands of the form:

```bash
npx prisma migrate resolve --applied <migration> 2>&1 || true
```

Two of them — `20260324_add_monitoring_reports` and `20260324_add_stripe_indexes`
— were removed on 2026-08-26 because they are tied by direct evidence to the
drift this document records: both were marked applied on every boot regardless
of whether their SQL had ever run, and production ended up with both recorded
as applied while their objects did not exist.

The other nine were deliberately left in place. They are the same class of
defect and can manufacture the same "applied but absent" state, but nothing
currently ties them to a known missing object, and removing every legacy
workaround inside a repair PR would have put unrelated boot-behaviour changes
into it.

**They must be eliminated before the migration system is considered clean.**
The safe replacement is the pattern introduced by this repair: inspect the
ledger, prove the objects exist, then resolve — never resolve unconditionally,
and never with `|| true`. `src/__tests__/migration-history-integrity.test.ts`
will now catch the schema consequences, but it cannot see a ledger entry that
is a lie about production.

## Root cause, worth remembering

`20260324_add_monitoring_reports` and `20260324_add_stripe_indexes` are both
recorded as **applied** in production, yet their objects were absent. Both use
`IF NOT EXISTS`, so they cannot have run and silently failed. The marker was
written without the SQL having executed.

That is the same operation this repair uses for the baseline migration, which is
why the procedure requires **proving each object exists in production before
resolving it as applied**. Without that preflight, `resolve --applied` is a way to
manufacture exactly this class of drift.

The two rolled-back history rows (`20260319_add_post_attachments`,
`20260320_add_appeals`) are left untouched. They are historical evidence, and
`prisma migrate status` does not treat them as blocking.
