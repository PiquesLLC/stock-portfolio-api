# v2 Ledger Cutover Playbook

This document describes the sequence to flip Nala's creator-wallet
accounting from v1 (libsql / `CreatorWalletLedger`) to v2 (Postgres /
`ledger_entry`) once the shadow-write epoch has accumulated enough
clean-recon evidence.

## Preconditions (do not start cutover until ALL are true)

- [ ] **7 consecutive calendar days** of `[V2 Reconcile] OK` in the
      Railway log stream (no `DIVERGENCE DETECTED` events).
- [ ] **G6 admin_fix mapper deployed and MIG-1 re-run with
      `-v2` marker present** on the persistent volume at
      `/data/.mig-1-completed-v2`.
- [ ] **`/data/mig-1-deferred.csv` is empty** (no rows still parked
      because of an unimplemented mapper). Confirm via:
      `[V2 Gate]` ad-hoc run or by checking the file directly on next deploy.
- [ ] **Live shadow-writes verified end-to-end** at least once for each of:
      `invoice.paid`, `charge.refunded`, `charge.dispute.created`,
      `charge.dispute.closed (won)`, `payout requested`, `payout failed`,
      `transfer.reversed`. If a path has not yet been exercised by real
      production traffic, manufacture a test event in Stripe sandbox-mode
      and confirm both v1 + v2 wrote symmetric entries.
- [ ] **Sentry alert rule wired** for
      `tags.component = v2_reconciliation, level = error` — divergence
      will page on-call once v2 is authoritative.
- [ ] **PG backup verified**: Railway's Postgres-XF5D service is on a
      backup schedule and the most recent backup is < 24h old. Document the
      restore RTO in the runbook (out of scope here).

## Cutover sequence

### T-0: Pre-flight `--gate` run

1. Set Railway env on `stock-portfolio-api`: `V2_RUN_GATE_ONCE=true`.
2. Trigger a redeploy (Railway will auto-deploy on the env-var change).
3. Tail the boot logs:
   ```
   railway logs --service stock-portfolio-api --deployment \
     --lines 500 --filter '[V2 Gate]'
   ```
4. Confirm `[V2 Gate] PASS — no divergence.`
5. Unset `V2_RUN_GATE_ONCE` to prevent the next redeploy from re-running.

If the gate FAILS at this step, abort cutover. Investigate the divergent
creators (see `scripts/v1-vs-v2-reconcile.ts --divergent-out drift.csv`),
fix the root cause, wait for another 7-day clean streak, retry.

### T+0: Freeze v1 writes

Goal: stop new mutations to `CreatorWalletLedger`. v1 stays online for
reads during the verification window.

**WARNING — code shape**: v1 writes are NOT wrapped in named helper
functions like `creditCreatorWallet()`. They are INLINED as
`prisma.creatorWalletLedger.create({...})` calls at ~12 call sites in
`src/services/creator-billing.service.ts`. As of commit `c2be469`, the
exact line numbers are:

```
src/services/creator-billing.service.ts:
  634, 643, 776, 785, 957, 973, 990, 1070, 1101, 1113, 1267, 1627
```

These shift as the file evolves — regenerate the list by running:

```sh
grep -n "prisma\.creatorWalletLedger\.create" src/services/creator-billing.service.ts
```

**Recommended pre-cutover refactor**: a few days before the freeze, add a
helper `assertV1NotFrozen()` (or `if (FREEZE) return null` wrapper) and
have every `prisma.creatorWalletLedger.create({...})` call sit AFTER
this assertion. That way freeze-day is a one-line env flip rather than a
sprawling edit landing under deadline pressure. Add a corresponding test
that calls a representative path with `V1_WALLET_FREEZE=true` and
asserts no `CreatorWalletLedger` row was created.

Then on freeze day:

1. Set Railway env: `V1_WALLET_FREEZE=true`.
2. Redeploy. New Stripe events now ONLY write to v2.
3. Tail logs for a few minutes — no `CreatorWalletLedger` insert log
   lines should appear. (Add a `console.log('[V1 Freeze] skipped insert
   at <site>')` inside the helper if observability is needed.)

### T+0: Flip readers to v2

The payout-balance read at `src/services/creator-billing.service.ts:getPayoutBalanceFromLedger`
sums v1 rows. Replace its implementation with `getBalance('creator', userId)`
from `src/v2/ledger`. Match v1's UI semantic (floor at zero, exclude
`:legacy_destination` rows — these are handled in the v2 ledger
SETUP so the `getBalance` result is directly usable; otherwise add a
clamp in the controller).

Other v1 reads to retire:
- Admin UI's wallet history table (read from `ledger_entry` joined on
  `(account_scope='creator', account_id=<userId>)`).
- Creator-facing wallet history (same).
- 1099-K / 1042-S reporting (sum v2 `EARNING_GROSS` credits over a
  date range).

Test on staging if available; otherwise canary by reading both v1 and v2
and asserting equality in the controller for 24h before deleting the v1 path.

### T+24h: Monitor

For the first week post-cutover:

- Daily `[V2 Reconcile] OK` must still hold. (The reconciliation cron
  continues comparing v1 reads vs v2 reads. Since v1 is frozen, any drift
  now means v1's pre-cutover state had a bug we didn't catch — investigate.)
- Watch payout-balance API responses for unexpected zeros or drops.
- Watch Stripe webhook latencies — v2's `postTransaction` does sequence
  allocator + running-balance triggers per entry; if p95 climbs, consider
  the indexing or trigger plan.

### T+7d: Decommission v1

When the monitoring window closes clean:

1. Delete the `V1_WALLET_FREEZE` guards (v1 is no longer the truth, so
   the guards are mooting; either delete the call sites entirely OR keep
   them as no-ops).
2. Delete `scripts/start.sh`'s MIG-1 hook block (lines ~165-200) — the
   one-shot backfill is permanently complete.
3. Delete `src/v2/reconciliation/cron.ts` and its import in `src/index.ts`
   — there's no v1 to reconcile against anymore.
4. Delete `src/v2/reconciliation/v1-vs-v2.ts` and the CLI at
   `scripts/v1-vs-v2-reconcile.ts`.
5. Delete `src/v2/migration/` (the entire MIG-1 mapper).
6. Add a migration that drops `CreatorWalletLedger` from the v1 schema.
   (Keep the SQLite file with an archive copy preserved on the volume —
   accountants may want it for 7 years.)
7. Unset `V2_SHADOW_WRITE_ENABLED`, `V2_RUN_BACKFILL_ONCE`,
   `V2_RUN_GATE_ONCE` on the Railway service.
8. **Marker file**: `/data/.mig-1-completed-v2` remains on the persistent
   volume. **Leave it** — it serves as archeological evidence that MIG-1
   completed. If a future incident responder wants to verify when the
   migration ran, `ls -la /data/.mig-*` shows the timestamp. Deleting it
   would also delete the audit trail.

Estimated total elapsed: ~4 weeks from start of shadow-write epoch to
v1 fully decommissioned, assuming no divergence incidents.

## Rollback

If something goes wrong between T+0 and T+7d:

1. Unset `V1_WALLET_FREEZE` (v1 writes resume).
2. Revert the reader-flip commit (v1 is source of truth again for reads).
3. Investigate v2 issue with shadow-write still active.

After T+7d (v1 schema dropped), rollback requires restoring from PG +
SQLite backups. Don't go past T+7d without high confidence.

## Files / env vars touched

| File / env | Purpose |
|---|---|
| `scripts/start.sh` MIG-1 + Gate hooks | Boot-time one-shot operations |
| `src/v2/reconciliation/cron.ts` | Daily drift detector |
| `src/v2/reconciliation/v1-vs-v2.ts` | Reconciliation library |
| `scripts/v1-vs-v2-reconcile.ts` | CLI for ad-hoc + `--gate` |
| `src/v2/migration/v1-to-v2-mapper.ts` | MIG-1 mappers (G1-G6) |
| `prisma-v2/seed.ts` | System accounts incl. `adjustment` |
| `V2_DATABASE_URL` (env) | Postgres connection |
| `V2_SHADOW_WRITE_ENABLED` (env) | Live shadow-write gate |
| `V2_RUN_BACKFILL_ONCE` (env) | MIG-1 trigger (one-shot) |
| `V2_RUN_GATE_ONCE` (env) | --gate trigger (pre-cutover sanity) |
| `V1_WALLET_FREEZE` (env, future) | v1 write freeze for cutover |
