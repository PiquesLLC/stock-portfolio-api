# Nala — Progress & Your TODO (as of 2026-06-12)

Running handoff: what's done, and the specific things **only you** can do to unblock the next round. Pick any item when you have time, tell Claude, and it executes.

## ✅ Done & shipped this session (live on `master` / nalaai.com)
- **P0 live-harm fixes:** citation-URL XSS (all render paths + server-side filter), public share-card DoS (IP rate-limit + CDN cache), `/ask` AI-cost cap, bio ReDoS.
- **Accounting:** fee-split unified (exact 80/20), F1 refund-after-dispute-won netting bug, sock-puppet self-deal block (shared email / Stripe customer).
- **Auth & security:** MFA-login JWT claims, admin-reports timing-safe compare, JWT alg-pin + weak-secret boot warning, `[AuthRuntime]` PII log gated behind `AUTH_DEBUG`, MFA step-up window 30m→5m.
- **Scale:** snapshot scheduler batched + quote-cache pre-warmed (the ~5–10k-DAU lever).
- **Regression tests locked in:** creator billing (disputes/refunds/F1/fee-split), `getPortfolio` valuation (incl. options ×100 + never-zero-price guard), snapshot `dailyPL` + 25%-drop breaker, dividend credit + no-double-credit, DRIP reinvest + no-double-reinvest.
- **Docs:** `docs/AUDIT.md` (full audit + roadmap), `docs/CENTS-MIGRATION.md` (Float→cents design), `src/utils/money.ts` (cents helpers).

## 📋 What's left for YOU (each unblocks a big lever)

1. **Off-site backup — highest leverage, ~5 min.**
   Create a Cloudflare R2 bucket + API token (or any S3 bucket + creds). Give Claude the bucket name + token via the `!` prefix so it isn't pasted into chat.
   → Unblocks: catastrophe insurance for the prod SQLite money data, **and** the final (irreversible) stage of the cents migration. Claude will not run the destructive end of that migration until a backup exists.

2. **Postgres re-platform — greenlight a multi-session project.**
   Just say "start Postgres."
   → Unblocks: removes the Float-money risk **and** the single-process scaling wall in one move. It's also the right home for the cents migration (done once, not twice).

3. **Cents migration — gated on #1 (and ideally #2).**
   Nothing to do yet; it rides on the backup + Postgres. Design is in `docs/CENTS-MIGRATION.md`.

4. **OAuth email-squatting fix — ✅ DONE (shipped autonomously).**
   Adopt approach: a verified OAuth sign-in to an email an *unverified* account is squatting now takes over that account and revokes every prior access vector (password, refresh tokens, MFA methods + challenges, the other-provider login, Stripe-customer link). A blind review caught and fixed a cross-provider-takeover edge before ship; covered by tests.
   → **Carryover still to handle when you enable creator payouts:** a squatter's `Creator` profile / `stripeConnectId` is not cleared on adopt (monetization-gated, so inert today). Wipe or force re-onboard as part of turning payouts on.

5. **Apple-IAP verification — provide a dependency.**
   Confirm using the official `app-store-server-library`, get Claude Apple's root CA certs (Apple PKI), and sandbox access to test.
   → Unblocks: fixes broken StoreKit2 receipt verification (entitlement leak) — only matters once billing is on.

## 🔒 Standing rule
Monetization (creator payouts / billing) stays **OFF** until the P1 money-safety items land. Do not flip it before then.

## 🤖 What Claude keeps doing meanwhile (no input needed)
Extending regression coverage into the non-money paths (charts, leaderboard, nala-score) and other safe, self-contained hardening.

---

## 2026-06-07 session — shipped, staged, and your TODO

### ✅ Shipped this session (in the local working tree — needs your commit + deploy)
- **Citation/AI/news XSS hardening** — `^https?://` scheme guards added to 5 unguarded anchor sinks: `IntelligenceTab.tsx` (×2), `StockQAPanel.tsx`, `TaxHarvest.tsx`, `StockPriceChart.tsx` (corrects the earlier "closed across all paths" overstatement).
- **DRIP lost-update race fix** — `drip.service.ts` re-reads the holding inside the transaction and uses atomic `shares: { increment }`.
- **Repo hygiene** — `.gitignore` + `.railwayignore` now exclude root `dev.db`, the stray `0`, `axon_*.json`, `portfolio_smoke.json`, `prisma/ci-smoke.db`, `prisma/backups/`, snapshots, and launch/QA memos.
- All changes reviewed by a blind Opus reviewer — **MUST-FIX: none.**

### 🔧 To ship it (you run these — Claude can't use the shell in this environment)
1. UI: `cd stock-portfolio-ui` → `npm run build` → `npm test` → commit + push `master`.
2. API: `cd stock-portfolio-api` → `npm run build` → `npm test` → commit + push `master` (Railway auto-deploys). **UI master before API master** per deploy choreography.
3. Git hygiene (untrack now-ignored files if any are tracked): `git rm --cached 0 axon_yahoo.json axon_ytd.json portfolio_smoke.json prisma/ci-smoke.db` then commit.

### 🧪 Staged — NOT shipped (need a migration / device / coordinated FE; do deliberately)
- **OTP `purpose` column (Critical, LIVE) — ✅ IMPLEMENTED LOCALLY 2026-06-10, needs commit+deploy.** `EmailOtpCode.purpose` added (`email_verification|password_reset|mfa_setup|mfa_email`, constants in `src/types/auth.ts`); every create stamps it, every consumer filters it, reissue-supersede is purpose-scoped. Migration `20260610135312_otp_purpose` (table rebuild, retires pre-purpose unconsumed codes; applied + verified on local dev.db) + `scripts/start.sh` migrate-failure fallback extended (idempotent ALTER, rehearsed on scratch DB). 16 new tests in `src/__tests__/otp-purpose.test.ts`; full suite 869 passed. Blind-reviewed: SHIP. Note: two-step email change uses `PendingEmailChange` (own table) and never needed a purpose.
- **MFA step-up on sensitive routes (High).** Add `requireMfaAssurance` to change-password/username/email/delete-account — but first make the UI handle the `MFA_STEP_UP_REQUIRED` 403 and test with an MFA account (non-MFA users already pass through).
- **`isCapacitorRequest` tightening (High).** Require header AND `capacitor://localhost` origin — test on a real native build first (risk: locking out native auth).
- **Apple IAP x5c rewrite (Critical, gated).** Replace OIDC-key verification with `app-store-server-library` x5c chain validation + require bundleId.

### 🔴 Your action #1 (urgent): rotate the live secrets in `.env` and move it off OneDrive
Live `sk_live` Stripe key, JWT/MFA secrets, Resend, Railway token sit in a OneDrive-synced file. Rotate each provider + `railway logout/login`, then relocate `.env` to a non-synced path. (Rotating `JWT_SECRET` logs everyone out; rotating `MFA_ENCRYPTION_KEY` forces TOTP re-enroll — plan those two.)

---

## 2026-06-12 session — M4 CSP hardening shipped

### ✅ Shipped (UI + API master)
- **M4: `'unsafe-inline'` removed from script-src** in both the helmet header (api `src/app.ts`) and the UI meta CSP (`index.html`). Replaced with a 5-hash sha256 allowlist: theme snippet (LF+CRLF), `GET /invite` route bridge (single-line, 1 hash), static `public/invite/index.html` bridge (LF+CRLF). Every hash verified against actual bytes: source, built dist, api/client/dist, live responses incl. the OG-injected crawler variant and the `/invite` 301→`/invite/` chain. `style-src` keeps `'unsafe-inline'` (unchanged).
- **Dev-breakage found & fixed:** Vite's react plugin injects the fast-refresh preamble as an inline script at serve time — hash-only meta CSP bricked dev. Added a serve-only `dev-csp-relax` plugin in `vite.config.ts`: strips the hashes and adds `'unsafe-inline'` (CSP ignores `'unsafe-inline'` while any hash is listed, so stripping is required). Build output verified strict; `apply: 'serve'` keeps it out of `vite build`/preview/vitest.
- **OG injection `$`-pattern bug fixed** (blind-review finding): `injectMetaTags` used a bare string replacement with user-derived `ogTags` — `` $` ``/`$&` could duplicate document chunks for crawler requests. Now a replacer fn.
- **Review:** blind reviewer → SHIP, no MUST-FIX; both post-review patches re-confirmed; relax regex hardened with `(?!-)` against future `script-src-elem/-attr` directives.
- **Billionaire feature was DEAD on prod since 2026-03-20 — found & fixed.** `scripts/seed-billionaires.js` (runs every boot, sole creator of Billionaire rows; the 60s refresh only updates existing rows) hardcoded `prisma/dev.db` and ignored `DATABASE_URL` → on prod it seeded a nonexistent ephemeral file every boot ("Seed failed: no such table" in every boot log) and the real `/data/nala.db` table stayed empty. Fix mirrors `resolveDbUrl()` from `src/utils/prisma.ts` (schema-relative `file:./` normalization; prod's absolute path passes through). Verified in all three env modes locally; prod seeds ~25 rows on next boot, refresh job maintains them thereafter.

### ⚠️ Carryovers / standing notes from review
- **Capacitor legacy-WebView floor:** on Android WebViews lacking `DOCUMENT_START_SCRIPT` (pre-Chromium-89, ~pre-2021), Capacitor falls back to injecting its bridge as an inline script → blocked by the strict meta CSP → dead shell on those devices. Decide (accept floor vs. Capacitor-specific index.html) when native app builds resume.
- **Cloudflare:** do NOT enable Rocket Loader or any HTML-mutating edge feature — it would rewrite inline scripts and invalidate the hashes.
- **helmet `frameSrc` (plaid only) intentionally differs from meta frame-src (plaid+google+apple):** both auth flows are popups, not iframes. Sync deliberately if that ever changes.
- **Test debt (pre-existing, not from this change):** UI suite has 5 failing tests on clean master (`config`, `HoldingsTable`, `NotificationBell` ×2, `StockDetailView`); API suite is load-flaky under parallel workers (billing/chart/profile-visibility files fail in full runs, pass in isolation — likely SQLite contention). Next session candidate: fix both.
- `public/mockup/daily-brief.html` left untracked on purpose (local design mockup; its inline script would be CSP-blocked if ever shipped — convert before promoting).
### ✅ QA pass — 4 user-facing bugs fixed (Playwright, browser-verified, blind-reviewed SHIP)
Drove the real app (frozen master build → live local API) at 390/768/1440 viewports, dark+light, ~26 scenarios. Full report: `C:\dev\nala\qa\BUGS.md`.
- **BUG-001 (HIGH) — CORS rejected the API's own origin → 500 on every asset → white screen.** The origin callback `throw`-ed for any non-allowlisted origin; browsers send `Origin` on crossorigin module-script/CSS fetches, so when the API serves its own client a self-origin miss 500'd the whole bundle. Prod survives only because `nalaai.com` is allowlisted — one env typo from a sitewide white screen. Fix (`src/app.ts`): a wrapper allows when `Origin` host === own `Host` (same-origin), else delegates to cors() which now SOFT-denies (`callback(null,false)`, no ACAO) instead of throwing. CSRF origin-check downstream is untouched.
- **BUG-003 (MED-HIGH) — unknown tickers 500'd then sat in skeleton-limbo.** Now `TickerNotFoundError` → 404, but ONLY for a search-CONFIRMED-unknown symbol: a null quote triggers a `searchTickers` lookup and 404s only when the search completed cleanly (`!meta.partial`) with no exact symbol match; a failed/partial search or an exact match → retryable 500 (a real ticker during a Polygon+Finnhub outage must not stick as "not found" — caught in review). UI renders a proper "Stock not found" state. 4 regression tests in `market.service.test.ts`.
- **BUG-004 (MED)** — Enter in ticker search now selects the top result.
- **BUG-005 (MED)** — empty-portfolio Insights no longer shows fabricated stats; tiles gate to '—'.
- **BUG-002 (HIGH, money display) — ✅ FIXED (blind-reviewed SHIP).** Day P&L on a position opened *today* now anchors at cost basis instead of previousClose (the holder didn't own it at yesterday's close), so a position only ever up no longer shows a red "today" loss. Shared helper `isOpenedTodayET` (ET calendar-day, DST-safe, invalid-date guard) in `utils/market-hours.ts`; applied at all FOUR owned-position day-P&L sites — `getPortfolio`, `getUserPortfolio` (profile twin — the blind review caught this one was missed, and that it was racing the snapshot writer to poison persisted `dailyPL`), leaderboard 1D, snapshot leaderboard-refresh. Falls back to previousClose when cost basis is 0/unusable. All pass-through surfaces (movers, attribution, benchmark, charts, share cards) inherit it. Known bounded limitation: adding shares intraday to a position opened on a prior day stays previousClose-anchored (Holding.createdAt is row-level; per-lot would need the trade ledger). +10 regression tests. Verified live: today-opened AAPL @290 on a -1.39% day shows TODAY +$3.04 (= total), was -$8.
- **BUG-006/007/008 — ✅ FIXED (blind-reviewed SHIP, browser-verified both directions; UI commit e4813be, shipped via API redeploy acb9901).** 006: ticker-tape no longer renders a visible duplicate when content fits (ResizeObserver-measured, only duplicates+animates on overflow). 007: "no baseline" copy drops "Add holdings" when holdings exist. 008: `/health/status` now gated on auth (no logged-out 401s); premium endpoints (ai-events/nala-score/auto daily-brief) skip when plan is KNOWN-insufficient via new `utils/plan.ts` (unknown plan still fires — a paying user is never denied; verified premium still gets them). The `/auth/me`×3 + `/auth/refresh` boot 401s left as-is (cookie-auth-inherent + dev StrictMode; skipping on a missing localStorage hint would risk logging out cookie-valid users). Only design observations A–G in BUGS.md remain (not defects; e.g. indices bar labels SPY/QQQ/DIA ETF prices as index levels).

- **Boot-log noise decoded (don't re-investigate):** the `Error: P3008` lines on every prod boot are the `prisma migrate resolve --applied <old-migration>` list in `scripts/start.sh` re-running idempotently (`|| true`) — expected and harmless. The `Seed failed: no such table: main.Billionaire` line is the bug fixed above and disappears after this deploy.
- **API suite flakiness FIXED (proven root cause — not SQLite):** 8 supertest suites lazy-`import('../app')` in their first test; under parallel vitest forks the ~2.5s cold import of the full app graph exceeds the default 5s testTimeout on this Defender/OneDrive-taxed disk → first test of losing files times out, failure set shifts. Fix: `vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })` in `src/__tests__/setup.ts`. 3 consecutive full runs green (891 passed / 19 skipped), wall-clock unchanged. Optional follow-up: move to `vitest.config.ts` for discoverability. ⚠️ Latent hazard noted, not changed: `NALA_ENV_FILE` loads the real env (live Stripe keys) into TEST processes (dotenv no-override keeps test vars winning) — consider a test-mode guard.
