# Apple IAP — authoritative-state design

**Status:** design, revision 2. Not implemented. `APPLE_IAP_ENABLED` stays false until this
lands and the adversarial suite is re-run against the re-derived handler.

**Revision 2 (2026-08-24)** incorporates Jon's design review, which was checked against
Apple's current documentation. Three architectural corrections landed, each recorded in place:
revocation is transaction-scoped rather than identity-scoped (§6), `signedDate` is demoted
from subscription-wide total order to a per-transaction ordering signal (§4), and current
subscription state is reconciled from the App Store Server API rather than inferred from the
notification payload (§4). The grace-period field, the upgrade/downgrade split, and the retry
window were also corrected.

**Design rule:**

> Apple notifications do not directly mutate entitlement based only on their payload.
> They first prove they are newer/authoritative relative to persisted state.

Revision 2 sharpens what "authoritative" means. A notification is a *trigger to reconcile*,
not the authority itself. Apple's own documentation warns that notification history reflects
state at the time the notification was sent and may not reflect current state, and directs you
to Get All Subscription Statuses for the current state of an auto-renewable subscription.
Building the state machine on the payload — even a correctly ordered payload — bets on a
guarantee Apple does not make.

---

## 1. What is persisted today

| Fact | Where | Problem |
|---|---|---|
| Entitlement | `User.plan`, `User.planExpiresAt`, `User.planStartedAt` | Directly mutated by whatever notification arrives last. |
| Apple link | `User.appleOriginalTransactionId` (unique), `User.applePurchaseSource` | Nulled on EXPIRED, which destroys the only lookup key. |
| Revocation | a marker string stuffed into `applePurchaseSource` | A property of a *transaction* stored in a *per-user* column. This is D6. |
| Notification seen | `AppleIAPWebhookEvent.notificationId` unique | Dedupe only. No ordering, no outcome, deleted again on failure. |

There is **no** record of which Apple event produced the current entitlement, when Apple
signed it, or what happened to any event we rejected. So "is this newer than what I already
applied?" is unanswerable, and the handler answers a different question instead — "does this
payload look plausible?" — which is what every one of the findings below exploits.

## 2. Failure modes in the current handler

Read from `src/services/apple-iap.service.ts` on master (the version that ships if the flag is
flipped).

| # | Failure | Mechanism |
|---|---|---|
| **A** | Stale notification overwrites fresh state | Apple retries an unacknowledged V2 notification five times — at 1, 12, 24, 48 and 72 hours after the preceding attempt, so roughly 6.5 days from the original failure to the last scheduled retry — and does not guarantee delivery order. `processAppleNotification` applies whatever arrives, comparing nothing. |
| **B** | Identity destruction, then silent drops | `EXPIRED`/`REVOKE`/`REFUND` null `appleOriginalTransactionId`. The user lookup is `findFirst({where:{appleOriginalTransactionId}})`, so every later notification for that subscription — including a legitimate `DID_RENEW` after billing recovery — logs "No user found" and returns. The dedupe row is already committed, so a retry cannot help either. |
| **C** | Renewal *preference* mutates entitlement | `DID_CHANGE_RENEWAL_STATUS` is grouped with `DID_RENEW`/`SUBSCRIBED` and rewrites `plan` + `planExpiresAt`. It also fires when the user turns auto-renew **off**. |
| **D** | Revocation is not durable | Nothing records that a transaction is dead. `verifyAndActivatePlan` reads `revocationDate` off the client-submitted JWS, which was signed at purchase time and cannot show a later refund. |
| **E** | Failure re-opens the ordering hole | The catch block deletes the idempotency marker, so a half-applied notification can be re-applied later, after newer state has landed. |
| **F** | No tie-break | Only `expiresDate` is compared anywhere. Two events carrying the same expiry are indistinguishable. |
| **G** | Expiry comparison is not a valid ordering | An **upgrade applies immediately and starts a new billing period**, so a legitimate yearly→monthly switch produces a transaction whose `expiresDate` is *earlier* than the term currently held. Any `incomingExpiry >= currentExpiry` rule rejects it. |

## 3. The model in one paragraph

Three tables hold Apple's facts: a **transaction** table (immutable per-transaction facts,
including revocation), a **subscription** table (the current reconciled snapshot per
`originalTransactionId`), and a **notification** table (full audit of every event and what we
did with it). `User.plan` / `User.planExpiresAt` become a **projection** recomputed from those
facts by one function — never written directly by a notification handler. The design rule then
stops being a discipline the next patch can forget and becomes a property of the shape of the
code.

## 4. Authority: notification triggers, App Store Server API decides

```
notification arrives
        │
        ├─ verify JWS, persist AppleNotification (never deleted)
        │
        ├─ identify transactionId + originalTransactionId
        │
        ├─ apply TRANSACTION-SCOPED facts directly (revocation, reversal)   ← safe, monotonic
        │
        ├─ reconcile CURRENT state via Get All Subscription Statuses        ← the authority
        │
        ├─ persist AppleSubscription snapshot (CAS on freshness)
        │
        └─ project User entitlement from persisted facts
```

**Why the split.** Transaction-scoped negative facts — a refund, a revocation — are monotonic
and safety-preserving: applying one can only *remove* entitlement, and a stale one cannot
cause harm because a later reconciliation restores the truth. Those may be written straight
from the verified payload. Everything that *grants* or *extends* entitlement must come from a
reconciliation, because the payload cannot prove it is still true.

**What `signedDate` is, and is not.** Apple documents that retries retain the same
`signedDate`, and that when processing multiple notifications **for the same transaction ID**
you should use the one with the newest `signedDate`. That is a per-transaction guarantee.
Apple does **not** document `signedDate` as a total order across the distinct
renewal/upgrade transactions that share an `originalTransactionId`. Revision 1 of this design
bet the entire state machine on that undocumented cross-transaction ordering. It no longer
does:

- `signedDate` is used **per `transactionId`** for dedupe, staleness rejection, CAS and audit.
- Subscription-wide correctness comes from the reconciled snapshot, not from comparing signed
  dates across transactions.

**When reconciliation fails.** If the App Store Server API is unreachable, record
`outcome='failed'` on the notification and retry. Do **not** fall back to projecting a grant
from the payload — that reintroduces exactly the class of bug this design exists to remove.
Transaction-scoped revocations already applied stand, because they are safety-preserving.

Two implementation notes: the App Store Server API is rate-limited, so reconciliation should
be per-notification but coalesced per `originalTransactionId` within a short window; and the
call must target the environment (`Sandbox` / `Production`) carried on the notification.

## 5. Schema

```prisma
model AppleTransaction {
  id                    String    @id @default(uuid())
  transactionId         String    @unique
  originalTransactionId String
  productId             String
  purchaseDate          DateTime
  expiresDate           DateTime?
  type                  String?   // Apple's transaction `type`

  // Per-transaction ordering. Apple's documented guarantee is scoped to one
  // transactionId, so this cursor is too. It is NOT a subscription-wide order.
  lastAppliedSignedDate DateTime

  // Revocation is a property of THIS transaction. See section 6.
  revokedAt             DateTime? // Apple's revocationDate, never our clock
  revocationReason      Int?
  revokedSource         String?   // 'notification' | 'server_api'
  reversedAt            DateTime? // REFUND_REVERSED
  reversedByUUID        String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([originalTransactionId])
  @@index([revokedAt])
}

model AppleSubscription {
  id                    String    @id @default(uuid())
  originalTransactionId String    @unique
  userId                String?
  user                  User?     @relation(fields: [userId], references: [id], onDelete: SetNull)

  productId             String
  subscriptionGroupId   String?
  plan                  String

  // Mirrors Apple's subscription status. Read the numeric codes from the
  // app-store-server-library enum at the boundary; do not hardcode integers.
  status                String    // active | expired | billing_retry | grace | revoked

  expiresAt             DateTime?
  gracePeriodExpiresAt  DateTime?  // Apple's gracePeriodExpiresDate — see section 7
  autoRenewStatus       Boolean?
  autoRenewProductId    String?

  // The transaction entitlement is currently projected FROM. If that transaction
  // is later revoked, the projection must be recomputed.
  currentTransactionId  String?

  // Reconciliation cursor — freshness of this snapshot, not an ordering claim.
  lastReconciledAt      DateTime
  snapshotSource        String     // 'server_api' | 'notification'
  snapshotSignedDate    DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId])
  @@index([status])
}

model AppleNotification {   // replaces AppleIAPWebhookEvent
  id                    String    @id @default(uuid())
  notificationUUID      String    @unique
  notificationType      String
  subtype               String?
  signedDate            DateTime
  originalTransactionId String?
  transactionId         String?
  outcome               String    // applied | superseded | ignored | revoked_block | failed
  reason                String?
  receivedAt            DateTime  @default(now())
  appliedAt             DateTime?

  @@index([originalTransactionId])
  @@index([outcome])
}
```

`AppleTransaction` **subsumes the revoked-transaction table D6 called for.** Revocation is a
property of a transaction, so it lives on the transaction row rather than in a parallel
revoked-only table — and the same row gives the per-transaction `signedDate` cursor a natural
home. It carries no FK to `User`, so it survives account deletion (D6 bypass 1).

Deliberate choices worth arguing with:

- `onDelete: SetNull`, **not** Cascade, on `AppleSubscription.userId`.
- `revokedAt` stores **Apple's** `revocationDate`, never `new Date()`.
- `AppleNotification` rows are **never deleted**, including on failure (failure mode E).
  Retries update `outcome` in place.
- Snapshot writes use CAS on `lastReconciledAt` / `snapshotSignedDate` so a slow reconciliation
  cannot overwrite a fresher one — the same shape as the `reversedAmountCents` fix, for the
  same reason: a read-then-write across an `await` is a lost update.

## 6. Revocation is transaction-scoped

Revision 1 said: *refuse a grant while an unreversed revocation exists for that
`originalTransactionId`, regardless of position.* **That was wrong, and wrong in a dangerous
direction.** Apple documents a refund of a prior billing period revoking that particular
transaction while the subscription continues and future billing proceeds normally. The
revision-1 rule would have let one historical refund permanently poison a live subscription —
the same class of defect as D6, inverted.

The rule is:

> An entitlement may never be projected from a transaction that carries an unreversed
> revocation. A revocation of transaction X does **not** revoke transaction Y merely because
> they share an `originalTransactionId`.

D5 is still closed, by two independent mechanisms:

1. The stale `SUBSCRIBED` names the *refunded* transaction, and that transaction is revoked, so
   no entitlement may be projected from it.
2. Even without (1), the grant does not come from the payload at all — it comes from
   reconciliation, which reports Apple's current truth.

`REFUND_REVERSED` sets `reversedAt`. Nothing else clears a revocation — in particular no
client-submitted transaction and no `SUBSCRIBED`. That is why revocation is a row with a
nullable reversal rather than a boolean flag or a deletable marker.

## 7. Entitlement vs. billing claim — two different questions

These must not be collapsed, because Apple can keep trying to collect long after entitlement
has lapsed.

| Question | Predicate | True when |
|---|---|---|
| **Entitled?** Does this person get paid access right now? | `isEntitled` | `active` (through `expiresAt`) or `grace` (through **`gracePeriodExpiresAt`**) |
| **Billing claim?** Could Apple still charge them? | `hasBillingClaim` | `active`, `grace`, **or `billing_retry`** — Apple may continue collection attempts for up to 60 days |

Projection:

- `active` → entitled until `expiresAt`
- `grace` → entitled until `gracePeriodExpiresAt` (**not** the old `expiresAt`; Apple provides
  the field precisely for this, and directs you to continue service during grace)
- `billing_retry` without grace → **not** entitled, but the billing claim stands
- `expired` / `revoked` → neither

The naive rule `if (!entitled) otherProviderAllowed` is what this table exists to prevent: a
user in Apple billing retry is not entitled, so that rule would wave them into a Stripe
subscription — and Apple could recover the payment the next day, double-billing them.
**Switching billing rails is an explicit operation**, gated on `hasBillingClaim` being false or
on the user cancelling, never an implicit consequence of lapsed entitlement.

The Apple↔Stripe exclusion is **symmetric**: an active Apple rail blocks Stripe signup, and an
active Stripe rail blocks the Apple purchase — the latter enforced in the UI *before* StoreKit
charges the customer, since a post-charge rejection means a refund.

The one-active-subscription-per-user constraint should therefore be written over the
billing-claim set, not just `active`:

```sql
CREATE UNIQUE INDEX "apple_subscription_claim_unique"
  ON "AppleSubscription"("userId")
  WHERE "userId" IS NOT NULL AND "status" IN ('active','grace','billing_retry');
```

## 8. Notification decision table

| Type | Subtype | Entitlement effect | Reconcile | Transaction facts |
|---|---|---|---|---|
| `SUBSCRIBED` | INITIAL_BUY, RESUBSCRIBE | grant, from reconciled state only | yes | upsert |
| `DID_RENEW` | —, BILLING_RECOVERY | extend; status → active | yes | upsert |
| `DID_CHANGE_RENEWAL_PREF` | **UPGRADE** | **immediate** — new billing period begins now; product/plan may change now | yes | upsert |
| `DID_CHANGE_RENEWAL_PREF` | **DOWNGRADE** | **none now** — future renewal preference only | yes | upsert |
| `DID_CHANGE_RENEWAL_PREF` | *(none)* | **none now** — cancels a prior downgrade | yes | upsert |
| `DID_CHANGE_RENEWAL_STATUS` | AUTO_RENEW_ENABLED/DISABLED | **none** — writes `autoRenewStatus` only | yes | — |
| `DID_FAIL_TO_RENEW` | GRACE_PERIOD | status → `grace`; entitlement continues to `gracePeriodExpiresAt` | yes | — |
| `DID_FAIL_TO_RENEW` | *(none)* | status → `billing_retry`; not entitled, claim stands | yes | — |
| `GRACE_PERIOD_EXPIRED` | | status → expired | yes | — |
| `EXPIRED` | any | status → expired; **link retained** | yes | — |
| `REFUND`, `REVOKE` | | revoke **that transaction**; re-project | yes | set `revokedAt` |
| `REFUND_REVERSED` | | re-project from remaining facts | yes | set `reversedAt` |
| `REFUND_DECLINED`, `CONSUMPTION_REQUEST` | | none | no | — |
| `PRICE_INCREASE`, `OFFER_REDEEMED`, `RENEWAL_EXTENDED` | | per reconciled state | yes | — |

The `DID_CHANGE_RENEWAL_PREF` split is load-bearing. An **upgrade is immediate and starts a new
billing period**, which is the concrete reason failure G exists: the new transaction can carry
an *earlier* `expiresDate` than the term currently held, so any expiry-comparison rule rejects
a legitimate upgrade. A **downgrade** changes only what renews next and must not touch the
current plan.

## 9. Client-initiated paths

- `verifyAndActivatePlan` and `restorePurchases` consult `AppleTransaction.revokedAt`
  **server-side** before granting. The payload's own `revocationDate` stays as a cheap early
  reject but is no longer the guard — it cannot show a refund that happened after signing.
- Activation reconciles through the App Store Server API rather than trusting the submitted
  JWS for current state.
- Ownership conflict ("already linked to another account") moves onto
  `AppleSubscription.userId`, which is durable, instead of the nullable `User` column.
- `planStartedAt` keeps its current user-facing meaning and is **not** reused as a cursor — it
  is surfaced via `social.controller.ts`.

## 10. What this closes

| Finding | Closed by |
|---|---|
| **D5** — stale SUBSCRIBED reopens refund replay | §6 (the named transaction is revoked) **and** §4 (grants come from reconciliation, not the payload). |
| **D6** — revoked marker lives on the `User` row | §5: revocation is transaction-keyed with no FK to `User`, surviving account deletion (bypass 1); a different subscription group means a different transaction, so it cannot clear group A's revocation (bypass 2). |
| **round-2 #3** | Same root cause as D6, same fix. |
| **D7** — EXPIRED unlinking vs. not unlinking | Dissolved. The dilemma existed only because one column served as both identity *and* replay guard. Identity now lives in `AppleSubscription`, replay protection on `AppleTransaction`. |
| **G** — upgrade rejected by expiry comparison | §8: upgrades are recognised by subtype and applied from reconciled state, never by comparing expiries. |

## 11. Migration and backfill

1. Additive migration: three new tables + the partial index. No column dropped.
2. Backfill one `AppleSubscription` per non-null `User.appleOriginalTransactionId`.
   `lastReconciledAt` seeds to epoch 0 so the first reconciliation always wins, rather than
   inventing a snapshot.
3. Seed `AppleTransaction.revokedAt` from any user still carrying the
   `app_store_revoked:<epochMs>` marker.
4. **`User.appleOriginalTransactionId` is dual-written for exactly one release**, then removed.
   During that release it is a compatibility/rollback field only and makes **no** security or
   entitlement decision. Ship a consistency check that asserts the column and
   `AppleSubscription` agree; drop the column once it is clean. Apple recommends
   `originalTransactionId` as the durable identifier for an auto-renewable subscription — it
   belongs on `AppleSubscription`, not permanently on `User`.
5. **Unrecoverable:** users whose link was already nulled by a past `EXPIRED` cannot be
   reconstructed from our data. They must return via Apple's History API for a known
   `originalTransactionId`, or a client-side restore. This population is empty in practice,
   because Apple IAP has never been enabled in production.
6. GDPR: `AppleTransaction` deliberately survives account deletion. It holds an Apple
   transaction id and timestamps — no user id, no personal data — and is retained for fraud
   prevention. This must be reflected in the deletion-completeness work rather than silently
   contradicting it.

## 12. Decisions taken (Jon, 2026-08-24, checked against Apple's documentation)

1. **`User.appleOriginalTransactionId`** — keep one transitional release, dual-write, verify
   agreement, then drop. No security or entitlement decisions from it after migration.
2. **Apple ↔ Stripe** — mutually exclusive billing rails, enforced symmetrically, with
   entitlement and billing claim treated as separate questions (§7).
3. **Grace period** — full entitlement through `gracePeriodExpiresDate`.

## 13. Test plan

- stale `EXPIRED` delivered after `DID_RENEW` → entitlement intact
- `SUBSCRIBED` signed before a `REFUND`, delivered after → refused (both mechanisms in §6)
- **refund of one prior billing period while the subscription continues → future renewals still
  granted** (the anti-poisoning case revision 1 would have failed)
- refund in group A, purchase in group B → group B granted, group A revocation still present
- account deleted and re-registered → revocation still refuses replay of that transaction
- `REFUND_REVERSED` → entitlement restored from reconciled facts, not from the client
- `DID_CHANGE_RENEWAL_STATUS` (auto-renew off) → `plan` and `planExpiresAt` unchanged
- **`DID_CHANGE_RENEWAL_PREF` UPGRADE with an earlier `expiresDate` than the held term →
  applied** (failure G)
- `DID_CHANGE_RENEWAL_PREF` DOWNGRADE, and with no subtype → current plan unchanged
- `DID_FAIL_TO_RENEW` GRACE_PERIOD → entitled through `gracePeriodExpiresAt`, not `expiresAt`
- `billing_retry` → not entitled, **but Stripe signup still blocked** (§7)
- reconciliation unavailable → `outcome='failed'`, no grant projected from the payload
- stale reconciliation snapshot arriving late → refused by CAS
- two notifications with identical `signedDate` for one transaction → second `superseded`
- concurrent delivery for one subscription → CAS makes exactly one win
