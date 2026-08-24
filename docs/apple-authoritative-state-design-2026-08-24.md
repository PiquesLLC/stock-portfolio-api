# Apple IAP — authoritative-state design

**Status:** design, not implemented. `APPLE_IAP_ENABLED` stays false until this lands and the
adversarial suite is re-run against the re-derived handler.

**Design rule (the whole point):**

> Apple notifications do not directly mutate entitlement based only on their payload.
> They first prove they are newer/authoritative relative to persisted state.

Today that rule cannot be satisfied, because the state it refers to does not exist. This
document defines that state, the precedence rules over it, and what each notification type is
allowed to do. It closes D5, D6 and round-2 finding #3 structurally rather than by adding
another heuristic.

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
flipped). These are the counterexamples the design must kill.

| # | Failure | Mechanism |
|---|---|---|
| **A** | Stale notification overwrites fresh state | Apple retries an unacknowledged notification for up to 3 days and does not guarantee delivery order. `processAppleNotification` applies whatever arrives, comparing nothing. |
| **B** | Identity destruction, then silent drops | `EXPIRED`/`REVOKE`/`REFUND` null `appleOriginalTransactionId`. The user lookup is `findFirst({where:{appleOriginalTransactionId}})`, so every later notification for that subscription — including a legitimate `DID_RENEW` after billing recovery — logs "No user found" and returns. The dedupe row is already committed, so a retry cannot help either. |
| **C** | Renewal *preference* mutates entitlement | `DID_CHANGE_RENEWAL_STATUS` is grouped with `DID_RENEW`/`SUBSCRIBED` and rewrites `plan` + `planExpiresAt`. It also fires when the user turns auto-renew **off**. |
| **D** | Revocation is not durable | Nothing records that a transaction is dead. `verifyAndActivatePlan` reads `revocationDate` off the client-submitted JWS, which was signed at purchase time and cannot show a later refund. |
| **E** | Failure re-opens the ordering hole | The catch block deletes the idempotency marker, so a half-applied notification can be re-applied later, after newer state has landed. |
| **F** | No tie-break | Only `expiresDate` is compared anywhere. Two events carrying the same expiry are indistinguishable. |

D6's two live bypasses are special cases of **D**: the marker dies with the `User` row on
account deletion, and activating any transaction in a *different* subscription group rebinds
the row and clears it.

## 3. The model: entitlement becomes a projection

Three ideas, in order of importance.

**3.1 The subscription, not the user, is the unit of state.** One row per
`originalTransactionId`, holding everything Apple has told us about that subscription. It is
created on first contact and **never deleted, never unlinked by a lifecycle event**. Expiry is
a status, not an erasure. This alone kills failure B.

**3.2 Every mutation must beat a persisted position.** The row carries
`lastAppliedSignedDate` — Apple's `signedDate` for the event that last advanced it. An
arriving notification may only advance the row if its `signedDate` is strictly greater,
compared **inside the same transaction as the write** via a predicated `updateMany`
(compare-and-swap), not against a value read earlier. This is the same concurrency shape as
the `reversedAmountCents` CAS in the payout path, for the same reason: a read-then-write
across an `await` is a lost update.

**3.3 Revocation is a separate, durable, transaction-keyed fact.** Not a status, not a column
on the user — its own table, outliving the `User` row and independent of subscription group. A
grant is refused while an unreversed revocation exists for that `originalTransactionId`,
**regardless of position**. Position and revocation are orthogonal axes; conflating them is
what produced D5 and D6.

Entitlement (`User.plan`, `User.planExpiresAt`) then becomes a **projection** recomputed from
persisted facts by one function, rather than something each `case` branch writes directly. The
design rule stops being a discipline the next patch can forget, and becomes a property of the
shape of the code.

## 4. Schema

```prisma
model AppleSubscription {
  id                    String    @id @default(uuid())
  originalTransactionId String    @unique
  userId                String?
  user                  User?     @relation(fields: [userId], references: [id], onDelete: SetNull)

  productId             String
  subscriptionGroupId   String?
  plan                  String
  status                String    // active | billing_retry | grace | expired | revoked
  expiresAt             DateTime?
  autoRenewStatus       Boolean?
  autoRenewProductId    String?

  // Authoritative position. The ONLY thing that authorises a mutation.
  lastAppliedSignedDate    DateTime
  lastAppliedTransactionId String?
  lastAppliedType          String?
  lastAppliedUUID          String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId])
  @@index([status])
}

model AppleRevokedTransaction {
  id                    String    @id @default(uuid())
  originalTransactionId String
  transactionId         String    @unique
  revokedAt             DateTime  // Apple's revocationDate, not our clock
  revocationReason      Int?
  source                String    // 'notification' | 'verification'
  reversedAt            DateTime? // REFUND_REVERSED — see 5.3
  reversedByUUID        String?
  createdAt             DateTime  @default(now())

  @@index([originalTransactionId])
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

Plus a partial unique index enforcing **one active Apple subscription per user** — the same
pattern as `creator_payout_pending_unique`:

```sql
CREATE UNIQUE INDEX "apple_subscription_active_unique"
  ON "AppleSubscription"("userId") WHERE "status" = 'active' AND "userId" IS NOT NULL;
```

Deliberate choices worth arguing with:

- `onDelete: SetNull`, **not** Cascade, on `AppleSubscription.userId`, and no FK at all from
  `AppleRevokedTransaction` — a revocation must outlive account deletion, which is D6 bypass
  #1. See section 8 for the GDPR consequence.
- `revokedAt` stores **Apple's** `revocationDate`, never `new Date()`. Our clock has no
  authority over Apple's facts.
- `AppleNotification` rows are **never deleted**, including on failure (failure mode E).
  Retries update `outcome` in place; application is idempotent because the position check
  refuses a replay.

## 5. Precedence rules

### 5.1 Position

Apply if and only if `incoming.signedDate > row.lastAppliedSignedDate`, evaluated as a
predicated `updateMany` in the same transaction as the write. Equal `signedDate` →
`outcome='superseded'`, no mutation. Apple does not guarantee distinct signed dates, so
equality must be a no-op rather than a tie-break guess.

### 5.2 Revocation dominates position

A grant (`SUBSCRIBED`, `DID_RENEW`, or any client activation) is refused while an unreversed
`AppleRevokedTransaction` row exists for that `originalTransactionId` — **even if its
signedDate is newer**. This is exactly D5: a `SUBSCRIBED` generated before a refund, arriving
after it, carries no `revocationDate`, has a future expiry, and passes every content check.
Position alone would admit it. The revocation ledger refuses it.

### 5.3 Revocation is reversible only by Apple saying so

`REFUND_REVERSED` sets `reversedAt`. Nothing else clears a revocation — in particular no
client-submitted transaction and no `SUBSCRIBED`. This is why revocation is modelled as a row
with a nullable reversal rather than a boolean flag or a deletable marker.

### 5.4 Notification decision table

| Type | Entitlement effect | Advances position | Revocation ledger |
|---|---|---|---|
| `SUBSCRIBED` (INITIAL_BUY, RESUBSCRIBE) | grant, unless 5.2 refuses | yes | — |
| `DID_RENEW` (incl. BILLING_RECOVERY) | extend expiry; status → active | yes | — |
| `DID_CHANGE_RENEWAL_PREF` (UPGRADE/DOWNGRADE) | product/plan per payload dates | yes | — |
| `DID_CHANGE_RENEWAL_STATUS` | **none** — writes `autoRenewStatus` only | yes | — |
| `DID_FAIL_TO_RENEW` | status → `billing_retry`/`grace`; **expiry unchanged** | yes | — |
| `GRACE_PERIOD_EXPIRED` | status → expired | yes | — |
| `EXPIRED` | status → expired; **link retained** | yes | — |
| `REFUND`, `REVOKE` | status → revoked | yes | insert row |
| `REFUND_REVERSED` | re-project from remaining facts | yes | set `reversedAt` |
| `REFUND_DECLINED`, `CONSUMPTION_REQUEST` | none | no | — |
| `PRICE_INCREASE`, `OFFER_REDEEMED`, `RENEWAL_EXTENDED` | expiry/product per payload | yes | — |

Two rows carry most of the fixes: `DID_CHANGE_RENEWAL_STATUS` becoming entitlement-neutral
(failure C), and `EXPIRED` retaining the link (failure B).

**Before implementing, confirm the subtype list and the retry window against Apple's current
App Store Server Notifications V2 documentation.** This table is the design intent, written
from the payloads this codebase already handles plus the types it currently drops in
`default:`. It is not a transcription of Apple's spec, and the earlier Stripe episode in this
audit — where a plausible-sounding API claim turned out to be unsupported — is the reason that
distinction is called out rather than assumed.

## 6. Client-initiated paths

`verifyAndActivatePlan` and `restorePurchases` are the same trust problem from the other
direction: the client chooses which signed transaction to present.

- Both consult `AppleRevokedTransaction` **server-side** before granting. The payload's own
  `revocationDate` stays as a cheap early reject but is no longer the guard — it cannot show a
  refund that happened after signing (failure D).
- Activation creates or adopts the `AppleSubscription` row and sets the position from the
  transaction's `signedDate`, so a later stale notification is refused by 5.1.
- Ownership conflict ("already linked to another account") moves onto
  `AppleSubscription.userId`, which is durable, instead of the nullable `User` column.
- `planStartedAt` keeps its current user-facing meaning and is **not** reused as the position
  marker — it is surfaced via `social.controller.ts`.

## 7. What this closes

| Finding | Closed by |
|---|---|
| **D5** — stale SUBSCRIBED reopens refund replay | 5.2: revocation dominates position, so a newer-looking grant is still refused. |
| **D6** — revoked marker lives on the `User` row | Section 4: revocation is transaction-keyed, has no cascade, and survives account deletion (bypass 1) and cross-group purchase (bypass 2), because a group-B purchase creates a *different* `AppleSubscription` and cannot touch group A's revocation row. |
| **round-2 #3** | Same root cause as D6, same fix. |
| **D7** — EXPIRED unlinking vs. not unlinking | Dissolved. The dilemma existed only because the link was doing double duty as identity *and* replay guard. Identity now lives in `AppleSubscription`, replay protection in `AppleRevokedTransaction`, so `EXPIRED` can retain the link without retaining a stale guard. |

## 8. Migration, backfill, and one gap that cannot be closed from our data

1. Additive migration: three new tables + the partial index. No column is dropped;
   `User.appleOriginalTransactionId` remains during transition as the ownership constraint.
2. Backfill one `AppleSubscription` per non-null `User.appleOriginalTransactionId`.
   `lastAppliedSignedDate` has no historical value — seed it to epoch 0 so the first real
   notification always wins, rather than inventing a position.
3. Seed `AppleRevokedTransaction` from any user still carrying the
   `app_store_revoked:<epochMs>` marker.
4. **Unrecoverable:** users whose link was already nulled by a past `EXPIRED` cannot be
   reconstructed from our data — the key is gone. They must come back via Apple's History API
   for a known `originalTransactionId`, or a client-side restore. In practice this population
   is empty, because Apple IAP has never been enabled in production.
5. GDPR: `AppleRevokedTransaction` deliberately survives account deletion. It holds only an
   Apple transaction id and timestamps — no personal data, no user id — and is retained for
   fraud prevention. This needs to be reflected in the deletion-completeness work rather than
   silently contradicting it.

## 9. Open questions for Jon

1. **Keep or drop `User.appleOriginalTransactionId` after transition?** Recommend keeping it
   through one release for the unique-owner constraint, then dropping it once
   `AppleSubscription` is proven authoritative. Dropping it in the same migration would make
   rollback lossy.
2. **Does an active `AppleSubscription` block a Stripe subscription, or vice versa?** Current
   code blocks Apple activation when a Stripe sub exists, but nothing blocks the reverse. That
   asymmetry should be a deliberate product call, not an artefact.
3. **Grace period behaviour.** Does `grace` retain full entitlement? Apple's intent is yes;
   confirm it matches what we want to sell.

## 10. Test plan

The adversarial cases this design must survive, each as a regression test before the flag is
considered:

- stale `EXPIRED` delivered after `DID_RENEW` → refused by position, entitlement intact
- `SUBSCRIBED` signed before a `REFUND`, delivered after → refused by 5.2
- refund in group A, purchase in group B → group B granted, group A revocation still present
- account deleted and re-registered → revocation still refuses the replay
- `REFUND_REVERSED` → entitlement restored from remaining facts, not from the client
- `DID_CHANGE_RENEWAL_STATUS` (auto-renew off) → `plan` and `planExpiresAt` unchanged
- two notifications with identical `signedDate` → second recorded `superseded`, no mutation
- notification fails mid-apply, retried after newer state landed → refused, `outcome='failed'`
  then `superseded`
- concurrent delivery of two notifications for one subscription → CAS makes exactly one win
