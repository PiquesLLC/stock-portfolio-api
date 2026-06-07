# Nala — Security, Money-Path & Scalability Audit + Remediation Status

_Last updated: 2026-06-06. Scope: `stock-portfolio-api` (Express/TS/Prisma) + `stock-portfolio-ui` (React/Vite/Capacitor)._
_Method: multi-agent due-diligence review (10 specialist passes) + first-hand verification of every Critical/High finding, followed by remediation shipped + verified in the same session._

---

## Verdict

A genuinely competent, security-aware build with a **bank-grade v2 double-entry ledger** and **strong auth**. Two structural elephants remain: **(1)** the *live* product still stores money as `Float` in **SQLite on a single volume**, and **(2)** it's a **single-process monolith** that walls out around ~5–10k DAU. The creator-economy money path has real fraud/accounting gaps that are **correctly kill-switched off today** — they are *do-not-launch-until-fixed* blockers, not active losses.

**Operating decision (in force):** monetization stays **OFF** until the money-safety work below lands. Lead with the **AI-portfolio wedge**; keep the creator marketplace dark until ~25 hand-recruited lighthouse creators.

---

## ✅ Remediated & shipped this session

All live + verified in production (Railway auto-deploys `master`); each was dual-reviewed and test/smoke-checked before shipping.

| Area | Fix | Commit(s) |
|---|---|---|
| **XSS (High)** | AI/deep-research citation URLs were rendered as raw `href` → prompt-injected `javascript:` = clickable XSS. Closed across **all** render paths (report view, PDF export, NalaAIPage, EventFeed) + server-side `validateCitationUrl` filter (streaming + poller). | UI `fb86145`, API `9f7228a` |
| **Availability/cost DoS (Critical)** | Public share-card endpoints were unauth + uncached + CPU-bound (`sharp`) → $0-cost full-app DoS. Added IP rate-limiter + CDN caching (kept public — they're OG images). | API `9f7228a` |
| **AI cost weapon (High)** | `/market/stock/:ticker/ask` was on `mutationLimiter` (30/min) → ~$144/day/user Perplexity burn. Moved to `aiLimiter` (10/min). | API `9f7228a` |
| **Accounting — fee split (High)** | Creator 80/20 split computed 3 inconsistent ways (`floor` vs `round`, float). Unified on exact `Number((BigInt(x)*80n)/100n)` across writer, reconciler, admin. | API `1071140` |
| **Auth — MFA-login JWT (High)** | MFA-login token dropped `plan`/`emailVerified` claims → email-verification-gate bypass for ~15 min. Now carries full claims. | API `1071140` |
| **Auth — admin-reports (High)** | `/admin/reports` key compared with `!==` (timing oracle) + no array/empty guard. Now `crypto.timingSafeEqual` + byte-length + array guards. | API `1071140` |
| **Auth — JWT alg pin** | `jwt.verify` now pins `algorithms:['HS256']` (auth.service + rateLimiter). | API `1071140` |
| **Security — bio ReDoS** | `filterContent` ran on the full unbounded bio before slicing. Now caps length, filters only the stored ≤80-char slice. | API `da87db6` |
| **Perf — bundle** | `DailyReportModal` was eager (pulled `html-to-image` into the main chunk). Lazy-loaded via `React.lazy` + Suspense (551KB → 529.63KB; modal split out). | UI `5fda096` |
| **Scalability — snapshot scheduler (the lever)** | Per-user serial loop (each user a cold `fetchPrices`) → never finishes at scale. Now pre-warms the quote cache once (timeout-bounded) + runs the unchanged `createSnapshotIfNeeded` per user at bounded concurrency. Correctness identical by construction. | API `7f04896` |
| **Accounting — F1 refund netting (High)** | `charge.refunded` summed prior refund/clawback debits but **not** the dispute-won restores → earn→clawback→won→refund left the creator holding refunded money. Now mirrors `charge.dispute.created`'s NET pattern on both sides. TDD-proven (test failed on bug, passes on fix). | API `0382708` |
| **Auth — log PII + MFA step-up** | `[AuthRuntime]` per-login/refresh logs (origin/headers→Sentry) gated behind `AUTH_DEBUG`. MFA step-up assurance window tightened 30m→5m. | API `903bdc0` |
| **Ops — deploy fingerprint** | Added `[boot] commit=<sha>` startup log so API-only deploys are verifiable. | API `d2d0c10` |

---

## 🔴 Open — money-safety (P1: the gate to enabling monetization)

These are **gated by `creatorPayoutsEnabled=false` / `creatorMonetizationEnabled=false`**, so they cannot cause loss today. Each must be closed before flipping monetization on.

1. **Float money on SQLite (Critical, data integrity).** `Portfolio.cashBalance`, `Transaction.amount`, `LedgerEvent.amount`, `PortfolioSnapshot.totalValue` are `Float`; only the creator wallet is `Int` cents. → penny-drift forever + uncoverable corruption risk on a single Railway volume. **Needs:** migrate to `Int` minor-units (or Decimal) — a real schema migration + backfill.
2. **Sock-puppet self-subscribe (Critical, latent).** Only defense is `subscriberUserId === creatorUserId`. **Needs:** link accounts by Stripe `PaymentMethod.fingerprint` (stable across accounts) + email/IP/device; cap revenue per fingerprint; human-review first payout. (Real feature, not a one-line fix.)
3. **Chargeback arbitrage (Critical, latent).** 14-day reserve vs 120-day dispute window; **no `stripe.transfers.createReversal`**; `getPayoutBalanceFromLedger` clamps debt with `Math.max(0,…)`. **Needs:** a product decision on reserve length (or rolling reserve) + `transfer.createReversal` on dispute + negative-balance recovery.
4. **Apple IAP verification broken (High).** `apple-iap.service.ts` verifies StoreKit2 JWS against Sign-in-with-Apple **OIDC** keys, not the App Store x5c→Apple-Root-CA chain → it can never verify → refund/cancel signals drop (entitlement leak) once billing is on. **Needs:** the official `app-store-server-library` (or x5c validation) + Apple's root CA certs + sandbox testing.

---

## 🟠 Open — scalability / reliability (P2: re-platform before real volume)

- **Single-process monolith.** In-memory rate-limiters/caches/locks + ~38 `setInterval` crons + webhooks-in-request-handler + SQLite single-writer → boot refuses `>1` replica; ~5–10k DAU ceiling. **Path:** Postgres (also fixes the Float issue) → Redis (limiters/locks/auth-rotation) → dedicated worker service → webhook inbox/outbox queue (BullMQ). Order matters — Postgres first.
- **No off-site backups (Critical insurance gap).** Prod money lives on one SQLite volume with no PITR. **Needs:** ~5 min — Cloudflare R2 bucket + token, then wire nightly off-site dumps. _This is the cheapest catastrophe-insurance and the single highest-leverage off-platform task._

---

## 🟡 Open — security (deferred; each needs a migration / external dep / product call)

- **MFA per-purpose step-up.** Tighten-to-5m shipped as mitigation; the full fix (login-MFA must not count as step-up) needs a `MfaChallenge.purpose` column (migration).
- **OAuth email-squatting.** An unverified account squatting an email blocks the real owner's OAuth signup. Fix: *adopt* the unverified account on OAuth (OAuth proves ownership) rather than failing — code-only but needs care + testing.
- **JWT secret entropy check at startup** — deferred (a naive hard-exit could brick prod if the current secret is short; tie to secret rotation).
- **Signup email enumeration** — distinct 409s reveal registered emails; making the email path generic is a UX trade-off (product call).

---

## Minor hygiene (low value; noted for completeness)

`NodeCache maxKeys` (risky — throws on overflow; already mitigated by `aiLimiter`); dead-dep removal (`html2canvas`, `hls.js` — unused, not bundled); `getPortfolio` ticker-casing defense-in-depth; reconciler `:legacy_destination` exclusion (only affects the v1↔v2 recon, which is dark until v2 cutover).

---

## Prioritized roadmap

| Phase | Theme | Status |
|---|---|---|
| **P0 — stop active harm** | XSS, share-card DoS, `/ask` cost cap, auth-hardening | ✅ **done** |
| **P1 — make money safe to enable** | cents migration, self-deal linking, chargeback reversal + reserve, Apple-IAP fix | 🔴 open — **gate to monetization** |
| **P2 — re-platform for scale** | Postgres → Redis → worker → queue; off-site backups | 🟠 open (snapshot-scheduler lever ✅ done) |
| **P3 — growth** | free Plaid + free daily briefs, unauth viral Nala-Score share card, push cadence | not started |

**The one firm rule:** do **not** enable creator payouts until P1 lands. Use the free runway to prove the AI-wedge retention and recruit lighthouse creators.
