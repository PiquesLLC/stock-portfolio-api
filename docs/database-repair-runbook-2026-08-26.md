# Schema-history repair — production runbook

Executed **before merge**, so the Railway deployment that follows has nothing
left to apply.

Every command runs through `railway ssh`, because the database is a file on the
Railway volume (`/data/nala.db`) and is unreachable from a workstation.

---

## The thing that makes this runbook different from the first draft

`railway ssh` enters the **currently deployed container**, which is built from
the last merged commit. It does **not** contain this PR's migration directories —
verified: the container reports 51 migration directories and no `20260826_*`.

`prisma migrate resolve` needs the migration to exist in its migrations directory
and fails with **P3017** ("migration could not be found") otherwise. So the
reviewed files must be **staged into the running container** first. Step 2 does
that and proves byte-equality by SHA-256, which is what gives step 5's checksum
assertion a chain back to the reviewed artifact.

Staged files go in the container's **ephemeral application filesystem** (`/app`).
Nothing but the database and its backups may touch `/data`.

---

## Why the preflight is not a formality

`20260324_add_monitoring_reports` and `20260324_add_stripe_indexes` are recorded
as **applied** in production, yet their objects do not exist. Both use
`IF NOT EXISTS`, so they cannot have run and quietly failed — the marker was
written without the SQL executing.

That is the same operation step 6 performs. `resolve --applied` is a way to
manufacture exactly this drift if used without proof, and a name check is not
proof: a `portfolioId` of the wrong type, or an index over the wrong columns,
would be baselined into history as though it matched. Step 4 verifies the
**semantic result** of every statement being skipped.

---

## Step 1 — restorable copy

`resolve --applied` writes only to `_prisma_migrations`, but that ledger governs
every future deploy. Take the artifact anyway.

```bash
railway ssh "ls -la /data/backups | tail -5"
```

Confirm a recent verified backup, or take one, before continuing.

---

## Step 2 — stage the reviewed migrations into the container

From the **exact reviewed checkout**. Base64 avoids every quoting hazard and
makes the transfer verifiable.

```bash
BASE=20260826_reconcile_schema_history_baseline
REPAIR=20260826_restore_missing_schema_objects

for M in "$BASE" "$REPAIR"; do
  B64=$(base64 -w0 "prisma/migrations/$M/migration.sql")
  railway ssh "mkdir -p /app/prisma/migrations/$M && echo '$B64' | base64 -d > /app/prisma/migrations/$M/migration.sql"
done
```

## Step 3 — prove the staged files are the reviewed files

```bash
sha256sum prisma/migrations/20260826_*/migration.sql
railway ssh "sha256sum /app/prisma/migrations/20260826_*/migration.sql"
```

The two hashes must match pairwise. **If they do not, stop** — everything after
this point assumes the container holds exactly the reviewed SQL.

---

## Step 4 — preflight (the gate)

`scripts/db-repair-preflight.cjs` is read-only. It verifies category B by column
type, nullability, default and pk, and by index uniqueness and exact column
order — not by name — and verifies every category A object is genuinely absent.

It must run from `/app`, not `/tmp`: Node resolves `@libsql/client` relative to
the script, and `/tmp` is outside the container's `node_modules`.

```bash
B64=$(base64 -w0 scripts/db-repair-preflight.cjs)
railway ssh "echo '$B64' | base64 -d > /app/db-repair-preflight.cjs && node /app/db-repair-preflight.cjs; echo \"EXIT=\$?\"; rm -f /app/db-repair-preflight.cjs"
```

Expected: 8 category-B lines `ok`, 7 category-A lines `ok`,
`PREFLIGHT PASS`, `EXIT=0`.

**Any `FAIL` means the A/B classification is wrong. Stop.**

---

## Step 5 — baseline (the only ledger mutation)

```bash
railway ssh "cd /app && npx prisma migrate resolve --applied 20260826_reconcile_schema_history_baseline"
```

Records the migration **without executing its SQL** — correct, because step 4
proved production already satisfies it.

---

## Step 6 — verify the ledger row

```bash
railway ssh "node -e \"
const{createClient}=require('/app/node_modules/@libsql/client');
const db=createClient({url:process.env.DATABASE_URL});
(async()=>{const r=await db.execute({sql:'SELECT migration_name,checksum,finished_at,rolled_back_at,applied_steps_count FROM _prisma_migrations WHERE migration_name=?',args:['20260826_reconcile_schema_history_baseline']});console.log(JSON.stringify(r.rows,null,2))})()\""
```

Assert: exactly one row; `finished_at` non-null; `rolled_back_at` null; the
checksum corresponds to the SHA-verified `migration.sql` from step 3.

---

## Step 7 — deploy the repair

```bash
railway ssh "cd /app && npx prisma migrate deploy"
```

Expected: the baseline is **skipped** (already applied) and
`20260826_restore_missing_schema_objects` applies. **No line of the baseline SQL
may execute.**

---

## Step 8 — verify the repair landed

```bash
railway ssh "node -e \"
const{createClient}=require('/app/node_modules/@libsql/client');
const db=createClient({url:process.env.DATABASE_URL});
(async()=>{
  const obj=async(k,n)=>Number((await db.execute({sql:'SELECT COUNT(*) n FROM sqlite_master WHERE type=? AND name=?',args:[k,n]})).rows[0].n)>0;
  console.log('MonitoringReport table = '+await obj('table','MonitoringReport'));
  for(const i of ['MonitoringReport_type_createdAt_idx','MonitoringReport_createdAt_idx','ContentStrike_createdAt_idx','CreatorPayout_stripeTransferId_idx','CreatorPayout_stripePayoutId_idx','CreatorSubscription_stripeSubscriptionId_idx'])
    console.log('index '+i+' = '+await obj('index',i));
  console.log('MonitoringReport rows = '+JSON.stringify((await db.execute('SELECT COUNT(*) n FROM \\\"MonitoringReport\\\"')).rows));
})()\""
```

All seven objects `true`; the table exists and is empty.

---

## Step 9 — status and residual diff

```bash
railway ssh "cd /app && npx prisma migrate status"
railway ssh "cd /app && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script"
```

`migrate status` must report up to date. The remaining diff must be **exactly**
the registered category-C exceptions and nothing else:

- `DROP TABLE "HealthProbe"` — runtime-owned; never act on it
- `ProfileStatsCache` index rename via `writable_schema` — never run
- `Appeal` / `Post` / `ValueRadarCache` rebuilds — `updatedAt DEFAULT` only

Anything else is unexplained drift: stop and investigate.

---

## Step 10 — application health

```bash
curl -sS https://www.nalaai.com/health
curl -sS https://www.nalaai.com/health/deep
```

Read/write green, no brownout.

---

## Step 11 — merge, then confirm the deploy is boring

Merge at the reviewed head. The Railway deployment applies **nothing** — both
migrations are already in the ledger, and the staged copies vanish with the old
container, replaced by the merged ones. Confirm in the boot window that no
reconciliation SQL ran, that `migrate deploy` reported nothing pending, and that
there is no `P3009` / `P3018`, no `SQLITE_BUSY`, and one `Starting Container`.

---

## If step 7 fails midway

The SQL is idempotent, but **Prisma is not**: a failed migration is recorded in
`_prisma_migrations`, and the next `migrate deploy` refuses to proceed until it
is resolved. Re-running `migrate deploy` is therefore **not** the first move.

```bash
# 1. Find out what actually landed.
railway ssh "cd /app && npx prisma migrate status"
#    plus the seven-object check from step 8.
```

**If the repair is partial or nothing landed:**

```bash
railway ssh "cd /app && npx prisma migrate resolve --rolled-back 20260826_restore_missing_schema_objects"
railway ssh "cd /app && npx prisma migrate deploy"
```

Safe because every statement is `IF NOT EXISTS`, so whatever already exists is
skipped on the retry.

**If all seven objects exist and match their definitions:** the SQL completed and
only the ledger entry is wrong.

```bash
railway ssh "cd /app && npx prisma migrate resolve --applied 20260826_restore_missing_schema_objects"
```

Never hand-edit `_prisma_migrations`. Use `resolve --rolled-back` or
`resolve --applied`; those are the supported paths, and hand-editing the ledger is
how the drift this PR repairs was created.
