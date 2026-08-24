# Payout state machine — review model

Engineering record for the Stripe creator-payout path. Written so a review is a
finite checklist of transitions rather than three files read hopefully.

**Policy this establishes:** for any money path, a transition/crash analysis of
this form is expected *before* the feature is enabled. This document found two
defects that seven rounds of adversarial code review did not, because both are
properties of *states* rather than branches.

Rendered view: see the linked artifact on PR #30.

---

## States

| State | Meaning |
|---|---|
| `pending` | Row created, ledger debited, Stripe not called yet or outcome unknown. **Blocks all further payouts** for this creator (partial unique index). |
| `processing` | Money may have moved; local record incomplete. Needs human settlement. Always accompanied by a fatal Sentry event. |
| `completed` | Transfer succeeded and was recorded. Terminal unless reversed. |
| `failed` | Stripe refused; wallet restored by a compensating credit. Terminal. |
| `reversed` | Transfer fully reversed and fully credited back. Terminal. |

**Ledger convention.** Balance derives *only* from `CreatorWalletLedger`. A payout
writes a `payout:<id>` debit at creation; any restoration writes a compensating
`earning`. The row's `status` is bookkeeping — **money is the ledger**. Every
transition below is judged on its ledger effect, not its status.

---

## Transitions

| Current | Trigger | Stripe reality | DB action | Ledger action | Next | Crash-safe? | Inv. |
|---|---|---|---|---|---|---|---|
| — | POST payout, guards pass | not called | Serializable tx: count pending, balance check, create | `payout:<id>` debit, same tx | `pending` | yes (atomic) | 1,6 |
| `pending` | second concurrent request | not called | insert refused by `creator_payout_pending_unique` → P2002 | none | `pending` | yes | 1,6 |
| `pending` | `transfers.create` returns | transfer created | `status=completed`, `stripeTransferId`, `paidAt` | none | `completed` | yes | 2,5 |
| `pending` | 1st attempt `StripeInvalidRequestError` | no transfer | `status=failed` (same tx as credit) | `payout_reversal:<id>` credit | `failed` | yes (atomic) | 1,3 |
| `pending` | reversal tx itself throws | no transfer | none (rolled back) | none | `pending` | alerts (fatal Sentry) | 2 |
| `pending` | ambiguous, same-key retry succeeds | one transfer | as "transfer created" | none | `completed` | yes | 3,4 |
| `pending` | ambiguous, retry also fails | **unknown** | `status=processing` | **none — debit stands** | `processing` | alerts (fatal Sentry) | 2,3 |
| `pending` | transfer OK, completion write throws | money moved | `status=processing` + `stripeTransferId` | none | `processing` | yes (id recorded) | 2,5 |
| `pending` | reconciler, aged >30min, Stripe **has** a transfer | money moved | adopt id, `status=completed`, `paidAt` | none | `completed` | yes | 2,5 |
| `pending` | reconciler, aged, Stripe has **no** transfer | no money moved | `status=failed` (same tx as credit) | `payout_reversal:<id>` credit | `failed` | yes; frees pending slot | 2,5 |
| `pending` | reconciler, lookup errors / >1 match / freeze on | **unknown** | none — never guesses | none | `pending` | alerts (report marks unresolved) | 1,3 |
| `completed` | `transfer.reversed`, partial | `amount_reversed < amount` | **CAS** `reversedAmountCents: observed → incoming`; status stays `completed` | credit = incoming − observed, same tx | `completed` | yes | 1,2 |
| `completed` | `transfer.reversed`, full | `reversed = true` | **CAS** as above; `status=reversed` | credit = remaining delta, same tx | `reversed` | yes | 1,2 |
| `completed` | duplicate `transfer.reversed` | same cumulative figure | none — delta is 0 | none | unchanged | yes | 4,6 |
| `completed` | **concurrent** `transfer.reversed`, CAS loses | total advanced by a peer | none — tx rolls back | none | unchanged | yes — throws, dedup marker cleared, Stripe retries | 1 |
| `reversed`/`failed` | any later `transfer.reversed` | any | none — terminal skip | none | unchanged | yes | 4 |
| any | `transfer.reversed`, no local row | transfer exists | none — **throws** so Stripe retries | none | unchanged | yes | 2 |
| any | `payout.paid` / `payout.failed` | Connect bank payout | **explicit no-op** — cannot apply (F-2) | none | unchanged | yes (tested) | — |

## Forbidden transitions

Each is the negation of an invariant, and each corresponds to a bug that was
actually shipped and fixed — which is why they are asserted, not assumed.

- `completed` → wallet credited without a matching Stripe reversal (**the double-pay**)
- ambiguous outcome → `failed` + credit
- rate-limit / auth / permission error treated as "no transfer exists"
- partial reversal → terminal status (swallows the remainder, costing the creator)
- two concurrent reversal events each crediting from the same observed total (**over-credit**)
- two `pending` rows for one creator
- payout proceeding while `V1_WALLET_FREEZE` is on (debit silently no-ops)
- payout proceeding while reconciliation is disabled

## Crash windows

One external call (`transfers.create`, possibly issued twice under one
idempotency key) ⇒ three windows.

| Window | Resting state | Money moved? | Detected by | Verdict |
|---|---|---|---|---|
| Before tx commit | — | no | n/a | safe |
| After tx commit, before Stripe call | `pending` | no | reconciler stranded-scan → released | recovered (was F-1) |
| After Stripe success, before completion write | `pending` | yes | stranded-scan adopts id; also `ghostTransfers` | recovered |
| After completion write | `completed` | yes | n/a | safe |

## Reconciler coverage

Runs daily, gated on `CREATOR_MONETIZATION_ENABLED` + a Stripe key, 48h Stripe
window (local rows widened 6h). Two scans: the transfer scan loads rows
`WHERE stripeTransferId IS NOT NULL`; the **stranded scan** loads `pending` rows
with a null transfer id older than 30 minutes.

| State | Covered by | Blind spot |
|---|---|---|
| `pending` | stranded scan (adopt / release / alert) | none |
| `processing` | `ghostTransfers`; fatal Sentry always | alert-dependent when no id recorded |
| `completed` | `missingTransfers`, `amountMismatches`, `reversedMismatches` | none |
| `failed` / `reversed` | `reversedMismatches` | compares booleans only, not amounts |

## Feature-flag matrix

| `CREATOR_PAYOUTS_ENABLED` | `CREATOR_MONETIZATION_ENABLED` | `V1_WALLET_FREEZE` | Behaviour |
|---|---|---|---|
| false | any | any | 503 up front. **Production today.** |
| true | false | any | refused at call site; in production the process refuses to boot |
| true | true | true | refused with 503 — the debit would silently no-op |
| true | true | unset | payouts operate; reconciler runs daily. The only live configuration. |

---

## Stripe API constraint (do not re-derive this wrongly)

`transfers.list` filters on **`created`, `destination`, `transfer_group`,
pagination — and nothing else.** There is **no metadata filter** and **no
`transfers.search`**. Verified against the installed SDK's `TransferListParams`.

Any recovery design that proposes "look the transfer up by its `payoutId`
metadata" is wrong. The transfer therefore carries
`transfer_group = payout_<payoutId>`, which is a first-class list filter and makes
recovery an exact lookup. **If that key changes, recovery silently finds
nothing** — it is asserted by an exact-value test.

## Findings surfaced by this model (both closed)

### F-1 — a crash before the Stripe call stranded the creator, invisibly

The payout tx commits the row and the ledger debit together; Stripe is called
after. Process death in that window left: `pending`, ledger debited, no transfer,
null transfer id. The transfer scan only loads rows *with* an id; `ghostTransfers`
needs a Stripe-side transfer that was never created; a crash runs no catch block
so nothing alerted. The `pending` row then blocked every future payout for that
creator, and the available balance dropped twice (ledger debit *and* the
pending-payout subtraction in `getPayoutBalance`).

**Fixed on the reconciliation side only** — the payout path was not reopened. The
stranded scan asks Stripe per payout: one transfer → adopt and complete (credit
nothing, money moved); none → release with a compensating credit; error / >1 /
freeze active → alert and leave recoverable. It **never issues a transfer**.
Releasing to `failed` rather than deleting frees the partial-unique slot while
keeping the audit row.

*Why the adversarial passes missed it:* every reviewer reasoned about thrown
errors. Process death is not a thrown error — it skips every catch by definition.

### F-2 — two dead transitions that were a trap

`payout.paid` / `payout.failed` filtered on `stripePayoutId = po_… OR
stripeTransferId = po_…`. `stripePayoutId` is **never written to a row** in
production (it appears in `src/` only as a test fixture) and `stripeTransferId`
holds a `tr_…` id. Every such event updated zero rows, silently.

Left alone this was a trap: if anyone began populating `stripePayoutId`,
`payout.failed` would set a terminal status with **no ledger credit**, and
`transfer.reversed` treats `failed` as already-reflected — silently dropping a
real reversal.

Now an explicit, commented, tested no-op. Three pre-existing tests asserted the
*shape* of that unreachable query (one even noted "updateMany with count 0 is a
no-op", recording the symptom without noticing it applied to every event). They
now assert nothing is written.

**Deliberately not made functional.** Connect bank payouts, if ever tracked,
need their own row: `CreatorPayout`'s status vocabulary means "the transfer", not
"the bank payout", and overloading it is what created the trap.

### F-3 — concurrent cumulative reversals over-credited (found in human review)

Found by reviewing the diff against this model, *after* the model had been
written — so the model was necessary but not sufficient.

`amount_reversed` is cumulative, so the credit owed is (incoming − already
credited). "Already credited" was reconstructed by reading ledger rows **before**
the write transaction. Two legitimate reversal events for one transfer carry
**distinct Stripe event ids**, so webhook dedup does not apply; both observed the
same state; and because their ledger descriptions carried different cumulative
figures, the `unique(creatorUserId, description)` index did not collide either.

    A: amount_reversed = 100      reads credited 0  → credits 100
    B: amount_reversed = 100000   reads credited 0  → credits 100000
    total credited 100100 for a 100000 reversal — invariant 1 violated

SQLite serialising writes does not help: the dangerous read happens outside the
transaction, and the two inserts are genuinely distinct rows.

**Fix.** The cumulative total is now persisted on `CreatorPayout.reversedAmountCents`
and advanced by a **compare-and-swap inside the same transaction as the credit**:
`WHERE id = ? AND reversedAmountCents = <observed>`. Exactly one handler may
advance from a given observed value; the loser throws, which rolls back its CAS
and clears the webhook dedup marker so Stripe's retry re-reads and credits the
correct remainder.

This is the same lesson the Apple work produced, arriving independently:
**persist the external state you depend on rather than reconstructing it.** The
reconstruction was not merely awkward — it was unserialisable.

*Class of bug:* correct under ordering, wrong under concurrency. Worth checking
explicitly for, since the staged-reversal test proved the ordered case and passed
throughout.

---

Model derived from `creator-billing.service.ts`,
`creator-stripe-reconciliation.service.ts`, `v1-wallet-freeze.ts`,
`config/index.ts` and `20260527_add_payout_pending_unique`. Invariant numbers
refer to the eight money-path invariants in the PR description. Static analysis
only — no scenario was executed against Stripe.
