# Apple entitlement projection — implementation notes

Stage: entitlement projection (the first `User.plan` stage of the Apple IAP
sequence). Both `APPLE_IAP_ENABLED` and `APPLE_RECONCILIATION_WORKER_ENABLED`
remain false, so every path here is inert in production.

Design authority: `docs/apple-authoritative-state-design-2026-08-24.md` (frozen).
This file records only what the implementation decided, measured, or could not
close.

## Where the write happens, and why it matters

`projectAppleEntitlementForUser(tx, userId, now)` recomputes `User.plan` from
persisted Apple facts. It is called from inside `completeReconciliation`'s
callback, after `writeSnapshot`, so:

- a stale generation loses the CAS and never reaches the projection at all;
- the snapshot and the plan commit or roll back as one;
- a projection failure leaves the queue job retryable with backoff.

Mutation-verified: moving the projection outside the CAS callback fails the
stale-generation test.

## Measured, not assumed: DateTime storage

The projector writes `planExpiresAt` / `planStartedAt` through raw SQL, into
columns Prisma also writes. The 2026-07-24 ground-truth audit shows ~40 DateTime
columns holding BOTH TEXT ISO and INTEGER epoch-ms, so the shape mattered.

Measured directly against this schema with the libsql adapter:

| Operation | Result |
|---|---|
| Prisma writes a `DateTime` | `typeof` = **text**, value `2027-01-02T03:04:05.000Z` |
| Prisma reads TEXT `...+00:00` | parses to a `Date`, no throw |
| Prisma reads TEXT `...Z` | parses to a `Date`, no throw |

So Prisma 7 + `PrismaLibSql` writes ISO **text**, not epoch-ms — the integer rows
in the audit are legacy from an older driver. The projector emits
`toISOString()` (the `Z` form) so its writes are byte-identical in shape to
Prisma's own, adding no new divergence to a money column.

`parseTimestampOrNull` still tolerates integers on read, because the legacy rows
are real. Anything unparseable becomes `null`, which fails closed through
`isEntitled` rather than granting on garbage.

## Ownership marker semantics

`User.applePurchaseSource` means **"Apple owns the currently projected plan"**,
not "Apple ever sold this user something".

- Apple grant sets it to `app_store`.
- Apple downgrade (expiry, revocation, billing retry) **keeps** it — clearing it
  is failure mode B in the frozen design; it destroys the fact that lets a later
  renewal be recognised as Apple's.
- A **Stripe grant clears it**. This is the half that is easy to miss: without
  the claim, the marker would still read `app_store` from a previous Apple
  subscription, and a later Apple recomputation would happily downgrade a paid
  Stripe plan. Mutation-verified.

`User.appleOriginalTransactionId` is untouched — it stays transitional
compatibility state and is never consulted for entitlement or rail blocking.

## Sandbox

No Sandbox test-account allowlist is implemented. The frozen contract permits a
narrow, default-empty one; not adding it keeps isolation absolute and the config
surface at zero until there is a real test account to admit. Consequences:

- Only a **Production** reconciliation may recompute a plan.
- `findBlockingAppleRail` and the projector both filter `environment = 'Production'`
  in SQL. Note the JS predicates do **not** check environment — isolation lives
  in the query, which is why the real-engine test asserts it rather than a mocked
  one.

## What this PR does NOT close

**Simultaneous Apple + Stripe purchase.** Closing the race completely needs
persisted reservation state (a claim row taken before either provider-side rail
is created), which the frozen contract explicitly rules out of this stage.

What exists today:

1. `createCheckoutSession` refuses a Stripe checkout while a blocking Production
   Apple rail exists, **before** the Stripe customer or session is created.
2. If a Stripe grant webhook nevertheless arrives while a blocking Apple rail
   exists, it is refused and logged as `RAIL CONFLICT` rather than silently
   overwriting Apple — **but the Stripe subscription id is recorded first**.
   That ordering is load-bearing. The Stripe subscription really exists at the
   provider and may be charging the customer, and the projector detects a
   double rail *only* through a non-null `stripeSubscriptionId`. A refused
   grant that returned without recording it would leave Stripe billing a
   customer while Nala believed there was no Stripe rail at all, and the next
   Apple reconciliation would grant normally and never park the conflict.
3. If the Apple projection finds a blocking rail alongside a live
   `stripeSubscriptionId`, it raises `BillingRailConflictError`, changes nothing,
   clears no Stripe field, and the job is parked permanently
   (`PERMANENT_PARK_MS`) rather than retried every few seconds.

The residual window: a user who begins Apple and Stripe purchases within the same
few seconds can complete both, because neither provider tells us about an
in-progress purchase. The outcome is a parked reconciliation and a loud conflict
log, with **no** silent winner and no plan mutation — an operator resolves it, and
the existing parked-job recovery requeues the work afterwards. Closing it belongs
to the activation/restore stage, where the client-side purchase flow can take a
reservation first.

**Also still open** (later stages, unchanged by this PR): the legacy
`apple-iap.service.ts` / `apple-iap.controller.ts` still grant and downgrade
directly from client-submitted transactions and notification payloads, which
violates the frozen authority model. Those routes are safe only because
`APPLE_IAP_ENABLED=false`. Authoritative webhook intake and the activation/restore
rewrite replace them before the flag can be turned on.

## The ownership guard is decided at the write

A Stripe downgrade must never free a plan Apple owns. The obvious shape —
read `applePurchaseSource`, branch on it, then write — is a check-then-write
race: an Apple reconciliation can grant and claim the plan in between, and the
downgrade then erases a subscription that was just paid for.

So no Stripe handler reads ownership at all any more. The test is part of the
WHERE clause of the downgrade itself (`downgradeIfNotAppleOwned`), and a
blocked downgrade reports zero rows changed, which is what raises the operator
warning. Re-reading just before the write would only have narrowed the window.

The NULL branch is written out explicitly:

```sql
AND ("applePurchaseSource" IS NULL OR "applePurchaseSource" <> ?)
```

`applePurchaseSource <> 'app_store'` alone evaluates to NULL — and therefore
not true — for every row where the column is NULL, which is most of them.
Written the obvious way, this guard would silently skip every ordinary Stripe
user and no downgrade would ever apply.

## Verification

- 52 tests in `apple-entitlement-projection.integration.test.ts` (real libsql
  engine, real migration), 23 in `billing.service.test.ts`.
- `tsc` 0; ESLint 0 errors.
- Mutations, each verified to apply, each killed — including projection outside
  the CAS, every predicate collapse, both revocation guards, the ownership
  checks, the Sandbox filter, every Stripe-side guard, dropping the rail-identity
  write, dropping the ownership predicate from the downgrade, dropping its NULL
  branch, and reporting a blocked downgrade as successful.
