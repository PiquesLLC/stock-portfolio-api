# Schema-history repair — production runbook

Executed **from the exact reviewed checkout, before merge**, so the Railway
deployment that follows has nothing left to do.

Every command below runs through `railway ssh`, because the database is a file on
the Railway volume (`/data/nala.db`) and is not reachable from a workstation.

---

## Why the preflight is not a formality

`20260324_add_monitoring_reports` and `20260324_add_stripe_indexes` are recorded
as **applied** in production, yet their objects do not exist. Both use
`IF NOT EXISTS`, so they cannot have run and quietly failed — the marker was
written without the SQL executing.

That is the same operation step 3 performs. `resolve --applied` is a way to
manufacture exactly this drift if used without proof. Step 2 is what makes it a
repair rather than a repetition.

---

## Step 1 — restorable copy

`resolve --applied` writes only to `_prisma_migrations`, but this is the ledger
that governs every future deploy. Take the artifact anyway.

```bash
railway ssh "ls -la /data/backups | tail -5"
```

Confirm a recent verified backup, or take one, before continuing.

---

## Step 2 — preflight (the gate)

Category **B** must be genuinely PRESENT; category **A** must be genuinely ABSENT.
If either assertion fails, stop — the classification was wrong.

```bash
railway ssh "node -e \"
const{createClient}=require('@libsql/client');
const db=createClient({url:process.env.DATABASE_URL});
(async()=>{
  const col=async(t,c)=>Number((await db.execute(
    'SELECT COUNT(*) n FROM pragma_table_info('+JSON.stringify(t).replace(/\\\"/g,String.fromCharCode(39))+') WHERE name='+JSON.stringify(c).replace(/\\\"/g,String.fromCharCode(39))
  )).rows[0].n)>0;
  const obj=async(k,n)=>Number((await db.execute({sql:'SELECT COUNT(*) n FROM sqlite_master WHERE type=? AND name=?',args:[k,n]})).rows[0].n)>0;
  let ok=true;
  for(const t of ['DividendCredit','DividendReinvestment','Lot','PortfolioTrade']){
    const p=await col(t,'portfolioId'); if(!p) ok=false;
    console.log('B  '+t+'.portfolioId present='+p+(p?'':'  <-- FAIL'));
  }
  for(const i of ['DividendCredit_portfolioId_ticker_idx','DividendReinvestment_portfolioId_ticker_idx','Lot_portfolioId_ticker_idx','PortfolioTrade_portfolioId_ticker_idx']){
    const p=await obj('index',i); if(!p) ok=false;
    console.log('B  index '+i+' present='+p+(p?'':'  <-- FAIL'));
  }
  const mr=await obj('table','MonitoringReport'); if(mr) ok=false;
  console.log('A  MonitoringReport absent='+(!mr)+(mr?'  <-- FAIL':''));
  for(const i of ['MonitoringReport_type_createdAt_idx','MonitoringReport_createdAt_idx','ContentStrike_createdAt_idx','CreatorPayout_stripeTransferId_idx','CreatorPayout_stripePayoutId_idx','CreatorSubscription_stripeSubscriptionId_idx']){
    const p=await obj('index',i); if(p) ok=false;
    console.log('A  index '+i+' absent='+(!p)+(p?'  <-- FAIL':''));
  }
  console.log(ok?'PREFLIGHT PASS':'PREFLIGHT FAIL - STOP');
})()\""
```

Expected: 8 category-B lines `present=true`, 7 category-A lines `absent=true`,
then `PREFLIGHT PASS`.

---

## Step 3 — baseline (the only ledger mutation)

```bash
railway ssh "npx prisma migrate resolve --applied 20260826_reconcile_schema_history_baseline"
```

This records the migration **without executing its SQL**, which is correct
because step 2 proved production is already in that state.

---

## Step 4 — verify the ledger row

```bash
railway ssh "node -e \"
const{createClient}=require('@libsql/client');
const db=createClient({url:process.env.DATABASE_URL});
(async()=>{const r=await db.execute({sql:'SELECT migration_name,checksum,finished_at,rolled_back_at,applied_steps_count FROM _prisma_migrations WHERE migration_name=?',args:['20260826_reconcile_schema_history_baseline']});console.log(JSON.stringify(r.rows,null,2))})()\""
```

Assert: exactly one row; `finished_at` non-null; `rolled_back_at` null; checksum
matches the reviewed `migration.sql`.

---

## Step 5 — deploy the repair

```bash
railway ssh "npx prisma migrate deploy"
```

Expected: the baseline is **skipped** (already applied) and
`20260826_restore_missing_schema_objects` applies. **No line of the baseline SQL
may execute.**

---

## Step 6 — verify the repair landed

```bash
railway ssh "node -e \"
const{createClient}=require('@libsql/client');
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

## Step 7 — status and residual diff

```bash
railway ssh "npx prisma migrate status"
railway ssh "npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script"
```

`migrate status` must report up to date. The remaining diff must be **exactly**
the registered category-C exceptions and nothing else:

- `DROP TABLE "HealthProbe"` — runtime-owned; never act on it
- `ProfileStatsCache` index rename via `writable_schema` — never run
- `Appeal` / `Post` / `ValueRadarCache` rebuilds — `updatedAt DEFAULT` only

Anything else is unexplained drift: stop and investigate.

---

## Step 8 — application health

```bash
curl -sS https://www.nalaai.com/health
curl -sS https://www.nalaai.com/health/deep
```

Read/write green, no brownout.

---

## Step 9 — merge, then confirm the deploy is boring

Merge at the reviewed head. The Railway deployment should apply **nothing** —
both migrations are already represented in the ledger. Confirm in the boot window
that no reconciliation SQL ran, and that there is no `P3009` / `P3018`, no
`SQLITE_BUSY`, and one `Starting Container`.

---

## If step 5 fails midway

`20260826_restore_missing_schema_objects` is idempotent, so re-running
`migrate deploy` is safe and is the first thing to try. Do **not** hand-edit
`_prisma_migrations` to clear a failed row without first checking which of the
seven objects exist — the repair may be partially applied, which is a valid state
for an `IF NOT EXISTS` migration.
