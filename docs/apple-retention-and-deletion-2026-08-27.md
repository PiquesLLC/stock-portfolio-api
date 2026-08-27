# Apple billing facts: account deletion, retention, and the export gap

Date: 2026-08-27
Scope: engineering note only. It records what the code does today so the
Sandbox/TestFlight programme starts from documented behaviour rather than
assumption. It does **not** set policy, and it changes no behaviour.

## Why this note exists now

All four Apple tables are empty in production. The moment a real Sandbox
transaction lands that stops being true, so the deletion and retention
behaviour needs to be written down *before* the first transaction, not after.

## What survives deleting a User

The account-deletion handler (`auth.controller.ts`, `tx.user.delete(...)`)
enumerates user-owned records and never touches the Apple tables. It relies
entirely on schema behaviour, which is:

| Table | Link to User | On `DELETE FROM User` |
|---|---|---|
| `AppleSubscription` | `userId` FK, `onDelete: SetNull` | row **survives**, `userId` becomes `NULL` |
| `AppleTransaction` | no User FK | row **survives**, untouched |
| `AppleNotification` | no User FK | row **survives**, untouched |
| `AppleReconciliation` | no User FK | row **survives**, untouched |

Nothing cascades the audit history away, and nothing blocks the deletion. This
is deliberate: these are billing and reconciliation facts about a purchase Apple
made, and they must remain reconcilable after the account is gone.

Post-deletion expected state: the User is gone, the `appleAppAccountToken`
mapping is gone with it, `AppleSubscription` survives unbound, the other three
survive intact. Covered by tests in
`src/__tests__/apple-sandbox-projection.integration.test.ts` (group G).

## What happens if that purchase is seen again

Re-reconciling a surviving subscription after its owner is deleted does **not**
resurrect ownership for the deleted user. Three distinct outcomes, all existing
behaviour, all now pinned by tests:

1. **Tokenized survivor** — the `appAccountToken` is still on the row but now
   resolves to nobody. The binding is `unbound`. A present token decides,
   *including when it decides nobody*, so it blocks the legacy-OTI fallback.
2. **Tokenless survivor, no legacy owner** — the legacy `appleOriginalTransactionId`
   lookup finds nobody. `unbound`.
3. **Tokenless survivor, exactly one surviving legacy owner** — the subscription
   **rebinds** to that user. This is existing, intended compatibility behaviour,
   not a defect introduced here. If we ever decide deletion should permanently
   extinguish legacy reclaimability, that is a **separate policy change** and
   must not be smuggled into an unrelated PR.

A corrupted-data case where two users carry the same legacy OTI resolves to
`unbound` (`rows.length === 1 ? … : null`). `User.appleOriginalTransactionId`
is `@unique`, so a real engine cannot produce it; the test stubs the query
rather than dropping the index, because dropping it would test an invalid
schema state.

## Persistent Apple identifiers that outlive an account

Named explicitly, because "financial records are retained for audit" does not
tell anyone which identifiers those records carry:

| Identifier | Where | Notes |
|---|---|---|
| `originalTransactionId` | `AppleSubscription`, `AppleTransaction`, `AppleNotification`, `AppleReconciliation` | Apple's durable subscription identity. Survives deletion in all four tables. |
| `transactionId` | `AppleTransaction`, `AppleNotification` | per-charge identity |
| `appAccountToken` | `AppleSubscription`, `AppleTransaction` | the pseudonymous UUID we minted to link a purchase to an account. Survives on the Apple rows; the `User.appleAppAccountToken` mapping does not. |
| `notificationUUID` | `AppleNotification` | Apple's delivery identity |
| `AppleReconciliation.id` / `AppleSubscription.id` | both | our own row identities |
| `User.appleOriginalTransactionId` | `User` | transitional compatibility column; goes with the User |

After deletion these are no longer *linked* to a Nala account, but
`appAccountToken` remains a stable pseudonymous identifier for that purchase.
It is not anonymised today.

## Open policy items — deliberately NOT decided here

These are business/legal decisions and are recorded as open, not answered:

1. **Retention duration.** No duration is set for any Apple table. This note
   deliberately does not invent one.
2. **Whether each identifier stays raw, is transformed, or is deleted** while
   the monetary and event facts are kept. Currently everything stays raw.
3. **Whether Apple billing facts should appear in a data-subject export.**

All three should be settled before broad Production rollout. They do not block
Sandbox/TestFlight testing with disposable QA accounts.

## Known gap: data export does not include Apple billing data

`data-export.service.ts` presents itself as a complete export of a user's data.
Its query list contains **none** of the four Apple tables. There is also no
schema-wide deletion-completeness mechanism — the existing "GDPR completeness"
test covers only `ApiUsageLog` and Waitlist.

Stated plainly: **the export is not currently complete with respect to Apple
billing data, and this note does not claim GDPR Article 15/20 coverage.**

No live exposure today — all four Apple tables are empty in production, so no
existing user has Apple data missing from an export. The gap becomes real with
the first genuine transaction.

This PR deliberately does not fix it. Broadening a narrow Sandbox-projection
change into a GDPR export redesign would put an unreviewable amount of
behaviour in the wrong PR. The correct sequencing is: decide the policy
questions above, then implement export/retention to match, and update
`exportUserData()`'s completeness claim in the same change — including an
explicit statement of which Apple records are exportable versus intentionally
retained as billing/audit records.
