# Nala — Progress & Your TODO (as of 2026-06-07)

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

4. **OAuth email-squatting fix — one product decision.**
   Decide adopt-vs-delete when a real owner signs in via OAuth to an email that an unverified account is squatting, and accept that Claude will also revoke that account's sessions/MFA (unverified accounts can hold them). Say e.g. "do the OAuth-squatting fix, adopt approach."
   → Unblocks: closes a denial-of-signup hole. Needs care + tests (Claude will write them) — that's why it isn't blind-shipped.

5. **Apple-IAP verification — provide a dependency.**
   Confirm using the official `app-store-server-library`, get Claude Apple's root CA certs (Apple PKI), and sandbox access to test.
   → Unblocks: fixes broken StoreKit2 receipt verification (entitlement leak) — only matters once billing is on.

## 🔒 Standing rule
Monetization (creator payouts / billing) stays **OFF** until the P1 money-safety items land. Do not flip it before then.

## 🤖 What Claude keeps doing meanwhile (no input needed)
Extending regression coverage into the non-money paths (charts, leaderboard, nala-score) and other safe, self-contained hardening.
