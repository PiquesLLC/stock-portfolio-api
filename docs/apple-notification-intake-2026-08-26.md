# Authoritative App Store Server Notification intake

Stage: webhook intake. `APPLE_IAP_ENABLED` and `APPLE_RECONCILIATION_WORKER_ENABLED`
both remain false, so the route short-circuits before any Apple work.

Design authority: `docs/apple-authoritative-state-design-2026-08-24.md` (frozen).
This file records only decisions the contract left to the implementation.

## The rule

> A webhook may establish verified Apple facts and request reconciliation.
> It may not establish entitlement.

`apple-notification-intake.service.ts` never touches `User`, and a test asserts
that at source level as well as behaviourally — no `"User"` string, no
`planExpiresAt` / `planStartedAt` / `applePurchaseSource` / `stripeSubscriptionId`,
no `UPDATE User`, no `DELETE FROM` anywhere.

## What was retired

`apple-iap.service.ts` lost the whole notification path. What it did, and why
each part had to go:

| Legacy behaviour | Problem |
|---|---|
| Wrote `User.plan` from the notification type | The last message to arrive decided what a customer had paid for |
| Resolved the user via `User.appleOriginalTransactionId` | Transitional compatibility state used as authority |
| Cleared `appleOriginalTransactionId` + `applePurchaseSource` on EXPIRED/REFUND | Failure mode B — destroys the ownership fact a later renewal needs |
| `DID_CHANGE_RENEWAL_STATUS` granted a plan | Fires when auto-renew is turned **off** |
| `runJob(maxAttempts: 3)` around the whole thing | A webhook retrying work before answering |
| `deleteMany` on the dedupe marker on failure | A replay could then apply twice |
| Classified errors by searching for `'mismatch'`, `'Missing'` | A reworded library message silently flips a security decision |
| Answered **200** to a failed verification | Tells Apple a forged payload was accepted |

`verifyAndActivatePlan` and `restorePurchases` are deliberately untouched; they
are the next stage.

## Decisions the contract left open

**Ignored types write no transaction fact.** A no-reconcile or unknown type is
audited and nothing else. Persisting its transaction into `AppleTransaction`
would be exactly "letting a one-time-charge notification into the
auto-renewable subscription machinery", and nothing would ever read it, because
no reconciliation was requested. It also keeps the audit vocabulary honest: an
ignored notification stays `ignored` rather than being relabelled `superseded`
by an ordering result that has nothing to do with why it was skipped.

**`DecodedTransaction` gained two fields.** `revocationType` and
`revocationPercentage` live on the *transaction* payload in
`@apple/app-store-server-library` v3.1.0 (`JWSTransactionDecodedPayload`), not on
the notification — verified against the installed library rather than assumed.
`RevocationType` there is exactly `REFUND_FULL | REFUND_PRORATED |
FAMILY_REVOKE`, matching the schema comment and the projector's handling.

**Environment resolution.** The unverified body is decoded once, to *order* the
two verifier attempts. If the hint is wrong the first verification simply fails
and the other environment is tried, so a hostile payload can at most make the
attempts happen in a less convenient order. The persisted environment always
comes from the verified payload; a test proves a `Sandbox` hint on a Production
notification still persists `Production`.

**Transient beats permanent across attempts.** If one environment could not
*complete* its check while the other cleanly rejected, the result is transient.
Answering "permanently invalid" would tell Apple a good payload was forged
because our own OCSP path was down. The test covers both orders — with the
transient raised first the rule is satisfied by accident, since it is also the
first error recorded.

## The refund / reversal state machine

The projector reads an active revocation as `revokedAt !== null && reversedAt
=== null`, so every transition has to leave those two columns saying exactly
what is true.

| Event | `revokedAt` | reversal marker |
|---|---|---|
| REFUND / REVOKE | Apple’s `revocationDate`, required | **cleared** |
| REFUND_REVERSED | preserved | set to the reversal’s signing date |
| REFUND_REVERSED seen first | stays NULL (we never saw the refund) | set |
| Any positive event | untouched | untouched |

The clearing is the part that is easy to miss. Without it, refund → reversal →
**newer** refund leaves the old `reversedAt` in place, the projector reads
"already reversed", and the customer keeps paid access through a live refund.
The superseded reversal survives in the `AppleNotification` audit trail, which
is where history belongs.

Two timestamps that must not be confused, and neither may come from our clock:
`revocationDate` is when the App Store refunded, and a REFUND carrying none is
a semantic failure rather than an invented fact; the reversal instant is when
Apple **signed the reversal**, so dating it from `revocationDate` would place
the reversal before the refund it undoes.

## Transaction identity

`originalTransactionId`, `productId` and `purchaseDate` are all immutable for a
given `(environment, transactionId)`. A later verified JWS that changes any of
them is audited as a contradiction rather than applied, and none of the three
appears in any UPDATE SET list — a transaction’s purchase date is part of what
it *is*, not a field to refresh.

## What bumps the generation

Whether a transaction JWS is newer and whether Apple’s current state is worth
fetching are different questions:

| | fact written | generation bumped |
|---|---|---|
| duplicate notification UUID | no | no |
| distinct reconcile-worthy, newer fact | yes | yes |
| distinct reconcile-worthy, stale/equal fact | no | **yes** |
| semantic contradiction | no | no |
| ignored / no-reconcile type | no | no |

A stale REFUND arriving after a reversal changes no fact but still asks Apple —
cheap insurance, because the Server API is authoritative and the notification
delta is not. Queue identity comes from the verified transaction, falling back
to the verified renewal (cross-checked against each other when both are
present), so a renewal-only event is not silently downgraded to `ignored`.

## Durability

Cryptography happens before the write transaction opens, so certificate/OCSP
latency never holds the SQLite write lock. Then one transaction contains: the
`AppleNotification` insert, the transaction fact, the generation bump via
`enqueueReconciliation` (the existing primitive, handed the tx client), and the
final outcome. Three real-engine tests force a failure at each of those points
and assert the whole thing rolls back, then that a retry applies exactly once.

Dedupe is `ON CONFLICT("notificationUUID") DO NOTHING` with a row-count check —
not find-then-insert, which would let two concurrent deliveries of one
notification both apply the fact and both bump the generation. The conflict
target is that column specifically, so any other constraint failure still raises
instead of masquerading as a duplicate.

## HTTP

| Situation | Status |
|---|---|
| Flag off | 503 `apple_iap_disabled`, nothing constructed or touched |
| Malformed body / missing `signedPayload` | 400 |
| Permanent verification failure | 400 |
| Transient verification failure | 503 `Verification temporarily unavailable` |
| Durability failure | 503 `Notification could not be stored` |
| Verified + committed (`accepted`/`duplicate`/`ignored`/`superseded`/`failed`) | 200 |

200 means durable, not that entitlement is now correct. Whether the reconciler or
Apple's Server API is reachable is irrelevant — the durable queue is the work
queue. The two 503s share a status but carry different bodies, because an
operator needs to tell "our OCSP path is down" from "our database is".

## A limit worth stating

libsql’s node driver is synchronous, so two write transactions cannot genuinely
overlap inside one process: a second `BEGIN IMMEDIATE` blocks the whole thread,
and the connection holding the lock never reaches its COMMIT. The concurrency
suite therefore uses two connections to one database file and proves what that
setup can prove — exactly-once application when one notification is delivered
twice at once, and that deliveries across two connections each advance the
generation.

What it cannot stage is a lost read-modify-write increment. That is why the
increment is a single atomic SQL statement inside the queue primitive rather
than application-level arithmetic, asserted directly: intake never mentions
`targetGeneration` at all.

## Verification

- 52 intake tests (real libsql engine), 15 route tests, 7 trust-boundary tests
  for `verifyNotification`.
- `tsc` 0; ESLint 0 errors.
- 28 mutations, each verified to apply, each killed — including all eight
  targeting the review fixes: stale facts skipping reconciliation, the renewal
  identity fallback, a newer revocation leaving the reversal marker, a
  fabricated `revokedAt`, a reversal dated from the refund, reversal-first
  inserted as a clean transaction, and `purchaseDate` being mutable or rewritten.

Six mutations survived the first run. Two were equivalent mutants whose tests
were nonetheless tightened (the two 503 bodies; the two `ignored` reasons), and
four were real gaps: `originalTransactionId` immutability was untested, the
revocation-percentage test only exercised the INSERT path, the transient/permanent
precedence rule was only tested in the order where it passes by accident, and
`verifyNotification` had no test against the real verifier at all.
