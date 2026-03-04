# Billing Edge Case Audit

Date: 2026-03-04
Scope: Read-only investigation of billing edge cases in `stock-portfolio-api` and checkout return behavior in `stock-portfolio-ui`.

## 1) Webhook replay for `charge.refunded`

### Files read
- `src/services/billing.service.ts`
- `src/controllers/billing.controller.ts`
- `prisma/schema.prisma`
- `prisma/migrations/0001_baseline/migration.sql`

### Code path traced
1. `billingWebhookHandler` verifies Stripe signature and calls `handleWebhookEvent(event)`.
2. `handleWebhookEvent` first writes to `BillingWebhookEvent` with `eventId` + `eventType`.
3. If insert throws `P2002`, handler returns early (duplicate delivery for same Stripe event id).
4. For `charge.refunded`, logic executes only after idempotency insert succeeds.
5. On branch failure, the idempotency row is removed (`deleteMany where eventId`) so Stripe retry can reprocess.

### Finding
- Replay with the **same Stripe event id** is safe. It is deduped by `BillingWebhookEvent.eventId @unique` before any refund logic runs.
- Duplicate `charge.refunded` deliveries therefore do not cause repeated business side effects.
- If a logically duplicate refund ever arrived as a **different event id**, this table would not dedupe it (idempotency is event-id based, not charge-id based). In that case, behavior is still mostly stable because downgrade to free is idempotent and Stripe cancel errors are swallowed.

### Risk rating
- **safe** (for normal Stripe retry/replay semantics)

---

## 2) Refund-after-resubscribe edge case

Scenario: user subscribes -> cancels -> gets refunded -> resubscribes before old refund webhook arrives.

### Files read
- `src/services/billing.service.ts`

### Code path traced
1. In `charge.refunded`, handler resolves refunded subscription via `charge.invoice -> invoice.subscription`.
2. It loads current user by `stripeCustomerId`, selecting current `stripeSubscriptionId`.
3. Guard: if `refundedSubscriptionId` exists and does **not** match current `stripeSubscriptionId`, handler logs and returns (skip downgrade).
4. If it matches, handler cancels current Stripe subscription and downgrades user to `free`.

### Finding
- The main edge case is handled correctly when invoice/subscription linkage is present: old-refund webhook will **not** downgrade a newly active subscription.
- Gap: if `refundedSubscriptionId` cannot be resolved (null), mismatch guard is bypassed and handler can proceed against current subscription by customer id.
- That means ambiguous refund payloads can still downgrade current plan.

### Risk rating
- **needs fix** (narrow but real fallback-path gap)

Suggested hardening:
- Fail closed when full refund lacks resolvable `invoice.subscription` (log + skip downgrade), or
- Record/compare additional linkage (invoice id / charge id -> subscription id) before plan changes.

---

## 3) Checkout redirect polling/backoff

### Files read
- `stock-portfolio-ui/src/App.tsx`
- `stock-portfolio-ui/src/context/AuthContext.tsx`
- `stock-portfolio-ui/src/components/PricingPage.tsx`

### Code path traced
1. Pricing starts Stripe checkout and redirects (`window.location.href = checkoutUrl`).
2. On return, `App.tsx` checks query param `checkout=success` once in a mount effect.
3. It immediately shows success toast and calls `refreshUser()` once.
4. `refreshUser()` calls `/auth/me` once; no polling loop, no retry/backoff for webhook lag.

### Finding
- There is no dedicated post-checkout polling mechanism waiting for webhook settlement.
- If webhook has not updated user plan yet at first refresh, UI can temporarily show stale plan/state until a later manual/automatic refresh event.

### Risk rating
- **needs fix**

Suggested hardening:
- Add short bounded polling after `checkout=success` (for example 5-8 attempts with backoff) until plan tier changes or timeout.

---

## 4) Partial refund policy

### Files read
- `src/services/billing.service.ts`

### Code path traced
1. In `charge.refunded`, handler checks:
   - `if (charge.amount_refunded < charge.amount) return;`
2. Only full refunds continue to cancellation + downgrade logic.

### Finding
- Partial refunds are intentionally treated as no-op for subscription entitlement in this handler.
- No downgrade occurs on partial refund.
- This is consistent code behavior; whether it is correct depends on product policy.

### Risk rating
- **low risk** (implementation is explicit, but policy should be confirmed/documented)

---

## Overall summary
- `charge.refunded` replay handling is robust for normal Stripe duplicate delivery (`event.id` idempotency).
- Old-refund-after-resubscribe is mostly protected, with one fallback gap when subscription linkage is unavailable.
- Checkout return flow currently lacks webhook-lag polling and can show stale plan briefly.
- Partial refunds are explicitly non-downgrading by design in current handler.
