# Schema-history repair — deployment runbook

The repair runs **automatically at container startup**, before the application
opens its database pool. Merging this PR is what executes it. There is no manual
pre-merge production procedure.

---

## Why it moved into the start command

The first version of this runbook had an operator run
`prisma migrate resolve --applied` against the live container over `railway ssh`.
That is not possible, and the attempt is worth recording so nobody tries again:

- **Prisma's schema engine cannot get the locks it needs while the app runs.**
  Seven deterministic `database is locked` failures on production, including a
  retry loop and connection-timeout parameters — while ordinary writers were
  acquiring `BEGIN IMMEDIATE` in **1 ms** and `/health/deep` reported
  `writeOk: true`. The database was never the problem.
- **There is no process to quiesce.** `start.sh` ends in
  `exec node dist/index.js`, so Node is **PID 1**. Signalling the app means
  ending the container, which takes `/app` and the SSH session with it.
- **A volume-backed service cannot have two deployments mounted at once**, so a
  replacement container gets the volume only after the old one releases it.

That last point is what makes startup the right place: the new container holds
the volume alone, and `start.sh` runs before `node` connects. It is the only
quiet window this database has — and it is how all 51 existing migrations were
applied in the first place.

---

## What runs, in order

```
container starts, volume mounted
   ↓
scripts/db-repair-gate.cjs          decide: repair / skip / abort
   ↓ (repair only)
scripts/db-repair-preflight.cjs     semantic proof, fail-closed
   ↓
prisma migrate resolve --applied 20260826_reconcile_schema_history_baseline
   ↓
db-repair-gate.cjs again            confirm the ledger row landed
   ↓
… existing startup DDL / legacy resolves …
   ↓
prisma migrate deploy               applies 20260826_restore_missing_schema_objects
   ↓
scripts/db-repair-verify.cjs        7 objects + 2 ledger rows, fail-closed
   ↓
exec node dist/index.js
```

Any failure in the gate, preflight, resolve, or verification **exits non-zero and
the application never starts**. Booting against a half-repaired database is how
"recorded as applied, objects absent" was created; a warning would repeat it.

### Idempotent by construction

| Boot | Gate decision | Effect |
|---|---|---|
| First on production | repair | preflight → resolve → deploy applies category A |
| Every later boot | skip (baseline applied) | deploy reports nothing pending |
| Fresh database | skip (no/empty ledger) | deploy builds everything from history |
| Mid-history database | skip (late marker absent) | deploy applies the baseline normally — correct there |

The fresh-database case is the one that matters: a fresh database legitimately
lacks the category-B columns, and resolving the baseline there would record a
migration whose SQL never ran — recreating this exact defect. The gate keys on
the migration **ledger**, never on "does a table exist", because tables in this
deployment are also created by the startup DDL block.

---

## Deployment sequence

1. Review the PR at its exact head.
2. Confirm the verified backup is still available:
   `railway ssh "cat /data/backups/.last-backup.json"`
3. Merge with `--match-head-commit`.
4. Railway builds, stops the old deployment, mounts the volume to the new one.
   **A volume-backed service has an unavoidable downtime window here.**
5. Startup repair runs, then the app starts and `/health` returns 200.

The new image contains the migration files and both scripts natively — no
base64 staging, and no dependence on anything an operator typed into a shell.

---

## Post-deploy verification

Boot log should contain, in order:

```
=== 20260826 schema-history repair gate ===
[RepairGate] existing history (53 ledger rows), baseline absent — repair required.
[RepairGate] ... (preflight lines, all ok)
[Repair] preflight passed — recording the baseline as applied
[RepairGate] 20260826_reconcile_schema_history_baseline already applied — nothing to do.
=== Prisma migrate deploy ===
=== 20260826 schema-repair verification ===
[RepairVerify] ok   ... (9 lines)
[RepairVerify] schema repair verified.
=== Starting server ===
```

Then confirm:

```bash
curl -sS https://www.nalaai.com/health
railway ssh "cd /app && npx prisma migrate status"
railway ssh "cd /app && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script"
```

`migrate status` up to date; the residual diff must be **exactly** the registered
category-C exceptions (`HealthProbe`, the `ProfileStatsCache` index form, the
three `updatedAt` defaults) and nothing else.

**A second boot must show the skip path** — that is the proof it is idempotent
rather than a one-shot that breaks the next restart.

---

## If the repair fails

The container will not start, and the `ON_FAILURE` restart policy will retry the
same deterministic failure. The log block from `db-repair-verify.cjs` names the
remedy; the short version:

```bash
railway ssh "cd /app && npx prisma migrate status"
```

**Repair partially applied or not applied** — Prisma records the failed migration
and refuses the next deploy until it is resolved. Idempotent SQL is not the same
as an idempotent migration engine:

```bash
railway ssh "cd /app && npx prisma migrate resolve --rolled-back 20260826_restore_missing_schema_objects"
railway ssh "cd /app && npx prisma migrate deploy"
```

Safe on retry because every statement is `IF NOT EXISTS`.

**All seven objects exist, only the ledger entry is wrong:**

```bash
railway ssh "cd /app && npx prisma migrate resolve --applied 20260826_restore_missing_schema_objects"
```

Note that these commands face the same lock problem if the app is running — but
in this failure mode the app is *not* running, which is what makes them possible.

Never hand-edit `_prisma_migrations`. That is what created this drift.

---

## Rollback

The verified backup from `/data/backups` is the rollback point. The repair's
intended mutation is one ledger row, one empty table, and six indexes — no
application data is touched, which is why a same-day verified backup was judged
sufficient rather than pushing a 4.4 GB volume with 2.0 GB free toward its known
disk guard by taking another 1.23 GB copy.
