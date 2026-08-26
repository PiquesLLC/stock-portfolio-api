# Apple activation, restore and ownership binding

Stage: activation/restore. `APPLE_IAP_ENABLED` and
`APPLE_RECONCILIATION_WORKER_ENABLED` remain false, so every path here is inert
in production.

Design authority: `docs/apple-authoritative-state-design-2026-08-24.md` (frozen).
This file records what the implementation decided.

## The rule

> A client JWS establishes **which** authoritative subscription should be
> reconciled. It never establishes what the user is entitled to.

And the security property that follows:

> Possessing a valid signed Apple transaction is not a claim to it.

## What was retired

`apple-iap.service.ts` is **deleted**. Nothing imported it any more, and deleting
it is the strongest available proof that none of the following can be reached:

| Legacy behaviour | Problem |
|---|---|
| `SignedDataVerifier` whose environment came from `NODE_ENV` | A Sandbox payload could be checked against Production rules depending on where the code ran |
| Private duplicate of the product→plan map | A second copy is a silent divergence; that copy mapped unknown products to `free` |
| Wrote `plan`, `planExpiresAt`, `planStartedAt`, `applePurchaseSource` from a client JWS | A client-supplied payload decided what a customer had paid for |
| Trusted `expiresDate` / `revocationDate` from that JWS | Current state read from a document the client chose to send |
| Restore picked the largest `expiresDate` | Client array order and a client-supplied expiry deciding entitlement |
| Took `originalTransactionId` from the JWS and wrote it onto the caller | Anyone holding a stranger's signed transaction could attach it to their account |
| Controller matched `'already have an active subscription'` | Rewording a message silently changed the HTTP contract |

## Ownership rests on a token we minted

`User.appleAppAccountToken` is an opaque server-generated UUIDv4. The app fetches
it from `POST /billing/apple-purchase-context`, passes it to StoreKit as
`.appAccountToken(...)`, and Apple echoes it back inside the signed transaction.

It is deliberately **not** `User.id`. Making the ordinary account identifier the
purchase binder would let a modified client pass another known user's UUID and
attach a purchase to that account. The unique index guarantees a verified token
resolves to at most one account, so ownership can never be ambiguous.

Created lazily — production has zero Apple subscribers, so backfilling would mint
29 durable purchase identifiers for accounts that will never use them.

**Concurrency:** the write is `UPDATE ... WHERE appleAppAccountToken IS NULL`, so
two simultaneous requests cannot mint two tokens; the loser matches zero rows and
reads back the winner's value. A read-then-write would hand two UUIDs to one
account, and a purchase made with the discarded one would resolve to nobody.

## Binding precedence

Binding happens inside `completeReconciliation`'s generation-fenced transaction,
between the snapshot write and projection, and is derived from the
**authoritative** snapshot Apple's Server API returned — never from a client
payload.

1. **An existing `AppleSubscription.userId` wins and is never reassigned.** If the
   authoritative token says another account, that is a permanent
   `AppleOwnershipConflictError` — a machine cannot tell which fact is wrong, and
   guessing moves paid access between customers.
2. **A present token decides, including when it decides nobody.** The legacy OTI
   fallback is *not* consulted while a token exists: falling back would let a
   purchase made with an unregistered UUID land on whatever account the
   transitional column happens to point at — exactly the ownership-by-possession
   the token removes.
3. **Only a tokenless snapshot may inherit legacy ownership**, and only inherit —
   never create it.

A token that resolves to one account while the transitional column points at
another is also a permanent conflict. Nothing is stolen, flipped or deleted.

## What the request paths may do

Nothing writes entitlement. `activation` and `ownership` are asserted at source
level to contain no `plan` / `planExpiresAt` / `planStartedAt` /
`applePurchaseSource` write, no `projectAppleEntitlementForUser` call, and no
`getAllSubscriptionStatuses` call.

`/apple-verify` answers **202 `{ status: 'pending' }`** — deliberately not the
plan or expiry from the submitted JWS, because returning those would recreate
client-side authority through the response body even with the database write
gone. Entitlement appears through the existing `billing/status` once the worker
and projector have run.

## The post-charge Stripe race

Pre-charge, purchase-context refuses with 409 when `stripeSubscriptionId` is
non-null — even at plan `free`, because Stripe may still collect through dunning.

Post-charge is the interesting one. Apple already has the customer's money by the
time a signed transaction exists, so `/apple-verify` **enqueues before checking
the Stripe rail** and only then returns 409. Discarding the Apple fact to keep a
tidy-looking database would erase a purchase the customer actually made. The
queued work then reaches the projector, which finds both rails and parks the
conflict for an operator — the same rule learned in #39: when two provider rails
really exist, record both facts and make the conflict durable.

## Restore chooses nothing

Every ownership-qualified subscription is queued, deduplicated by
`(environment, originalTransactionId)`, so multiple JWS values for one
subscription produce **one** reconciliation request. There is no "latest JWS
wins" and no expiry comparison anywhere.

Verification happens outside any write transaction, capped at 50 entries so one
authenticated request cannot trigger unbounded OCSP work.

Three outcomes are kept distinct, because collapsing them misinforms a paying
customer:

| Outcome | Result |
|---|---|
| Permanently invalid JWS, or unrecognised product | **aborts** the call (400) |
| Transient verification failure | **aborts** the call (503) |
| Valid but not owned by this account | excluded, call continues |

Only the third is a statement about ownership. "This payload is invalid" and
"we could not check" must never be reported as "you have no purchases". An empty
result is `no-restorable-purchases`, never `plan: free`.

Ownership is judged per JWS BEFORE deduplication. Deduplicating first would let
array order decide: given a tokenless and a tokenized JWS for one subscription,
whichever arrived first would be the one ownership was judged on.

## Sandbox

Sandbox **binds** — a test purchase should be attributable and auditable — but is
never projected and never dual-writes the transitional Production column. No
Sandbox allowlist is introduced.

## Verification

- 44 tests in `apple-activation-ownership.integration.test.ts` against a real
  libsql engine and the real migration, including the full post-charge Stripe
  race end to end and a lost lease proving it cannot bind.
- Full suite 145 files / 1819 passed / 19 skipped; `tsc` 0; ESLint 0 errors.
- `prisma migrate diff --from-migrations --to-schema` reports No difference.

## Migration ordering

The directory is `20260826_user_apple_app_account_token` and the name is
load-bearing: Prisma applies migrations lexicographically, and this must sort
AFTER the two 20260826_ repair migrations from the history reconciliation. A
14-digit stamp would NOT achieve that — `_` (0x5F) sorts above every digit, so
`20260826000001_...` comes BEFORE `20260826_reconcile_...` and the on-disk
history would claim the Apple work predates its own prerequisite.

## Scope

No `billing.service.ts`, no `railway.json`, no notification-intake, queue,
worker-runtime or projector changes.
