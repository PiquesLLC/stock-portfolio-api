# Security audit remediation — 2026-08-23

Branch: `fix/security-audit-2026-08-23` (API). No UI changes were required.

Companion to the audit report. Finding ids (H-n / M-n / L-n) match that report.
Every code change carries an inline comment naming its finding id, so `grep -rn "H-1\|M-2\|L-7" src/` finds the rationale next to the code.

**Status: not deployed.** Working tree only, on a branch. Nothing pushed.

## Production environment verified (2026-08-23)

Checked directly against the linked Railway **production** environment, reading an explicit allowlist of four keys:

| Variable | Production value |
|---|---|
| `WAITLIST_ADMIN_USER_IDS` | set — one id, `237198da-…`, the same account as the hardcoded owner |
| `CREATOR_ADMIN_USER_IDS` | **unset** |
| `APPLE_IAP_ENABLED` | **unset** → false |
| `CREATOR_PAYOUTS_ENABLED` | **unset** → false |

What this means:

- **The `WAITLIST_ADMIN_USER_IDS` fallback risk is not live.** The variable is set, so `config/index.ts` never falls back to `CREATOR_ADMIN_USER_IDS`. And since that list is empty, `isPlatformAdmin` and `isOpsAdmin` both resolve to exactly one account today. The M-14 consolidation is therefore a **no-op in production** — the safest possible outcome for that refactor. The concern remains worth knowing about, but it is latent, not current.
- **Both money features are OFF in production.** Neither Apple IAP nor creator payouts is enabled, so the money-path PR is **inert on merge**. The invariant review can happen before anything is switched on, and the D6 release gate costs nothing to hold.

## How this shipped — four PRs, deliberately separated

The work was split so that **a security fix never requires accepting an unrelated product or legal decision in order to ship**. That rule is worth keeping.

| PR | Contents | Gate |
|----|----------|------|
| **#26 security/hardening** | Validators, error handling, logging/PII, admin consolidation, the *unauthenticated* share-card leak, leaderboard integrity, AI cost gating, axios. No product decisions, no legal copy. | Normal review — mergeable immediately |
| **#30 Stripe payout** | Payout path only, plus the boot-time release gate. | Operationally inert on merge (`CREATOR_PAYOUTS_ENABLED` false in prod). Ready for human review — has survived two independent adversarial passes untouched |
| **#31 Apple IAP** | Apple entitlement handling only. | **Blocked.** `APPLE_IAP_ENABLED` stays false until the schema work below lands and a fresh adversarial pass is clean |
| **#28 paywall behaviour** | Profile aggregate zeroing — the `$0.00` rendering | Product/design decision |
| **#29 privacy policy** | Age-gate copy + IP-collection disclosure | Legal/business approval |

Note the paywall work splits along a natural seam: the **share-card fix is pure security** (an unauthenticated endpoint rendered a paywalled creator's exact net equity, and the fix simply returns no card — no visible change), so it stays in #26. Only the profile-aggregate zeroing produces `$0.00`, so only that moved to #28.

## Process findings

Two lessons from the remediation itself, recorded because they generalise beyond this audit.

**1. Never suppress a Git command's stderr in a release or branch-split script unless you check the exit code immediately.**

While splitting the branch, `git checkout master -- <four paths>` was run with stderr redirected to `/dev/null`. One of those paths (`apple-iap.service.test.ts`) is a new file that does not exist in `master`, so Git failed the **entire** checkout rather than the one path — and the suppression hid it. The result was that the money-path changes silently leaked into the low-risk PR, which is precisely the separation the split existed to create. It was caught only because the next step diffed the branch against `master` and asserted on the file list.

The failure mode is general: Git treats a multi-path pathspec atomically, so one bad path silently voids the whole operation. In any script that moves code between branches, either check `$?` on every Git call or let stderr through.

**2. Verify the production environment before rating a configuration risk.**

The `WAITLIST_ADMIN_USER_IDS` fallback was written up as a live risk. Checking production showed it is **latent, not active** — the variable is set, and `CREATOR_ADMIN_USER_IDS` is empty, so both admin tiers resolve to a single account and the M-14 consolidation is a no-op in production. Likewise, `APPLE_IAP_ENABLED` and `CREATOR_PAYOUTS_ENABLED` are both unset, which means the entire money-path PR is inert on merge and materially lowers the immediate deployment risk.

Neither fact was knowable from the code. Rating a config-dependent finding without reading the environment overstates it.

## Architectural finding — the Apple handler is missing state, not conditionals

**This is the most important conclusion in this document.** It is a design finding, not a bug list, and it is what justifies a schema change.

Across seven remediation rounds, the Stripe payout path converged: it has now survived two independent adversarial passes untouched. The Apple IAP handler broke on **every single round**, and four of those defects were introduced by the fixes themselves:

| Round | Apple defect introduced or missed |
|-------|-----------------------------------|
| 3 | Stale notification could clear the revoked marker |
| 4 | `EXPIRED` still wiped a revoked marker unconditionally |
| 5 | Expiry-only staleness guard discarded legitimate product changes |
| 5 | Predicated write recorded a skipped notification as processed, losing it permanently |
| 6 | Concurrency predicate used a column the renewal branch never writes, so it never engaged |

Every one of those was an attempt to infer *ordering* from the notification payload. That is the error, and it is structural:

**Apple notifications carry no usable ordering relative to what we have already applied.** Apple retries an unacknowledged notification five times over roughly 6.5 days (at 1, 12, 24, 48 and 72 hours after the preceding attempt), reuses `originalTransactionId` across resubscribes, and — decisively — applies upgrades **immediately with proration**, so a legitimate yearly→monthly switch produces a transaction whose `expiresDate` is *earlier* than the term we currently hold.

That single case proves the rule cannot exist:

> `incomingExpiry < currentExpiry` can never be a sound global staleness test, because an immediate proration legitimately shortens the term.

There is no comparison over `(plan, expiresDate)` that separates "stale straggler" from "legitimate immediate downgrade". Both look identical in the payload. The information needed to distinguish them is **not in the notification** — it is the order in which notifications were issued relative to the one we last applied, and we do not persist it.

### The design rule this implies

> An Apple notification must never mutate entitlement directly from its payload. It must first prove it is newer and authoritative relative to persisted state.

That single rule subsumes renewals, stale expirations, refunds, proration and concurrency, and it replaces every heuristic accumulated above.

### Minimum persisted state required

The server must be able to answer two questions durably:

1. **"Which Apple transaction/event is currently authoritative for this user?"** — a persisted latest-applied marker (signed date, or transaction id plus its ordering key), so any arriving notification can be compared against it atomically at write time rather than against an in-memory snapshot.
2. **"Has this transaction been revoked?"** — the revoked-transaction record already identified as D6, keyed by `originalTransactionId` and outliving the `User` row.

Note these are the same shape of problem, and both are currently worked around: (1) by comparing expiries, (2) by a marker stuffed into `applePurchaseSource`. `planStartedAt` cannot be reused for (1) — it is surfaced to users via `social.controller.ts`.

**Recommendation: do not spend another round patching the current Apple code.** Add the state, then re-derive the handler against the design rule, then re-run the adversarial suite. The flag stays off until then.

## Money-path invariants are TWO-SIDED

A correction to how the invariants were framed, earned by a real defect.

While fixing the partial-reversal bug I reasoned that under-crediting was the safe direction "because only over-crediting can breach *never paid twice*." That was wrong, and it shipped: marking a payout `reversed` on a partial made the idempotent skip swallow the follow-up event, so Stripe reversed the remaining balance out of the creator's account while the ledger had credited a fraction of it. I traded an invariant-1 violation for an invariant-2 one.

Safety on a money path is not one-sided. Both halves are required:

- **Never pay or credit MORE than is actually owed.** (Over-payment, duplicate credit.)
- **Never strand or under-credit money that IS actually owed.** (Silent loss to the counterparty.)

Any argument of the form "this errs on the safe side because it can only lose money, not create it" should be treated as a red flag — losing someone else's money is a violation, not a conservative default.

## Verification performed

- `npx tsc --noEmit` — clean
- `npx eslint src/` — **0 errors** (3 pre-existing warnings remain in `src/eval/financial-safety/`, untouched by this work)
- `npx vitest run --no-file-parallelism` — **1423 passed, 19 skipped, 0 failed** (133 files)
- 38 new tests: 3 for the leaderboard `verified` semantics; 12 for H-2 payout outcome handling (idempotent recovery, error classification, the unsound-retry-reversal guard, `maxNetworkRetries: 0`, the 503 on a failed reversal); **14 for Apple IAP** and **9 for `redactPii`**, two areas that previously had no tests at all. 2 existing password-reset tests rewritten to assert enumeration-indistinguishability.

### Apple IAP had zero test coverage

Nothing in the repo exercised `verifyAndActivatePlan` or the notification handler — a service that decides whether a user is entitled to a paid plan. `src/__tests__/apple-iap.service.test.ts` is new, and was likewise proven against the bug: reverting only the service (keeping the new tests) fails 6 of 12, including

```
× REFUSES a transaction whose owner carries the revoked marker (H-1 core)
   → promise resolved "{ plan: 'elite' }" instead of rejecting
× refuses to mint a never-expiring plan from a notification with no expiry
× IGNORES a stale SUBSCRIBED that predates the revocation
```

The first is the refund replay itself, reproduced. The 6 that pass against the old code are the behaviours that were already correct (expiry rejection, Apple-reported revocation, cross-account binding), which is the expected shape.

### The H-2 tests were proven against the bug

A test that passes on both the broken and fixed code proves nothing. The service file was stashed back to its pre-fix state (leaving the new tests in place) and the suite re-run:

```
× does NOT restore the wallet when the transfer outcome is AMBIGUOUS
× does NOT restore the wallet when the transfer SUCCEEDS but the completion write fails
× treats an error with no recognisable Stripe type as ambiguous, not as a rejection
   → all three: expected /sent but confirmation failed/, got "Payout transfer failed — please try again later"
```

That second failure **is** the double-pay: the old code reported a failed transfer and credited the wallet back on a transfer that had actually succeeded. With the fix restored, all 39 tests in the file pass.

### Blind review round 2 — 9 findings, 7 fixed

An independent reviewer with no context on the reasoning above audited the changes. It found a **HIGH defect in the H-2 fix itself**, which is now corrected.

| # | Finding | Outcome |
|---|---------|---------|
| 1 | **HIGH — the ambiguous payout branch stranded the creator's money and was invisible.** My comment claimed `creator-stripe-reconciliation.service.ts` would settle it. It cannot: that service only scans payouts that already carry a `stripeTransferId` (which the ambiguous branch never writes), and it is a read-only reporter that writes no payout or ledger rows. The `payout:<id>` debit is permanent, no webhook fires because nothing exists to emit one, and the only trace was one `console.error`. | **Fixed.** The ambiguity is now *resolved* rather than parked: the transfer is re-issued under the same idempotency key, which Stripe guarantees is at-most-once — it returns the original transfer if one exists and creates it otherwise. A retry Stripe positively refuses proves nothing was created, so reversal is then safe. Only a still-unresolved outcome parks the payout, and that now raises a `fatal` Sentry event. Two new tests. |
| 2 | MEDIUM — `StripeIdempotencyError` classified as "no money moved". It means the key was already used *with different parameters*, i.e. a transfer may exist; reversing on it is the double-pay. | **Fixed** — moved to the ambiguous branch, with a test. |
| 3 | MEDIUM — account deletion erases the H-1 revoked marker (the `User` row owns it), so refund → delete account → re-register → replay the receipt still works. | **Not fixed** — needs the revoked-transaction table, i.e. the schema change excluded from this pass. See "Deliberately not changed". |
| 4 | MEDIUM — the webhook path that clears the revoked marker checked neither `revocationDate` nor a future expiry, and `planExpiresAt: null` means *never expires*. Also cleared the marker on `DID_CHANGE_RENEWAL_STATUS`, which fires when a user toggles auto-renew — no purchase involved. | **Fixed** — both guards added; only `DID_RENEW`/`SUBSCRIBED` clear the marker. |
| 5 | MEDIUM-LOW — the L-2 enumeration fix was incomplete. An attacker can arm a real reset first, then read the *decrementing* `remainingAttempts` (4, 3…) versus a constant. The 429-vs-400 split leaked the same fact. | **Fixed** — every failure now returns a byte-identical 400 with no count. Attempts are still capped server-side. Two tests updated to assert indistinguishability. |
| 6 | LOW-MED — Sentry scrubbing was narrower than my comment claimed: it covered only `exception.values[].value`, not `event.message` or **breadcrumb messages** (where the console integration puts every log line). | **Fixed** — all three plus request URL/query are redacted; the overstated comment corrected. |
| 7 | LOW — the `redactPii` email regex is quadratic on a long dotless run after `@`, and it runs inside `beforeSend` on attacker-influenceable text. | **Fixed** — bounded quantifiers and a 20k scan limit. The reviewer separately confirmed the hex and bearer regexes are clean and cannot eat a UUID or Stripe id. |
| 8 | LOW — three `ai-spend-guard` details. (a) per-user quota spent on globally-rejected calls — *already fixed before the review landed*. (b) a 30s memo discharges an admission while the provider call is still running (45s timeout), so it sits in neither bucket. (c) two concurrent refreshes each zero the other's admissions. | **(b) and (c) fixed** — admissions are now timestamps discharged after a 90s settle window rather than a counter zeroed on refresh. The reviewer confirmed the per-user TTL carry-forward is correct. |
| 9 | LOW — `waitlistAdminUserIds` falls back to `CREATOR_ADMIN_USER_IDS`, so wherever `WAITLIST_ADMIN_USER_IDS` is unset the M-14 tier separation collapses and creator-ops admins reach `/admin/set-plan`. | **Not changed by design** — this is pre-existing config, and altering the fallback could lock administration out of prod. Flagged below as a deploy-time check. |

The reviewer also confirmed correct, having enumerated them: every admin route still carries its guard (M-14 widened access by exactly the one documented owner id); the ticker regex rejects no real symbol shape the app handles; the image dimension check runs before both decoders and leaves the CSV path untouched; and the origin lockdown is genuinely inert with all five exempt paths matching real mounts.

Two pre-existing issues it noticed in passing, not caused by this work: `market.service.ts:119-125` has a comment describing the *old* validator, and its own guard `/^[A-Z0-9.\-^]{1,12}$/` is stricter than the route validator, so `EURUSD=X` passes validation and then silently returns null there.

### Blind review round 5 — round-4 edits verified clean

The final pass found **no defects** in the round-4 fixes. Two LOW notes, both about comment accuracy, both applied:

- The `maxNetworkRetries: 0` comment overstated. `_shouldRetry` short-circuits on `ECONNRESET`/`EPIPE` at `numRetries === 0` *before* the retry-budget check (`RequestSender.js:145-149`, `net/HttpClient.js:30`), so those two codes still get one unconditional internal retry. Verified directly. The fix holds regardless — every outcome of that second attempt except `StripeInvalidRequestError` is now ambiguous and never reverses, and a same-key replay of a request that did create the transfer is served the stored success response, not a 400. The comment now says so.
- Dropping `\b` also makes `idempotency_key: payout-<id>` match, since `_` is a word character. Latent (we log `payoutId`, not the key) but recorded in the code, because that string is the correlator you would give Stripe support.

Independently confirmed by the reviewer and by me: per-request `maxNetworkRetries` is honoured — `utils.js` lists it as a valid option key, `getOptionsFromArgs` copies it under an `Number.isInteger` guard (so `0` survives), and `_getMaxNetworkRetries` tests **defined-ness, not truthiness** (`RequestSender.js:199-204`). A `||` there would have silently restored the default of 2 and undone the fix.

Also confirmed clean: `isDefiniteStripeRejection` has no remaining path where a transfer exists and we reverse; `reverseOrHold`'s boolean is correct on both exits; the Apple three-way branch closes N2 without reintroducing D7 for ordinary churn; `markRevoked` handles every degenerate input and fails closed; `SECRET_ASSIGNMENT_RE` has no ReDoS and does catch this repo's camelCase and JSON config shapes; and `adjustUserQuota` leaks no keys and cannot mis-restart the TTL.

### Blind review round 4 — verification pass, 2 new HIGHs

The round-3 fixes were sent back for verification on the explicit assumption that they contained a defect (rounds 1 and 2 each had). They did — one per money path.

| # | Finding | Outcome |
|---|---------|---------|
| N1 | **HIGH — "the first attempt" was never one HTTP request.** stripe-node defaults `maxNetworkRetries` to **2** and retries internally on connection errors, 409 and 5xx, reusing the same `Idempotency-Key`. So one `await` is up to three attempts and the error we classify is the LAST one. Attempt #1 could create the transfer, its response be lost, and attempt #2 return a 429 from Stripe's edge rate limiter (which never consults the idempotency store, so it does not replay the stored 201). Classifying that as "no transfer exists" reverses the wallet on money already sent — the double-pay, reintroduced through the branch I had kept. | **Fixed both ways.** `maxNetworkRetries: 0` on the transfer call, so one call is one request and our own explicit same-key retry owns recovery; and `isDefiniteStripeRejection` narrowed to `StripeInvalidRequestError` alone — auth, permission and rate-limit errors all fall through to ambiguous. Verified against the installed SDK, not assumed: `stripe.core.js:78` (default is 2), `RequestSender.js:144-179` (retries on `!res`, 409, ≥500), `RequestSender.js:395` (the retry reuses the headers, so the same `Idempotency-Key` rides along), and `RequestSender.js:200-203` + `utils.js:9,201-202` (a **per-request** `maxNetworkRetries` is resolved ahead of the client default — the whole fix rests on this). |
| N2 | **HIGH — the D5 timestamp guard armed only one branch.** `EXPIRED` still nulled both fields unconditionally, so an EXPIRED straggler arriving after a REFUND deleted the marker *and* unbound the transaction — after which the saved pre-refund receipt replays cleanly from any account. The exact H-1 hole, through the one path the fix didn't cover. | **Fixed** — a revoked row keeps its binding and marker on EXPIRED; only the plan is downgraded. |
| M1 | MEDIUM — a failed reversal answered `400 "try again later"`, but the row is still `pending`, so every retry fails with "Existing payout request is still pending". | **Fixed** — `reverseOrHold` reports success, and a failed reversal returns 503 with "do not retry". |
| M2 | MEDIUM — the marker was stamped with OUR `Date.now()` but compared against APPLE's `purchaseDate`, so a delayed REFUND could make a prompt legitimate re-subscription look older than the revocation and refuse a paying customer forever. | **Fixed** — stamps `txn.revocationDate ?? Date.now()`. |
| M3 | MEDIUM — the `\b` before the secret-name alternation missed every camelCase name. `stripeSecretKey=…`, `jwtSecret=…`, `apiToken=…` were NOT redacted — and this codebase's config object uses exactly those names. | **Fixed** — leading `\b` dropped, `authorization` added, and (found by my own test) the separator now tolerates JSON's `"key":"value"`, which it previously never matched. |
| L1 | LOW — a refund to zero stored `0`, which the next spend read as "first call" and used to restart the hour. | **Fixed** — the key is deleted at zero. |
| D6 | HIGH, **unchanged** — `verifyAndActivatePlan` still rebinds and clears the marker when activating any *other* transaction. | **Not fixable without the schema change.** See below. |

The reviewer separately verified as correct: the D1 fix at its own layer (one reversal call site, no post-ambiguity reversal path), `transferId` definite assignment, the legacy un-timestamped marker failing closed, `txn.purchaseDate` being the right field in the right units (epoch ms, Apple-signed so unforgeable), the ai-spend-guard spend/refund symmetry, and that `SECRET_ASSIGNMENT_RE` has no ReDoS.

### Blind review round 3 — 11 findings, 8 fixed

A second independent reviewer audited the money paths and the two new helpers. It found that **the round-2 payout fix had introduced a fresh double-pay path**.

| # | Finding | Outcome |
|---|---------|---------|
| D1 | **HIGH — the idempotent retry could still double-pay.** On a retry failure the code treated a "definite rejection" as proof the key was never consumed. Unsound: Stripe raises a 429 from its rate limiter *before* consulting the idempotency key, and an auth error can come from a key rotated between the two calls. Neither says anything about whether the FIRST attempt created the transfer — so reversing credited the wallet for money already sent. | **Fixed.** The retry path now never reverses, whatever the error looks like. Only a first-attempt rejection is sound evidence (the error came from the very request that would have created the transfer). Stranded funds are recoverable; a double payment is not. |
| D2 | **HIGH — a failed reversal blocked the creator permanently and silently.** `reversePayout` was awaited with no catch; its transaction can throw (SQLITE_BUSY is live on this DB). The row then stays `pending`, which the partial unique index uses to refuse every future payout — and nothing sweeps it. | **Fixed** — wrapped in `reverseOrHold`, which reports a fatal Sentry event. Test asserts the alert fires. |
| D5 | **HIGH — a stale notification reopened the refund replay.** Apple retries an unacknowledged notification five times over roughly 6.5 days (at 1, 12, 24, 48 and 72 hours after the preceding attempt), so a SUBSCRIBED generated *before* a refund can arrive *after* it: no `revocationDate` in its JWS, expiry still future, passes every content check, restores the plan and clears the revoked marker. | **Fixed** — the marker now carries the revocation timestamp (`app_store_revoked:<epochMs>`, encoded in the existing column, no migration), and a purchase notification only clears it when its `purchaseDate` is later. |
| D6 | **HIGH — the revoked marker lives on the User row, so activating ANY other transaction clears it.** Buy in subscription group A → refund → buy the cheapest product in group B (a different `originalTransactionId`): the marker check is keyed on the *submitted* id, so it never fires, and the activation rebinds the row — clearing the marker and unbinding the refunded transaction, which can then be replayed. | **Not fixable without the schema change.** See below. |
| D7 | **MEDIUM — a regression I introduced.** Keeping the binding on EXPIRED meant the same Apple ID could never subscribe on a new Nala account ("already linked to another account"), and worse, the resulting SUBSCRIBED resolved the user by that id and handed the plan to the *abandoned* account while the one that paid got nothing. | **Fixed** — EXPIRED clears the binding again (its expiry check already blocks replay); only REFUND/REVOKE retain it, because only they need the marker. |
| D8 | MEDIUM — the fail-open path admitted the call but skipped the per-user increment, so during a DB outage (global cap also failed open) one account had no backstop at all. | **Fixed** — quota is spent at check time and refunded only when the global cap rejects. |
| D9 | LOW — per-user check-then-act raced across the `await`. | **Fixed** by the same change. |
| D10 | **LOW — my ReDoS bound created a redaction BYPASS.** `{32,128}` with a trailing `\b` means a 200-char hex blob matches *nothing*. | **Fixed** — see D11; the bound is gone. |
| D11 | LOW — length-only hex redaction destroyed legitimate ids (Sentry trace_id 32, git SHA 40, SHA-256 64), including the id used to correlate a Sentry event with a Railway log line. | **Fixed** — secrets are now matched by context (`key=`, `token:`, `"secret":`) with no upper bound, so opaque ids survive and long blobs cannot slip past. |
| D3 | MEDIUM — a payout parked as `processing` has no in-code recovery. | **Documented** (follow-up 6). The reviewer confirmed the balance math in that state is correct: the debit stands, `processing` does not block new requests, and the creator can neither re-claim the stranded amount nor lose the rest. |
| D4 | LOW — `getPayoutBalance` double-subtracts a pending payout (the ledger row and `pendingCents` both count it), under-reporting available balance. | **Not changed** — pre-existing, display-only, and clamped by `Math.max(0, …)`. Under-reporting is the safe direction; changing balance math is not something to do untested. |

### H-1 is NOT fully closed without a schema change

D6 and round-2 finding #3 are the same root cause: **revocation is a property of a transaction, but it is stored in a per-user column.** That leaves two live bypasses of the Apple refund-replay guard:

1. Delete the account and re-register (the marker dies with the `User` row).
2. Buy any product in a different subscription group (the activation rebinds the row and clears the marker).

Both need the same small table — revoked `originalTransactionId`s, keyed by transaction and outliving the user — which was excluded from this pass. **Practical risk today is zero, because `APPLE_IAP_ENABLED` defaults to false.** The recommendation is therefore: allow that one table before enabling Apple IAP, or keep Apple IAP off. Shipping the marker as-is closes the plain buy→refund→replay attack and nothing more.

### Two defects found in this work during self-review

Recorded because both were introduced by the remediation itself, not by the original code:

1. **`isDefiniteStripeRejection` used `err instanceof Stripe.errors.StripeError`.** If `Stripe.errors` is ever undefined — a stubbed SDK, a bundler dropping statics — `x instanceof undefined` **throws**, and it would have thrown inside the error handler on the money path. Rewritten to read `.type` defensively, which degrades to "ambiguous" (no wallet reversal) rather than crashing. The repo's own Stripe test mock has no `errors` static, so this would have fired immediately.
2. **The per-user AI counter was incremented before the global cap check.** A tripped platform breaker would have burned a user's entire hourly allowance on calls that never happened, locking them out after the breaker recovered. Now checked early, spent only on admission.

Static analysis only. Nothing was exercised against production, and the two flag-gated changes are inert by default.

---

## Fixed

### High

| id | Fix |
|----|-----|
| **H-1** | **Apple refund replay.** `verifyAndActivatePlan` read `revocationDate` off the client-submitted JWS, which is signed at purchase time and therefore can never show a later refund — while the refund webhook nulled `appleOriginalTransactionId`, deleting the only replay guard. The webhook now KEEPS the binding and sets `applePurchaseSource = 'app_store_revoked'`; verify rejects a transaction carrying that marker. `EXPIRED` deliberately does **not** set the marker (the receipt's own expiry already blocks it, and Apple reuses `originalTransactionId` across resubscribes, so marking it would break a legitimate return). The marker is cleared only by a signed server-to-server `SUBSCRIBED`/renewal notification — never by anything the client sends. |
| **H-2** | **Creator payout double-pay.** The Stripe transfer and the local "mark completed" write shared one try/catch, so a failed *bookkeeping* write was treated as a failed *transfer* and credited the wallet back after money had left — the retry then produced a second real transfer (a new payout row means a new idempotency key, so Stripe sees a distinct legitimate transfer). Now split into two phases: the wallet is restored **only** when `isDefiniteStripeRejection()` confirms no money moved (invalid-request / auth / permission / card / rate-limit / idempotency errors). Connection and API errors, and any post-transfer failure, park the payout in `processing` for `creator-stripe-reconciliation.service.ts` and never touch the ledger. |
| **H-3** | **Origin lockdown** — implemented, **default OFF**. See "Flag-gated" below. |
| **H-4** | **axios 1.13.6 → 1.19.0**, clearing the prototype-pollution advisories (credential theft / MITM via `config.proxy` / header injection). Prod-tree advisories 35 → 32. Only axios was upgraded, per instruction. |

### Medium

| id | Fix |
|----|-----|
| **M-1** | Removed `--no-audit` from the Railway install command so advisories appear in build logs. `npm install` → `npm ci` deliberately **not** done — see "Not changed". |
| **M-2** | Creator paywall: the profile endpoint zeroed per-holding rows but left the rollup (`totalAssets`, `netEquity`, `cashBalance`, `marginDebt`, `totalPL`, `dayChange`) intact — the exact number the paywall sells. Now calls the existing `zeroPortfolioFinancials()`. Separately, `getPerformanceShareCardData()` had **no creator check at all**, so the unauthenticated `GET /social/:userId/performance-card` rendered a paying creator's exact net equity as a PNG; it now returns null for a paywalled creator. |
| **M-4** | Leaderboard `verified` was the literal `true` on every row, asserting a hand-typed portfolio had been brokerage-checked. Now derived: verified only when the portfolio has ≥1 open position and **every** open position has `source === 'plaid'`. A mixed manual/linked portfolio is not verified. **`basis` was left alone** — it is an unrelated field meaning "was a return computable", and conflating the two was a mistake caught during review. |
| **M-5** | Privacy policy claimed "not intended for users under 18" while signup enforces 13 (`MIN_AGE_YEARS`). Policy corrected to describe the 13+ reality, plus a new disclosure that IP/device data is recorded for security. Age floor unchanged at 13. |
| **M-10** | `/portfolio/news` generated a paid LLM summary for every authenticated caller by default, with no plan check, while every comparable AI surface is behind `requirePlan`. The feed stays free; the summary is now gated by a new `userMeetsPlan()` helper (DB-read, fails closed). Tier is a named constant `SUMMARY_MIN_PLAN = 'premium'` — trivially changed if you'd rather use it as an upgrade hook. |
| **M-11** | AI spend breaker was a 30s-memoized global read with check-then-act, so concurrent callers at the cap boundary all saw the same stale total and all passed. Added (a) an optimistic in-flight charge that resets on each real aggregate read, and (b) a per-user hourly ceiling (`AI_USER_HOURLY_CALL_CAP`, default 120) — the global cap did nothing to stop one account consuming the whole budget. |
| **M-12** | Four controllers echoed raw `error.message` on the 500 path, returning Prisma model/column/constraint names to callers. New `respondWithError()` forwards a message **only** when the error carries an explicit 4xx status (i.e. a service authored it for the user); everything else logs server-side and answers generically. |
| **M-13** | PII in logs: the detached auth side-effect wrote whole provider errors (which embed recipient addresses) to stdout; OAuth logged client IPs on every login; admin routes `JSON.stringify`'d client-controlled fields without control-char stripping. Added `redactPii()` and applied it, dropped the IPs, routed admin logs through `logSafe`. Sentry's `beforeSend` now **drops request bodies and cookies** and applies the same redaction centrally, so every capture path is covered rather than each call site remembering. |
| **M-14** | Four copies of the admin check with three different membership rules. Consolidated into `src/middleware/admin.middleware.ts` with two explicit tiers, **preserving existing privilege boundaries** rather than collapsing them into a union (widening who reaches `/admin/set-plan` is a security decision, not a refactor). Only behavioural change: the hardcoded owner id now also passes the ops tier, which it was inexplicably excluded from in `job-admin.routes.ts`. |

### Low

`L-1` ticker validation (bounded allowlist covering `BRK.B`, `^GSPC`, `EURUSD=X`, OCC option symbols) plus `encodeURIComponent` at the three Yahoo URL sites · `L-2` password-reset enumeration oracle (`remainingAttempts` differed for unknown-email vs no-active-reset; both now return an identical payload) · `L-3` password max length (200 new / 1024 login — deliberately looser so nobody with a pre-existing long password is locked out; bcrypt truncates at 72 bytes regardless) · `L-4` length caps on goals/watchlist free text and a ~$1T ceiling on goal money fields · `L-5` `portfolios`, `push`, `assets` added to the reserved-username list · `L-6` account-deletion cleanup failures now report to Sentry instead of a silent warn · `L-7` image dimension/pixel ceiling before sharp and Tesseract decode (the 10MB cap bounded bytes, not pixels — a decompression bomb).

---

## Flag-gated (inert on next deploy)

**H-3 — origin lockdown.** `ORIGIN_LOCKDOWN_ENFORCE=true` makes the API reject requests that did not arrive through Cloudflare. Exempt: `/health`, `/health/deep` (Railway's deploy healthcheck hits the origin directly — enabling this without the exemption would fail every deploy) and the Stripe/Connect/Apple/Plaid webhooks (called directly by the provider, authenticated by signature).

**Do not enable yet.** The Capacitor native app talks to the Railway origin directly and carries no Cloudflare header, so switching this on today locks out every mobile user. Order:

1. Route native traffic through the Cloudflare hostname, **or** ship a native build sending its own shared secret.
2. Confirm `/health` still answers from the origin.
3. Set `ORIGIN_LOCKDOWN_ENFORCE=true`.

---

## Deliberately not changed

- **M-1 `npm install` → `npm ci`.** `npm ci` is correct, but the existing comment documents that it fails on Railway's npm 10 against an npm 11-generated lockfile. Swapping it blind breaks deploys. Fix lockfile generation first (regenerate with npm 10, or pin npm via `engines`), verify a build, then switch.
- **M-6 refresh-token grace window** (5 min replay of a rotated token). A documented, deliberate trade for cross-tab UX. Narrowing it is a product call.
- **M-7 access-token revocation.** Needs a `tokenVersion` column; schema changes were excluded to avoid diverging from `feat/postgres-v1`. The 15-minute post-logout window remains open.
- **M-8 login-lockout DoS.** Ten bad passwords lock a known username for 30 minutes from any IP. Fixing this properly means IP-scoped counters or progressive delays — a design change to the authentication path, not a patch. Shipping a half-measure here would be worse than leaving it documented.
- **M-9 native refresh token in `localStorage`.** Left as-is, deliberately. On Capacitor, JavaScript reaches Capacitor Preferences and Keychain through the plugin bridge just as easily as `localStorage`, so migrating storage does **not** stop XSS exfiltration — it buys very little while risking the native auth path, and needs an App Store release to take effect at all. The real mitigations are device-binding or a shorter native refresh lifetime.
- **M-3 leaderboard eligibility threshold.** The labelling half is fixed (M-4). Gating ranking on a minimum snapshot history or portfolio value changes who appears on a public leaderboard — a product decision.
- **Review finding #3 — the Apple revoked marker does not survive account deletion.** `applePurchaseSource` lives on the `User` row, and deletion is a hard delete, so: refund → delete account → re-register → replay the saved pre-refund receipt. It needs a small revoked-transaction table keyed by `originalTransactionId` that outlives the user — a schema change, excluded from this pass. The attacker pays with their entire portfolio history for one refunded subscription period, so it is a narrow trade, but the hole is real. **This is the one remaining way H-1 can be defeated.**

---

## Needs your call

1. **UI: paywalled creator profiles will now show `$0.00`** for Total Assets / Net Equity, because the server correctly withholds them. This is the same rendering existing `holdingsVisibility: 'hidden'`/`'sectors'` users already get, so it is not a new case — but `$0.00` asserts a false value rather than withholding one. A "locked" treatment would be better. Per the UI rulebook this needs your visual OK, so it was not built.
2. **Privacy policy wording is legal text.** The 13+ correction and the IP-collection disclosure are factually accurate to the code, but should get a human review before it goes live.
3. **30 advisories remain** in the prod tree (16 moderate, 14 high after axios). Most arrive via the Prisma CLI being a production dependency — which it must be, since `start` runs `prisma migrate deploy`. `typescript` is also in `dependencies` and does not need to be.
4. **`CREATOR_ADMIN_USER_IDS`** now confers ops-admin (job/analytics dashboards) via a single explicit definition. Worth confirming that env var contains only people who should have it.
5. **Check `WAITLIST_ADMIN_USER_IDS` is actually set in production.** `config/index.ts:213` falls back to `CREATOR_ADMIN_USER_IDS` when it is unset, which makes `isPlatformAdmin` identical to `isOpsAdmin` and hands creator-ops admins `/admin/set-plan`. That silently defeats the tier separation M-14 introduced. Pre-existing, and not changed here because altering the fallback could lock administration out of prod — but it wants a one-line check before launch.
6. **Decide on the Apple revoked-transaction table** before `APPLE_IAP_ENABLED` is ever set to true — see "H-1 is NOT fully closed" above. This is the single most consequential open item in this document.
7. **Widen the payout reconciler.** `creator-stripe-reconciliation.service.ts` only scans payouts with a non-null `stripeTransferId`, so a payout left in `processing` with no transfer id is invisible to it. The idempotent retry now makes that state rare and it raises a fatal Sentry event, but the reconciler should still include non-terminal payouts so nothing depends on an alert being read.

---

**Correction, 2026-08-24.** The V2 notification retry window was recorded above as "up to
three days". Apple's current documentation specifies five retries — at 1, 12, 24, 48 and 72
hours after the preceding attempt — which is roughly 6.5 days from the original failure to the
last scheduled retry. Both occurrences were corrected in place. The finding (D5) is unaffected;
only the size of the window it depends on changed, and it widened. Recorded so no later work
derives a retention or ordering assumption from the shorter figure.
