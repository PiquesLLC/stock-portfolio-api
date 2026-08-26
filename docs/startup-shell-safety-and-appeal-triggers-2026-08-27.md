# Startup shell safety, and the two missing Appeal triggers

Two pre-existing production defects, both found during the PR #42 post-deploy
verification rather than by a test. Neither was introduced by #42, and neither
touches Apple IAP: `APPLE_IAP_ENABLED` and `APPLE_RECONCILIATION_WORKER_ENABLED`
stay false throughout.

## A. `start.sh` was handing JavaScript to bash

`scripts/start.sh` carried a ~60-line `node -e "..."` block. Inside it, a comment
read:

```
// `prisma migrate deploy` fails for any reason. Subsequent boots are no-ops:
```

Bash performs command substitution inside double quotes. A comment to a human is
a command to the shell, so on **every boot**:

1. `prisma migrate deploy` ran as a side effect of a comment;
2. its multi-line stdout was spliced into the JavaScript source;
3. Node died with `SyntaxError` before executing one statement;
4. `2>&1 || true` swallowed all of it.

### How it was caught

Only by accident. The #42 verification asked whether the new
`20260826_user_apple_app_account_token` migration had applied. The ledger said
yes with `applied_steps_count = 1` — genuinely *executed* — but the boot log
showed no `Applying migration` line anywhere, and the intended deploy step
reported `No pending migrations to apply`. Something had already applied it. The
`SyntaxError` in the log quoted `54 migrations found in prisma/migrations` as its
source line, which is `prisma migrate deploy` output appearing where JavaScript
should be.

The mechanism was then reproduced locally with a multi-line stub, and again while
writing this repair: the first attempt to extract the block's real text escaped
the backticks incorrectly and printed `prisma: command not found`.

### Consequence

The block has not run since `e04db28` (2026-05-27). Everything it guards —
`UserBlock`, `ValueRadarCache`, `RefreshRotationCache`, `PendingEmailChange`, the
`CreatorWalletLedger` idempotency backfill and index, the `CreatorPayout` pending
pre-clean and partial unique index — has been unprotected for three months. It is
a *fallback* for a failed `migrate deploy`, and `migrate deploy` kept working, so
nothing visibly broke. A schema migration was nevertheless applied by an
invocation nobody knew existed.

### Fix

The logic now lives in `scripts/ensure-critical-tables.cjs` and is invoked as a
file. A path is never shell-interpolated, which removes the whole class rather
than the two offending backticks — the block also contains `${...}`-shaped text
and quoting that would be exposed the same way.

The DDL was **not retyped**. It was extracted by letting bash produce the exact
string Node was supposed to receive (backticks neutralised first), and all 17
`client.execute(...)` statements are byte-identical to the original.

Behaviour is deliberately unchanged, including the fatal/non-fatal split. Exit
status is now the only signal, and it means one thing:

| Exit | Meaning |
|---|---|
| 0 | ran to completion; individual non-fatal warnings may have been printed |
| 1 | could not run at all |

`start.sh` checks that status explicitly instead of `|| true`, and prints a loud
block on failure. It still does not abort the boot — that matches the block's
long-standing classification, and making a fallback newly fatal would add risk
with no evidence behind it. The hard startup invariant remains
`db-repair-verify.cjs`.

## B. Production was missing both Appeal status triggers

`20260320_add_appeals` defines two `BEFORE` triggers rejecting any
`Appeal.status` outside `pending | reviewing | upheld | overturned`. Production
had neither.

The ledger explains it exactly: that migration has **two** rows — one rolled
back with `finished_at IS NULL`, and one applied. It failed partway, was marked
rolled back, and `start.sh` then resolved it as applied on every boot without
re-executing its SQL. The table and its three indexes exist because the startup
fallback block creates them, so the gap was invisible to a table/column/index
audit. `prisma migrate status` reported clean the whole time.

Blast radius today is zero: `Appeal` holds **0 rows**. Nothing needs cleaning up;
this restores intended enforcement only.

### Fix

`20260827_restore_appeal_status_triggers` creates both with
`CREATE TRIGGER IF NOT EXISTS`, bodies character-for-character identical to the
originals, so a repaired database and a fresh replay agree. `IF NOT EXISTS`
skips rather than replaces, so a replayed database keeps the original
definitions.

The name is load-bearing: it must sort after `20260826_user_apple_app_account_token`,
and `_` (0x5F) sorts above every digit, so a same-day `20260826...` stamp would
have sorted *before* it.

The unconditional `migrate resolve --applied 20260320_add_appeals` is removed —
it is the demonstrated root cause. The other eight legacy resolves are untouched
and remain audited debt.

## C. The audit could not have found this

The 20260826 drift audit compared tables, columns and indexes. It never
enumerated triggers, and a category of object that is not enumerated cannot be
found missing.

`scripts/db-schema-drift.cjs` now compares **tables, columns, indexes, triggers
and views**, structurally rather than as `sqlite_master` text: production and a
fresh replay legitimately differ in whitespace and in `IF NOT EXISTS`, and a
textual diff buries real findings under formatting noise. Case is preserved on
purpose — lowercasing would let a trigger enforcing `'PENDING'` compare equal to
one enforcing `'pending'`.

Because production runs in a container with no reference database beside it,
`--emit-facts` runs the same normalisation there and the comparison happens
locally. Reimplementing the normalisation ad hoc would defeat the point.

Measured against production before this repair deploys:

```
[Drift] 8 accepted, 2 unexplained.
[Drift] UNEXPLAINED  missing-from-live  trigger:Appeal.appeal_status_check
[Drift] UNEXPLAINED  missing-from-live  trigger:Appeal.appeal_status_check_update
```

The 8 accepted are the reviewed Category-C set. Each exception is written
narrowly enough that a *new* problem in the same table still surfaces — a blanket
`HealthProbe` or `updatedAt` exemption is what let the Appeal triggers hide, and
there is a test asserting the `updatedAt` exception does not swallow a
nullability change.

## Verification

- `bash -n scripts/start.sh`, `node --check scripts/ensure-critical-tables.cjs`
- 30 new tests across three files; every test was mutation-verified with a
  deliberate no-op control mutation to prove the harness reports real kills.
- The control test in `startup-script-safety.test.ts` reproduces the production
  substitution bug and asserts it *is* observed, so the "cannot be substituted"
  assertion beside it cannot pass vacuously.

## Not in scope

`billing`, Apple IAP, the queue, the worker, the projector, the eight remaining
legacy `migrate resolve` lines, and the second inline `node -e` block in the
`migrate deploy` FAILURE path — that one contains no backticks and no `$`, so it
is not vulnerable today, and rewriting it would broaden a repair PR.
