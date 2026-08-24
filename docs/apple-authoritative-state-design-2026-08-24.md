# Apple IAP — authoritative-state design

**Status: FROZEN** at revision 3 (2026-08-24), plus the document corrections listed below.
Not implemented. `APPLE_IAP_ENABLED` stays **false through the entire implementation**.

The authority model is frozen — no further architecture revisions. From here the question is
whether the code faithfully implements this document, not whether the model is right.

**Design rule:**

> Apple notifications do not directly mutate entitlement based only on their payload.
> They first prove they are newer/authoritative relative to persisted state.

A notification is a *trigger to reconcile*, not the authority. Apple's documentation warns
that notification history reflects state at the time the notification was sent and may not
reflect current state, and directs you to Get All Subscription Statuses for current state.

### Revision history

- **r1** — position (`signedDate`) as subscription-wide authority. Superseded.
- **r2** — revocation made transaction-scoped; `signedDate` demoted to a per-transaction
  signal; current state reconciled from the App Store Server API.
- **r3 (this)** — reconciliation made a **durable queued job** rather than a synchronous call
  in the webhook (§4); snapshot ordering moved from timestamps to a **persisted generation**
  (§6); **`environment` persisted everywhere and Sandbox isolated from Production
  entitlement** (§7); revocation gains `revocationType`/`revocationPercentage` (§8); billing
  predicates renamed and split (§9); `appAccountToken` designed in (§10).
- **r3 corrections (freeze review)** — `mayAppleCollect` now includes `grace`;
  `REFUND_PRORATED` settled rather than deferred; `REFUND_REVERSED` reclassified in §4 as
  *not* a negative fact; retention wording softened now that `appAccountToken` is persisted.
  Document only — no architecture change.

---

## 1. What is persisted today

| Fact | Where | Problem |
|---|---|---|
| Entitlement | `User.plan`, `User.planExpiresAt`, `User.planStartedAt` | Directly mutated by whatever notification arrives last. |
| Apple link | `User.appleOriginalTransactionId` (unique), `User.applePurchaseSource` | Nulled on EXPIRED, which destroys the only lookup key. |
| Revocation | a marker string stuffed into `applePurchaseSource` | A property of a *transaction* stored in a *per-user* column. This is D6. |
| Notification seen | `AppleIAPWebhookEvent.notificationId` unique | Dedupe only. No ordering, no outcome, deleted again on failure. |
| Environment | **nowhere** | Sandbox and Production transactions are indistinguishable once stored. |

## 2. Failure modes in the current handler

| # | Failure | Mechanism |
|---|---|---|
| **A** | Stale notification overwrites fresh state | Apple retries an unacknowledged V2 notification five times — at 1, 12, 24, 48 and 72 hours after the preceding attempt, roughly 6.5 days — and does not guarantee delivery order. The handler applies whatever arrives, comparing nothing. |
| **B** | Identity destruction, then silent drops | `EXPIRED`/`REVOKE`/`REFUND` null `appleOriginalTransactionId`, which is the only lookup key. Later notifications log "No user found" and return; the dedupe row is already committed, so retries cannot help. |
| **C** | Renewal *preference* mutates entitlement | `DID_CHANGE_RENEWAL_STATUS` rewrites `plan` + `planExpiresAt`, and it fires when auto-renew is turned **off**. |
| **D** | Revocation is not durable | `verifyAndActivatePlan` reads `revocationDate` off the client-submitted JWS, which was signed at purchase and cannot show a later refund. |
| **E** | Failure re-opens the ordering hole | The catch block deletes the idempotency marker, so a half-applied notification can be re-applied after newer state has landed. |
| **F** | No tie-break | Only `expiresDate` is compared. Two events with the same expiry are indistinguishable. |
| **G** | Expiry comparison is not a valid ordering | An **upgrade applies immediately and starts a new billing period**, so a legitimate yearly→monthly switch produces an *earlier* `expiresDate` than the term held. Any `incomingExpiry >= currentExpiry` rule rejects it. |
| **H** | Sandbox is indistinguishable from Production | Nothing persists `environment`, so a TestFlight/Sandbox purchase can project real paid entitlement. |

## 3. The model in one paragraph

Four tables hold Apple's facts: **`AppleTransaction`** (immutable per-transaction facts,
including revocation), **`AppleSubscription`** (the current reconciled snapshot per
subscription), **`AppleNotification`** (audit of every event and what we did with it), and
**`AppleReconciliation`** (the durable work item). `User.plan` / `User.planExpiresAt` become a
**projection** recomputed from those facts by one function, never written by a notification
handler.

## 4. Intake and reconciliation are separate

```
Apple POST
   │
   ├─ verify JWS
   │
   ├─ ONE transaction:
   │     persist AppleNotification
   │     persist transaction fact if present (revocation / reversal) — never a grant
   │     bump AppleSubscription.requestedGeneration
   │     upsert AppleReconciliation (coalescing key: environment + originalTransactionId)
   │
   └─ HTTP 200 ────────────────────────────────► Apple is done

        ▼ (independently, later)
   reconciliation worker
   claim job by lease → Get All Subscription Statuses → persist snapshot (generation CAS)
   → project entitlement
```

**Apple's webhook delivery is not our work queue.** Once a verified notification is durably
recorded we return success. If Apple's API is unavailable afterwards we retry *our own* job.
Deliberately failing the webhook to make Apple resend is unsound in both environments: in
Production it burns one of five retries, and **Sandbox does not retry at all**, so a transient
API blip would silently lose the event entirely.

**What may be applied at intake.** Only the transaction *fact* — never a grant.

| Event | Persist at intake | May remove access | May grant access |
|---|---|---|---|
| `REFUND`, `REVOKE` | yes, after verified JWS + per-transaction CAS | yes, conservatively | no |
| `REFUND_REVERSED` | yes, after verified JWS + per-transaction CAS | no | **no — restoration only after reconciliation** |

`REFUND_REVERSED` is **not** a negative fact: it undoes a refund and can eventually restore
entitlement. Recording it at intake is safe; acting on it is not. A refund or revocation is
monotonic and safety-preserving — applying it can only remove access, and reconciliation
later restores the truth — which is why it alone may take effect before reconciliation.
Every grant and every restoration comes from reconciliation, without exception.

**Rate limiting.** Apple documents Get All Subscription Statuses at 50 requests/sec per app in
Production and 10% of that — 5/sec — in Sandbox; a 429 carries `Retry-After`. Two mechanisms,
because they solve different problems:

- **Coalescing** collapses repeated work for *one* subscription. It is enforced by the unique
  constraint on `AppleReconciliation`, not by an in-memory debounce — a process restart must
  not lose or duplicate pending work.
- **A global limiter** bounds total request rate. Coalescing does nothing for a burst touching
  500 *distinct* subscribers, which is precisely the shape of a price change or a mass
  renewal.

`Retry-After` is honoured, `attemptCount` increments, `nextAttemptAt` backs off, and
`lastError` records why. Sandbox gets its own lower limiter budget.

## 5. Schema

```prisma
model AppleTransaction {
  id                    String    @id @default(uuid())
  environment           String    // 'Production' | 'Sandbox'
  transactionId         String
  originalTransactionId String
  productId             String
  purchaseDate          DateTime
  expiresDate           DateTime?
  type                  String?
  appAccountToken       String?   // section 10

  // Per-transaction ordering. Apple's guarantee is scoped to ONE transactionId,
  // so this cursor is too. It is NOT a subscription-wide clock.
  lastAppliedSignedDate DateTime

  // Revocation is a property of THIS transaction. Section 8.
  revokedAt             DateTime? // Apple's revocationDate, never our clock
  revocationReason      Int?
  revocationType        String?   // REFUND_FULL | REFUND_PRORATED | FAMILY_REVOKE
  revocationPercentage  Int?
  revokedSource         String?   // 'notification' | 'server_api'
  reversedAt            DateTime? // REFUND_REVERSED
  reversedByUUID        String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([environment, transactionId])
  @@index([environment, originalTransactionId])
  @@index([revokedAt])
  @@index([appAccountToken])
}

model AppleSubscription {
  id                    String    @id @default(uuid())
  environment           String
  originalTransactionId String
  userId                String?
  user                  User?     @relation(fields: [userId], references: [id], onDelete: SetNull)

  productId             String
  subscriptionGroupId   String?
  plan                  String

  // Mirrors Apple's subscription status. Read the numeric codes from the
  // app-store-server-library enum at the boundary; never hardcode integers.
  status                String    // active | expired | billing_retry | grace | revoked

  expiresAt             DateTime?
  gracePeriodExpiresAt  DateTime?
  autoRenewStatus       Boolean?
  autoRenewProductId    String?
  appAccountToken       String?

  // The transaction entitlement is projected FROM. If it is later revoked,
  // the projection must be recomputed.
  currentTransactionId  String?

  // Serialization state — section 6. Integers, not timestamps.
  requestedGeneration   Int       @default(0)
  appliedGeneration     Int       @default(0)

  // Observability / audit ONLY. Never an ordering input.
  lastReconciledAt      DateTime?
  snapshotSignedDate    DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([environment, originalTransactionId])
  @@index([userId])
  @@index([status])
}

model AppleReconciliation {
  id                    String    @id @default(uuid())
  environment           String
  originalTransactionId String

  targetGeneration      Int
  reconcileState        String    // pending | running | failed | done
  attemptCount          Int       @default(0)
  nextAttemptAt         DateTime
  lastError             String?

  // Lease, so a crashed worker does not strand a row in `running`.
  leaseOwner            String?
  leaseExpiresAt        DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([environment, originalTransactionId])   // coalescing, enforced by the DB
  @@index([reconcileState, nextAttemptAt])
}

model AppleNotification {   // replaces AppleIAPWebhookEvent
  id                    String    @id @default(uuid())
  environment           String
  notificationUUID      String    @unique
  notificationType      String
  subtype               String?
  signedDate            DateTime
  originalTransactionId String?
  transactionId         String?
  outcome               String    // accepted | superseded | ignored | revoked_block | failed
  reason                String?
  receivedAt            DateTime  @default(now())
  appliedAt             DateTime?

  @@index([environment, originalTransactionId])
  @@index([outcome])
}
```

`notificationUUID` stays globally unique — it is Apple's own UUID and does not collide across
environments — but every *business* identity is composite on `environment`, because
`transactionId` and `originalTransactionId` are only unique **within** an environment. Assuming
one namespace across both is failure mode H.

`AppleTransaction` **subsumes the revoked-transaction table D6 called for**: transaction-scoped,
durable, no FK to `User` (so account deletion cannot erase it), and unaffected by purchases
belonging to other transactions or groups.

## 6. Serialization: generations, not timestamps

Revision 2 proposed CAS on `lastReconciledAt` / `snapshotSignedDate`. **Both are unsound as
ordering inputs.**

- `lastReconciledAt` is *our* clock, stamped when a job finishes. Job A starts, job B starts
  later, B fetches newer state and commits, then A's slower HTTP call returns and stamps
  `now()` — A looks newer and clobbers B with staler data.
- `snapshotSignedDate` would quietly reintroduce cross-transaction `signedDate` ordering, the
  exact thing revision 2 removed. Apple scopes that comparison to one `transactionId`.

The mechanism is a **persisted generation**:

```
intake (same transaction as the AppleNotification write):
    requestedGeneration += 1              → say 42
    AppleReconciliation.targetGeneration = 42

worker:
    claim lease; read targetGeneration G
    call Get All Subscription Statuses

    UPDATE AppleSubscription
       SET <snapshot>, appliedGeneration = G, lastReconciledAt = now()
     WHERE environment = ? AND originalTransactionId = ?
       AND requestedGeneration = G          ← the CAS

    count == 0  → a newer notification bumped the generation while we were in flight.
                  Discard this snapshot entirely and requeue; the newer generation wins.
```

This is the Apple equivalent of the F-3 payout fix: persist the serialization state you
actually rely on, and compare it inside the same statement that writes. `lastReconciledAt` and
`snapshotSignedDate` remain in the schema for observability and audit and are **never** read
by a decision.

The lease exists so a worker that dies mid-flight does not strand a row in `running` forever:
a job whose `leaseExpiresAt` has passed is reclaimable.

## 7. Sandbox must never grant Production entitlement

**Release blocker.** TestFlight purchases run against Sandbox. With `environment` persisted and
identities composite, one rule closes it:

> A transaction may back a paid entitlement only when its `environment` matches the
> environment this deployment sells in. A Sandbox transaction never projects Production
> entitlement, except for an explicitly allowlisted test account.

The projection function enforces it — not the handler, not the controller — so no future
call site can forget. The exclusivity index is therefore scoped to the selling environment:

```sql
CREATE UNIQUE INDEX "apple_subscription_rail_unique"
  ON "AppleSubscription"("userId")
  WHERE "userId" IS NOT NULL
    AND "environment" = 'Production'
    AND "status" IN ('active','grace','billing_retry');
```

A tester may hold a Sandbox subscription and a real one without the two colliding.

## 8. Revocation is transaction-scoped

> An entitlement may never be projected from a transaction carrying an unreversed revocation.
> A revocation of transaction X does **not** revoke transaction Y merely because they share an
> `originalTransactionId`.

Apple documents refunding a prior billing period while the subscription continues, so an
identity-scoped rule (revision 1) would let one historical refund permanently poison a live
subscription — D6 inverted.

`revocationType` distinguishes `REFUND_FULL`, `REFUND_PRORATED` and `FAMILY_REVOKE`, with
`revocationPercentage` recording how much was refunded — for an auto-renewable subscription
that percentage is based on the remaining subscription time.

**All three are treated identically for entitlement**, following Apple's guidance to treat a
prorated refund like a full refund and then act on the current subscription status:

```
REFUND_FULL | REFUND_PRORATED | FAMILY_REVOKE
    → mark that transaction revoked
    → that transaction can no longer back entitlement
    → reconcile the subscription
    → a different, current, valid transaction may still provide entitlement
```

This is the transaction-scoped rule doing exactly what it was designed for: a prorated refund
on historical transaction X does not poison renewal Y, it only stops X being used as the
entitlement source. `revocationPercentage` is retained for accounting, not for the entitlement
decision, which remains the reconciled status.

**Ordering rule for revocation writes.** Every write to a transaction's revocation state —
revoke *and* reverse — must pass that transaction's `lastAppliedSignedDate` CAS. Without it a
stale `REFUND` arriving after a `REFUND_REVERSED` would re-revoke a transaction Apple has told
us to reinstate. Apple supports `REFUND_REVERSED` and expects previously removed service to be
restored.

Nothing else clears a revocation — no client-submitted transaction, no `SUBSCRIBED`.

D5 is closed twice over: the stale `SUBSCRIBED` names the refunded transaction, which cannot
back an entitlement; and grants come from reconciliation, not the payload.

## 9. Three predicates, not one

| Predicate | True when | Answers |
|---|---|---|
| `isEntitled` | `active` (through `expiresAt`) or `grace` (through `gracePeriodExpiresAt`) | Does this person get paid access right now? |
| `mayAppleCollect` | `grace`, `billing_retry`, or `active` with `autoRenewStatus = true` | Could Apple still charge them? |
| `blocksOtherBillingRail` | `active`, `grace`, or `billing_retry` | Should another billing rail be allowed right now? |

`grace` counts toward `mayAppleCollect`: the billing grace period is the *start* of billing
retry, Apple continues attempting collection throughout it, and StoreKit's `isInBillingRetry`
stays true during grace. A user in grace is therefore both entitled **and** still being
charged — the one state where all three predicates are true at once.

`blocksOtherBillingRail` is deliberately the widest and is the one the Stripe path consults.
The naive rule `if (!isEntitled) otherRailAllowed` is what these three exist to prevent: a user
in Apple billing retry is not entitled, so that rule would wave them into Stripe — and Apple
may recover the payment the next day, double-billing them.

**Turning off auto-renew does not release the rail.** It does not erase the already-paid active
period; `blocksOtherBillingRail` stays true until the Apple rail actually leaves
`active`/`grace`/`billing_retry`. Any earlier switch requires a deliberate immediate-switch
workflow, which this design does not include — and no wording here should suggest that
"cancelling" alone permits Stripe.

The exclusion is **symmetric**: an active Apple rail blocks Stripe signup, and an active
Stripe rail blocks the Apple purchase — the latter enforced in the UI *before* StoreKit charges
the customer, since a post-charge rejection means a refund.

## 10. `appAccountToken` — bind the purchase to the account cryptographically

Apple supports `appAccountToken`, a UUID supplied at purchase and returned inside the signed
transaction, specifically to associate an Apple transaction with a customer in our own service.
Nala does not use it. Today user resolution is "whoever currently owns
`AppleSubscription.userId`", which is a lookup, not a proof.

Designed in now because this is the cheapest point to add it: the client sends the token at
purchase, and it is persisted on `AppleTransaction` and `AppleSubscription`. Resolution
prefers `appAccountToken`, falling back to the `originalTransactionId` link for transactions
predating it.

**Not on the critical path.** It is not required to close D5, D6 or H, and it must not delay
the migration. Purchases made before adoption will never carry one, so the fallback is
permanent.

## 11. Notification decision table

| Type | Subtype | Entitlement effect | Queue reconcile | Transaction facts |
|---|---|---|---|---|
| `SUBSCRIBED` | INITIAL_BUY, RESUBSCRIBE | grant, from reconciled state only | yes | upsert |
| `DID_RENEW` | —, BILLING_RECOVERY | extend; status → active | yes | upsert |
| `DID_CHANGE_RENEWAL_PREF` | **UPGRADE** | **immediate** — new billing period begins now | yes | upsert |
| `DID_CHANGE_RENEWAL_PREF` | **DOWNGRADE** | **none now** — future renewal preference only | yes | upsert |
| `DID_CHANGE_RENEWAL_PREF` | *(none)* | **none now** — cancels a prior downgrade | yes | upsert |
| `DID_CHANGE_RENEWAL_STATUS` | AUTO_RENEW_ENABLED/DISABLED | **none** — `autoRenewStatus` only | yes | — |
| `DID_FAIL_TO_RENEW` | GRACE_PERIOD | status → `grace`; entitled to `gracePeriodExpiresAt` | yes | — |
| `DID_FAIL_TO_RENEW` | *(none)* | status → `billing_retry`; not entitled, rail still blocked | yes | — |
| `GRACE_PERIOD_EXPIRED` | | status → expired | yes | — |
| `EXPIRED` | any | status → expired; **link retained** | yes | — |
| `REFUND`, `REVOKE` | | revoke **that transaction**; re-project | yes | set revocation fields (signedDate CAS) |
| `REFUND_REVERSED` | | re-project from remaining facts | yes | set `reversedAt` (signedDate CAS) |
| `REFUND_DECLINED`, `CONSUMPTION_REQUEST` | | none | no | — |
| `PRICE_INCREASE`, `OFFER_REDEEMED`, `RENEWAL_EXTENDED` | | per reconciled state | yes | — |

The `DID_CHANGE_RENEWAL_PREF` split is load-bearing: an upgrade is immediate and starts a new
billing period, which is why the new transaction can carry an *earlier* `expiresDate` than the
term held (failure G).

## 12. Client-initiated paths

- `verifyAndActivatePlan` and `restorePurchases` consult `AppleTransaction` revocation
  **server-side** before granting. The payload's own `revocationDate` remains a cheap early
  reject, not the guard.
- Activation reconciles through the App Store Server API rather than trusting the submitted JWS
  for current state, and refuses a cross-environment grant per §7.
- Ownership conflict moves onto `AppleSubscription.userId` (durable), preferring
  `appAccountToken` where present.
- `planStartedAt` keeps its user-facing meaning and is **not** reused as a cursor — it is
  surfaced via `social.controller.ts`.

## 13. What this closes

| Finding | Closed by |
|---|---|
| **D5** | §8 (the named transaction cannot back an entitlement) **and** §4 (grants come from reconciliation). |
| **D6** | §5: revocation is transaction-keyed with no FK to `User` — survives account deletion (bypass 1); a different group means a different transaction, so it cannot clear group A's revocation (bypass 2). |
| **round-2 #3** | Same root cause as D6, same fix. |
| **D7** | Dissolved — identity lives in `AppleSubscription`, replay protection on `AppleTransaction`. |
| **G** | §11: upgrades recognised by subtype, applied from reconciled state, never by comparing expiries. |
| **H** | §7: `environment` persisted, identities composite, Sandbox cannot project Production entitlement. |

## 14. Migration and backfill

1. Additive migration: four new tables + the partial index. No column dropped.
2. Backfill one `AppleSubscription` per non-null `User.appleOriginalTransactionId`, with
   `environment = 'Production'` and `requestedGeneration = appliedGeneration = 0`, so the first
   reconciliation always wins rather than inventing a snapshot.
3. Seed `AppleTransaction` revocation from any user still carrying the
   `app_store_revoked:<epochMs>` marker.
4. **`User.appleOriginalTransactionId` is dual-written for exactly one release**, then removed.
   During that release it is a compatibility/rollback field only and makes **no** security or
   entitlement decision. Ship a consistency check asserting the column and `AppleSubscription`
   agree; drop it once clean. Apple recommends `originalTransactionId` as the durable
   identifier — it belongs on `AppleSubscription`, not permanently on `User`.
5. **Unrecoverable:** users whose link was already nulled by a past `EXPIRED` cannot be
   reconstructed from our data. This population is empty in practice — Apple IAP has never been
   enabled in production.
6. **Retention and deletion.** `AppleTransaction` deliberately survives account deletion,
   holding an Apple transaction id, an optional `appAccountToken`, and timestamps, with no
   `User` FK. Do **not** treat it as categorically non-personal: Apple defines
   `appAccountToken` precisely to associate a transaction with a customer account, so for as
   long as any mapping to a user exists it is at minimum a pseudonymous account-linked
   identifier. Retention of the revocation fact is justified for fraud prevention; the
   deletion-completeness work must state that justification and decide explicitly whether
   `appAccountToken` is cleared on erasure while the revocation fact is kept. This is a
   privacy/legal wording question, not an architecture one.

## 15. Decisions taken (Jon, 2026-08-24, checked against Apple's documentation)

1. **`User.appleOriginalTransactionId`** — one transitional release, dual-written, verified,
   then dropped.
2. **Apple ↔ Stripe** — mutually exclusive billing rails, symmetric, with entitlement and rail
   blocking treated as separate questions (§9).
3. **Grace period** — full entitlement through `gracePeriodExpiresDate`.
4. **`AppleTransaction` replaces the separate revoked-transaction table** — it satisfies every
   property D6 required.

## 16. Test plan

**Ordering and concurrency**
- slow reconciliation returns after a newer generation committed → CAS refuses, snapshot discarded
- worker dies mid-flight → lease expires, job reclaimed, no duplicate application
- two notifications for one subscription arrive concurrently → exactly one generation wins
- identical `signedDate` twice for one transaction → second recorded `superseded`

**Durability and rate limits**
- Apple API unavailable → webhook still returns 200, job retries, entitlement unchanged
- 429 with `Retry-After` → honoured, `attemptCount` increments, `nextAttemptAt` backs off
- burst across 500 distinct subscribers → global limiter holds; per-subscription coalescing
  alone does not
- process restart with pending work → job survives (DB-backed, not in-memory)

**Environment**
- Sandbox transaction → never projects Production entitlement
- allowlisted test account → Sandbox grant permitted
- Sandbox and Production rows sharing a transaction id → do not collide

**Revocation**
- refund of one prior billing period while the subscription continues → future renewals still granted
- stale `REFUND` arriving after `REFUND_REVERSED` → refused by the per-transaction signedDate CAS
- refund in group A, purchase in group B → group B granted, group A revocation intact
- account deleted and re-registered → revocation still refuses replay of that transaction
- `REFUND_PRORATED` → that transaction revoked exactly like a full refund; a different,
  current, valid transaction still provides entitlement
- `REFUND_REVERSED` recorded at intake → **no** entitlement change until reconciliation runs

**Lifecycle**
- stale `EXPIRED` after `DID_RENEW` → entitlement intact
- `SUBSCRIBED` signed before a `REFUND`, delivered after → refused by both mechanisms
- `DID_CHANGE_RENEWAL_PREF` UPGRADE with an earlier `expiresDate` than the held term → applied
- DOWNGRADE, and no-subtype → current plan unchanged
- `DID_CHANGE_RENEWAL_STATUS` (auto-renew off) → `plan`/`planExpiresAt` unchanged, **and the
  rail stays blocked**
- `DID_FAIL_TO_RENEW` GRACE_PERIOD → entitled through `gracePeriodExpiresAt`, **and
  `mayAppleCollect` is true** (all three predicates true at once)
- `billing_retry` → not entitled, **Stripe signup still blocked**
