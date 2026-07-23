# Nala — Decision Integrity, Financial Safety & User Trust Audit

**Date:** 2026-07-20
**Scope:** `stock-portfolio-api` + `stock-portfolio-ui` (production branches as checked out locally)
**Method:** static source inspection of the actual codebase (controllers, services, routes, validators, prompts, UI components) by a 4-quadrant research swarm; the highest-severity findings were then re-verified first-hand at file:line. This is **not** a security/uptime/payment audit — those were done separately. The question here is narrower and sharper:

> Can Nala operate exactly as designed and still mislead users, encourage bad financial decisions, display manipulated performance, create regulatory exposure, or destroy trust — **without anyone hacking it?**

**Answer: Yes, in several material ways.** Evidence below. Confidence is marked per finding: **[CONFIRMED]** = read at file:line; **[LIKELY]** = strongly implied by architecture, needs one live check.

**Methodology note (honesty about one miss):** an internal blind review caught a false claim in an earlier draft — a "consent is never persisted" finding produced by grepping for a request-field name (`acceptedTerms`) and missing the actual persistence, which uses a separate `ConsentRecord` model keyed by `policyVersion`. That finding is retracted and corrected in A5. Absence-based claims (things asserted *not* to exist) carry the highest risk of this "absent token ≠ absent control" error, so every remaining absence-based [CONFIRMED] finding here (A3 report queues, A4 output filters, A6 validation, C10 delisting) was re-verified by reading for the positive control, not just the token — but a reader should still treat absence claims as the ones most worth a second live check.

A note on where the risk is **not**, because it sharpens the framing: the **main portfolio's** return %, TWR, day-change, and leaderboard % are recomputed **server-side** from snapshots and candle data — a client cannot POST a finished "my return is +40%" number for its own portfolio and have it ranked. That core is right, and it is the most important thing this class of app must get right.

But three narrower surfaces **do** turn unvalidated client input directly into displayed returns, and the server math everywhere trusts client-entered dollars: (a) `/settings/broker-lifetime` derives a displayed lifetime return from 100% user-typed deposits/withdrawals/value (`settings.service.ts:47-67,217-234`); (b) `/settings/ytd` stores client YTD figures verbatim (`:83-98`); (c) goal progress shows a client-supplied `currentValue` (`goals.service.ts:38,229`). And the inputs to the "good" server math — `averageCost`, `shares`, `cashBalance`, transaction `amount`/`date`, and even the `skipTransaction`/`skipActivity` flags that change *how* the server computes — are all client-controlled with no reality check. So the exploit surface is the **unverified inputs** feeding the math, the **AI output** with no deterministic backstop, and the **credibility labels** backed by nothing. That is where every confirmed finding sits.

---

## Remediation status (updated 2026-07-23 — ALL TRANCHES DEPLOYED)

**Tranche 1** — shipped and verified (tsc clean, full suite green, blind-reviewed):
- **A4 (partial) — AI output backstop wired inline.** A deterministic validator (`src/eval/financial-safety/enforce.ts` → `ai-output.validator.ts`) now fails closed on the two highest-risk surfaces: **Stock Q&A** (`perplexity-qa.service.ts`, strict `high` gate) and **Ask Nala** rationale/risks/strategy (`nala-research.service.ts`, `blocker` gate).
- **B2 — flagged entries no longer rank.** `leaderboard.controller.ts` excludes anti-cheat detections from the public ranking via a new `suspicious` flag that separates true anti-cheat (>300%/day, Sharpe>5) from benign composition-change flags; also closed a latent Sharpe-check bypass.

**Tranche 2** — shipped and verified (both repos tsc clean, leaderboard tests 8/8, blind-reviewed "ship it"; UI edits pending Jon's visual pass before push):
- **A1 — "Verified" badge removed as a false credibility claim.** Discover pill renamed to **"Ranked"** (`CreatorDiscoverSection.tsx`); the always-true verification checkmark removed from the leaderboard (`LeaderboardPage.tsx`). *(Follow-up nit: the driving API field is still named `isVerified` — cosmetic rename deferred.)*
- **A4 (Deep Research) — price targets removed from the schema.** `deep-research.service.ts` no longer requests "price implications" / "fair value range"; valuation is now explicitly qualitative with an explicit no-price-target rule. Structure unchanged; no consumer breaks.
- **B1 — import-banks-the-run-up hole closed.** `leaderboard.service.ts` now trips the composition guard on any holding whose server-set `createdAt` is inside the window (catches import / Plaid / `skipActivity=true`), scoped to non-1D windows so the legitimate 1D cost-basis anchor is preserved. Anti-gaming + precision tests added. The false "TWR eliminates deposits/withdrawals" leaderboard copy corrected.

**Tranche 3** — shipped and verified (tsc clean, full suite 1165 green, blind-reviewed):
- **A4 (complete) — daily-report prose now has the backstop.** `perplexity-daily-report.service.ts` runs every model-authored field (marketOverview, portfolioSummary, news-story bodies, watch-today items, position-move reasons, Q&A answers) through `enforceAiText`, failing closed to safe fallbacks. Precision fix: the guarantee rule no longer trips on "risk-free rate/asset" macro vocabulary. **All AI surfaces now have the inline backstop.**
- **B6 — demo backfill can no longer fabricate for real users.** `backfillDemoUserSnapshots` is scoped to an explicit demo-username allowlist and no-ops on an empty list.

**Tranche 4** — shipped and verified (tsc clean, full suite 1168 green, blind-reviewed):
- **A3 (core) — creator enforcement path built.** New admin routes (`admin.routes.ts`): read the report queue (`GET /admin/creator-reports`), suspend/reinstate a creator, resolve a report — all gated by `requireAuth`+`requireAdmin`. Suspension has real teeth: suspended creators are excluded from Discover (`creator.service.ts`), blocked from payouts + self-reactivation. **Follow-ups:** creator-specific appeals + subscriber warnings + an admin UI (routes are API-only today). Keep creator monetization OFF until this is exercised end-to-end.
- **A2 (bounds) — fat-finger cost-basis ceiling.** `addHoldingSchema` now bounds shares ≤1e9 / averageCost ≤1e7, matching the import path; cash balance similarly bounded. Ticker-relative plausibility remains unenforceable for self-reported data (real assurance = Plaid + labelling).
- **A5 (email/password) — signup age gate.** `signupSchema` requires a date of birth and rejects under-13 (`MIN_AGE_YEARS`, raise to 18 in one line if desired); DOB is validated then discarded (no schema migration). Both signup forms collect it. ~~**Gap:** the OAuth (Google/Apple) signup path does NOT go through `signupSchema`~~ **CLOSED 2026-07-23 by Tranche 5 (below).**

**Tranche 5 (2026-07-23)** — shipped and verified (both repos tsc clean, full suite 1197 green incl. 6 new contract tests, blind-reviewed):
- **A5 (OAuth) — post-OAuth date-of-birth age gate.** Brand-new Google/Apple sign-ins persist NOTHING at the callback: when no account matches (`findExistingOAuthUser`), the verified provider profile is returned in a purpose-scoped 10-minute JWT (`signOAuthSignupToken`) and the client shows a DOB sheet (`OAuthDobModal`). `POST /auth/oauth/complete` re-validates age (`ageFromDob`/`MIN_AGE_YEARS`), re-runs the waitlist gate, and only then runs the original `findOrCreateOAuthUser` (user + `ConsentRecord` + settings + alerts). Under-age → 403 with nothing persisted (COPPA-clean); an account materializing between steps → 409, never a session (a signup token can never become a login token). Existing-user flow byte-identical and test-locked (`native-auth-contract.test.ts`).
- **A6 — self-reported figures labeled.** "Self-reported" chip on True YTD Settings + "Self-reported basis" on the YTD Window Return (`Projections.tsx`); "· self-reported" on separately-tracked goal progress values (`GoalsPage.tsx`).

**Still open:** creator-enforcement follow-ups (appeals/subscriber-warnings/admin UI — routes are API-only; **keep creator monetization OFF until exercised end-to-end**); cosmetic `isVerified` field rename; the "raise age floor to 18?" product call (still 13 = ToS floor). **Everything above is deployed to prod as of 2026-07-23** (merges: API `9dcaeab`, UI `e9da225`).

---

## A. Confirmed Launch Blockers

Each could cause material financial harm, fraud, or regulatory exposure and is proven in code.

### A1 — "Verified" creator badge is backed by nothing verifiable [CONFIRMED]
- **Where:** `api/src/services/creator.service.ts:884` — `isVerified: lbEntry != null && !lbEntry.flagged`; rendered as a green "Verified" pill in `ui/src/components/CreatorDiscoverSection.tsx:459`. Every leaderboard row also hardcodes `verified: true` (`api/src/services/leaderboard.service.ts:354`).
- **What it means:** "Verified" means only *"this account has a leaderboard-cache row and did not trip an anti-cheat flag."* There is **no** identity check, KYC, brokerage verification, or performance audit behind it. `kycVerified` is hardcoded `false` in the profile payload (`social.controller.ts:291`) — the scaffolding exists and is never used.
- **Harm:** A user reasonably reads "Verified" as "vetted, credible, real returns." They subscribe (real money — see A3) or copy trades based on a credibility signal that certifies nothing.
- **Malicious intent required:** No — the label misleads even honest creators' followers.
- **Fix:** Rename to something truthful ("Ranked") until real verification exists; reserve "Verified" for identity- or brokerage-verified (Plaid) accounts; stop hardcoding `verified: true`.
- **Blocks:** creator rankings + monetization.

### A2 — Self-entered, unbounded data drives public credibility signals; "Verified" performance is verified math on unverifiable inputs [CONFIRMED]
- **Where:** cost basis validator `api/src/validators/portfolio.validators.ts:6` accepts `averageCost: z.number().positive()` — **any** positive number, no reality check. Screenshot importer bounds only to `[0, 1e7]` (`screenshot-vision.service.ts:147-148`). Holdings carry **no purchase date**. Win-rate/profit-factor/"Diamond Hands"/"high win rate" badges are computed purely from user-entered trades (`profile-stats.service.ts:105-137`).
- **What it means:** The server math is honest, but its inputs are asserted by the user. Enter a low cost basis → large "total return." Enter fabricated winning trades dated years back → "60%+ win rate" and green credential badges. Nothing cross-checks entered price against the security's real traded range on any date.
- **Harm:** Fabricated track records rank on the public leaderboard and Discover, indistinguishable from genuine ones. This is the engine of A5's creator-fraud playbooks.
- **Malicious intent required:** Yes for fabrication; No for honest-but-wrong data (mis-entered cost basis silently misstates return).
- **Fix:** Validate entered cost basis against a historical price band (the `checkCostBasisPlausible` validator shipped in E does exactly this); require a basis date; label manual vs brokerage-verified holdings distinctly; exclude unverified portfolios from ranking or badge them as self-reported.
- **Blocks:** creator rankings + leaderboard.

### A3 — Creators are monetized while suspension/enforcement cannot touch the credibility surface [CONFIRMED]
- **Where:** self-activation flips a creator to `active` with no human review (`creator.service.ts:953-997`); paid Stripe subscriptions ($1–$999.99, `creator.validators.ts:7`); `requireNotSuspended` gates only **posting** (`post.routes.ts:10,23`), and neither Discover nor Leaderboard filter on `user.suspended` (`creator.service.ts:779-807`, `leaderboard.service.ts:94-105`). Creator reports write a `creatorReport` row that **no admin route ever reads** (`creator.service.ts:652`; only reference elsewhere is account-deletion cleanup).
- **What it means:** A content-suspended user still self-activates, stays on the leaderboard/Discover with fabricated returns, and keeps taking subscriber money. Reporting a creator for "misleading" does literally nothing.
- **Harm:** Paying subscribers follow a creator the platform cannot demote, freeze, or remove for performance fraud; reports create a false sense that abuse is actioned.
- **Malicious intent required:** Yes.
- **Fix:** Build an enforcement path (suspend creator status, set `leaderboardEligible=false`, hide from Discover, freeze payouts, preserve evidence, appeals); read the report queue; gate creator routes + ranking on suspension.
- **Blocks:** creator monetization + rankings. (Note: `creatorMonetizationEnabled`/`creatorPayoutsEnabled` currently default **OFF** per `config/index.ts:197-201` — so this is a *pre-enablement* blocker, not a live leak. Do not flip those flags until enforcement exists.)

### A4 — AI has zero deterministic output guardrails; Deep Research is *designed* to emit price targets [CONFIRMED]
- **Where:** every AI surface's only post-processing is `sanitizeContent` (HTML/markdown strip) + citation-URL filter — nothing scans meaning. Prompt rules ("never recommend buying/selling," "never use prediction language") are unenforced. Worse, Deep Research's mandated JSON schema **requires** `"bullCase": "…specific catalysts and price implications"` and `"valuation": {…"fair value range"}` (`deep-research.service.ts:102,110`) in the same prompt that says "Do NOT recommend buying or selling," and brands the output "institutional-quality deep research… for retail investors," stored forever with no generation date. Stock Q&A (`perplexity-qa.service.ts:22`) has **no advice restriction at all** and its answer cache is **cross-user** (`qa:TICKER:question`, `:38`). Tax-harvest prompt role-plays "a tax planning advisor… whether now is a good time to harvest" (`tax-harvest.service.ts:223`).
- **What it means:** If the model emits "guaranteed," "you should buy," an exact price target, or leverage/all-in coaching, nothing stops it reaching the user. One surface is explicitly engineered to produce price targets and fair-value ranges.
- **Harm:** A user acts on a model-asserted price target or a confident guarantee presented as institutional research.
- **Malicious intent required:** No — foreseeable from ordinary prompts (red-team battery in E).
- **Fix:** Wire the deterministic `validateAiOutput` backstop (shipped in E) into every AI response path; remove "price implications"/"fair value range" from the Deep Research schema or hedge+attribute them and show an as-of date; add an advice-refusal + disclaimer instruction to the Q&A prompt; make the Q&A cache per-user or scope it to non-personalized content.
- **Blocks:** Deep Research + Stock Q&A specifically; other AI features can ship once the backstop is inline.

### A5 — No age/DOB gate on an investing-decision surface [CONFIRMED]
- **Correction (post-review, retraction):** An earlier draft of this finding claimed consent is never persisted and that OAuth skips it. That was **wrong** and is retracted. Consent **is** recorded server-side on both paths: a `ConsentRecord` table (userId, `policyVersion`, `consentedAt`, ipAddress, userAgent) at `schema.prisma:256-266`, written inside the email-signup transaction (`auth.service.ts:1084-1091`) **and** the Google/Apple transaction (`oauth.service.ts:220-227`), keyed to `CURRENT_POLICY_VERSION='1.0'` (`auth.service.ts:13`), cleaned up on account deletion (`auth.controller.ts:917`). The error came from grepping for the request-body field name `acceptedTerms` instead of the `policyVersion` write — the exact "absence of a token ≠ absence of the control" trap. (Other absence-based findings were re-verified after this; see the methodology note in the intro.)
- **Where (the real, residual gap):** the only age reference in the entire product is ToS prose "You must be at least 13 years old" (`PrivacyPolicyModal.tsx:173`); there is **no DOB field, no age gate, and no jurisdiction/eligibility gate** anywhere `[VERIFIED absent]`. Separately, the OAuth buttons don't re-check the affirmative Terms checkbox in the UI before launching the flow (`LandingPage.tsx:287-358` vs the email path at `:270`) — but the server still writes a `ConsentRecord`, so this is UI-consent *friction*, not a missing record.
- **What it means:** A 13-year-old — or a user in a restricted jurisdiction — can open an account and consume AI "insights," a Nala Score "grade," and social copy-trade cues on an investing-decision-adjacent product.
- **Harm:** Minors / ineligible users on an advice-adjacent financial surface; App Store financial-app norms typically expect an 18+ gate.
- **Malicious intent required:** No.
- **Fix:** Add a neutral DOB/age gate (raise the floor to 18 for advice-adjacent features) surfaced at signup; gate the OAuth buttons on the same Terms checkbox for consistency. (Consent persistence itself needs no work — it already exists.)
- **Blocks:** not core launch on its own, but cheap table-stakes compliance that should ship before scale.

### A6 — Three surfaces turn unvalidated client dollars directly into displayed returns [CONFIRMED]
- **Where:** `/settings/broker-lifetime` stores client-typed `deposits`/`withdrawals`/`currentValue` verbatim and displays a "lifetime return" computed from them (`settings.service.ts:47-67,217-234`); `/settings/ytd` stores client `ytdStartEquity`/`ytdNetContributions` verbatim for "True YTD" (`:83-98`); `goal.currentValue` is client-supplied and shown as portfolio value in goal progress (`goals.service.ts:38,229-230`). None is validated against the user's actual holdings/snapshots.
- **What it means:** Unlike the main portfolio (server-computed), these are user-asserted performance numbers shown with the same authority. A user can type any "broker lifetime" figures and the app renders the resulting return as fact — including on surfaces others may see.
- **Harm:** A displayed return that is pure fiction, indistinguishable from a computed one; if any of these feed a share card or profile, it becomes outward-facing fabrication.
- **Malicious intent required:** Yes to fabricate; No for honest-but-wrong entry.
- **Fix:** Reconcile these against server snapshots or clearly label them "self-reported, unverified"; never let a self-reported figure reach a public/shareable surface unlabeled.
- **Blocks:** the broker-lifetime/YTD/goals display features (not core launch), and any sharing built on them.

---

## B. High-Risk Likely Problems

Strongly implied; each needs one live verification.

### B1 — Leaderboard/creator ranking is labeled "TWR" but is not time-weighted, and its one guard is client-bypassable [CONFIRMED]
- **Where:** `leaderboard.service.ts:254-268` computes `returnPct = (liveValue − historicalValue) / historicalValue`, valuing **current** shares at historical candle prices — a point-to-point reconstruction, stored as `twrPct` (`:294`). Code comments themselves call this a known gaming vector (`:153-156`). The UI tells users: *"Rankings based on time-weighted returns (TWR)… TWR eliminates the effect of deposits/withdrawals for fair comparison"* (`ui/src/components/LeaderboardPage.tsx:210`). There is no sub-period chaining.
- **The guard is bypassable [CONFIRMED]:** the only defense against the "reconstruct a just-added position's past as your gains" bias is an `ActivityEvent` composition count (`:159-168,274-292`). But **imports never emit an `ActivityEvent`** (`portfolio.controller.ts:2233-2300`), Plaid sync doesn't either (`plaid-sync.service.ts:168-205`), and the client can pass `skipActivity=true` (`portfolio.controller.ts:149`). So the cleanest attack — **import an already-appreciated portfolio** — sails straight past the guard and the leaderboard credits the entire historical run-up as the user's performance.
- **Flow gaps compound it [CONFIRMED]:** `PUT /portfolio/cash` writes **no** compensating transaction (`portfolio.service.ts:241-267`), and "Simple Return" is never flow-adjusted (`settings.service.ts:168-169`) — so a cash bump inflates the displayed return directly. Holding add/remove/import *do* auto-write a market-value compensating flow (`compensating-cashflow.ts:27-50`) that `calculateTWR` nets out (`finance-math.ts:42-105`), but `skipTransaction=true` suppresses even that (`portfolio.controller.ts:179`).
- **Why it matters:** The fairness guarantee shown to users overstates the math, and the guard meant to enforce it is trivially evaded by the most natural onboarding path (import). This is the mechanism behind the #1 creator-fraud playbook.
- **Live check:** run the shipped `checkDepositNeutrality`/`naiveDivergesFromTwr` invariants (E) against the real snapshot→ranking pipeline for a seeded account that imports an appreciated position and bumps cash.
- **Fix:** implement real TWR (chain daily sub-period returns net of flows — reference implementation shipped in E) or correct the UI copy; make **every** position mutation (manual/import/Plaid) emit the same `ActivityEvent` + compensating flow; remove client control of `skipActivity`/`skipTransaction`; add a compensating flow to cash edits; gate ranking on verified longitudinal snapshots, not current-shares×historical-price.

### B2 — Flagged (suspicious) entries still rank [CONFIRMED]
- **Where:** `leaderboard.service.ts:326-359` — a >300%/day or Sharpe>5 series sets `flagged=true` but the entry is still `entries.push(...)` and sorted normally; the flag is never used to exclude. A believable fake (a real stock that genuinely rose, entered as a fabricated holding) trips no flag at all.
- **Harm:** Manipulated or absurd returns appear in public rankings with, at most, a soft flag the UI may not even surface.
- **Fix:** Exclude flagged entries from ranking (or quarantine to a reviewed queue); treat the flag as a gate, not a decoration.

### B3 — Spend breaker fails open on DB error [CONFIRMED code, LIKELY impact]
- **Where:** `api/src/utils/ai-spend-guard.ts:82` — the 24h $100 / 10k-call breaker returns "allowed" if its DB read throws.
- **Harm:** The only global AI backstop can silently disengage during a DB blip; combined with A4 (no output guard), an incident window has neither cost nor safety control.
- **Fix:** Fail closed (or to a low cap) on breaker read error; alert.

### B4 — "Real-time market data" marketing contradicts a deliberately masked ~15-min delay [CONFIRMED]
- **Where:** `ui/index.html:27` and `LandingPage.tsx` market "Real-time market data" / "institutional-grade"; ToS §7 disclaims "we do not guarantee the… timeliness… of this data" (`PrivacyPolicyModal.tsx:196`); the chart code bridges the "~15 min delayed" Yahoo feed with a synthetic live point (`PortfolioValueChart.tsx:397,427`) and never shows a "delayed" label; the stale indicator is desktop-only and never uses the word "delayed."
- **Harm:** Users act on prices they believe are live; the louder marketing surface promises what the buried legal surface disclaims.
- **Fix:** Reconcile the copy; surface a quote as-of/"delayed" label wherever a price drives a decision.

### B5 — Projection engine extrapolates short hot streaks into 10-year single-point wealth forecasts [CONFIRMED]
- **Where:** `projection.service.ts` — realized CAGR (capped at **1000%/yr**, `:173-179`) from lookbacks as short as **1 day** (`LOOKBACK_DAYS['1d']`) is monthly-compounded to 6m/1y/5y/10y "base" values. The 1000×-value clamp (`:83-86`) is itself an admission of how extreme outputs get.
- **Mitigation present:** the Projections UI does carry "Linear projection… Not a forecast. Past performance does not guarantee future results" (`Projections.tsx:497`) — good, but the number itself is a single flattering point with no distribution.
- **Fix:** Require a minimum history window (e.g. ≥90 days) before projecting; show a range, not a point; cap the annualized rate used for projection far below 1000%.

### B6 — A demo-seeding flag can fabricate ranked snapshots for real accounts [CONFIRMED code, conditional on env]
- **Where:** `snapshot.service.ts:1050-1145` — when `DEMO_LEADERBOARD=true` (`index.ts:628`), a random-walk snapshot generator runs for **all** `leaderboardEligible` users with fewer than 5 snapshots, not just the intended demo personas; those fabricated snapshots then rank with the hardcoded `verified:true`. Demo accounts also rank against real users (`demo-data.service.ts:9-53`).
- **Why it matters:** If that flag is ever true in production, real thin-history accounts get **fabricated** performance history injected and ranked as "verified." Even off, demo accounts co-mingle with real ones in rankings.
- **Live check:** confirm `DEMO_LEADERBOARD` is unset in the production environment and that demo users are excluded from public rankings.
- **Fix:** scope the generator to an explicit demo-user allowlist; never stamp fabricated snapshots `verified`; exclude demo accounts from public leaderboards.

---

## C. Trust & Accuracy Weaknesses

Not direct fraud, but they erode trust or mislead at the margin.

- **C1 — Two high-traffic AI surfaces render with no disclaimer and no AI label** [CONFIRMED]: Today's Brief AI prose ("Market Overview / Portfolio Analysis / Why Positions Moved," `DailyReportContent.tsx:554,567,580`) and Stock Q&A answers (`StockQAPanel.tsx:170-212`). "Why Positions Moved" renders AI causal claims as plain fact.
- **C2 — Model opinion styled as precise instrument** [CONFIRMED]: Ask Nala confidence score is a glowing animated gradient bar + bold number (`NalaStockCard.tsx:97-108`) with no methodology; Fear & Greed speedometer, risk radar `/10`, "Fair Value +X% upside" (`DCFCalculator.tsx:412`, `ValueRadar.tsx:407`), Nala Score "A+–F health grade." Derived opinions read as authoritative data.
- **C3 — "Smart Actions" issue directive trade cards with no disclaimer** [CONFIRMED]: `IntelligenceTab.tsx:828-855` renders "Trim {sector} → {target}%", "Take Profits — {ticker} up {pct}", "Set stop-loss on {ticker}" — the most advice-like surface in the app, with no "not financial advice."
- **C4 — Model-authored fundamentals shown identically to verified data** [CONFIRMED]: in Ask Nala, revenue growth, D/E, market cap, PEG, FCF yield are never reconciled to real data (only price/P/E/ROE/div/margin/beta are, per the F-A-20 overlay in `nala-research.service.ts:320-335`) yet render in the same clean grid.
- **C5 — Stale AI artifacts show no generation date** [CONFIRMED]: Deep Research (stored forever), daily-brief prose, Q&A answers. A report opened days later looks current.
- **C6 — Benchmark widget celebrates only outperformance** [CONFIRMED]: `BenchmarkWidget.tsx:147-149` + `index.css:294-299` — beating the S&P gets a brighter (0.2 vs 0.15 alpha) glow **and** a 3s pulse animation; trailing is static and dimmer. The public profile applies a green "profit-glow" to gains but nothing to losses (`UserProfileView.tsx:1332`).
- **C7 — Loss framing softened; "Diamond Hands" rewards holding through drawdown** [CONFIRMED]: taglines never state a loss (worst case "Rebuilding," `UserProfileView.tsx:176`); the 💎 badge is awarded for `maxDrawdown > 15% && return > 0` (`:240`) — positively reinforcing not-selling through a >15% drop.
- **C8 — Share cards broadcast P/L over a caller-selectable period with no disclaimer** [CONFIRMED]: `share-card.service.ts` performance card renders portfolio $ value + return; period is user-supplied (`?period=`, cherry-pickable); no "past performance" caveat on the image.
- **C9 — "thousands of investors sharing real performance"** is hardcoded, unsubstantiated social proof [CONFIRMED]: `PublicProfilePage.tsx:131-133`.
- **C10 — No delisting/stale-price handling in the portfolio-value path** [CONFIRMED as absent]: a direct search for a delist/dead/frozen/age dead-cache in the market/quote services found none; a stale last price flows into portfolio value at face value, guarded only by crude $0/>25%-daily-drop snapshot filters (`snapshot.service.ts:127-156`). A delisted or long-halted holding can keep contributing its last price to current value and returns as though live. **Corporate actions** are likewise only partially handled: splits/mergers/DRIP are adjusted only in imported-trade replay at book value (`replay.service.ts:224-256`), with no live adjustment, and cash dividends are ledger-replayed but not auto-credited to live cash or included in total P/L.

---

## D. Missing Controls

Protections that do not exist and should before meaningful scale.

1. **Deterministic AI-output safety filter** inline in the response path (shipped in E; not yet wired).
2. **Cost-basis / holdings reality validation** against historical price bands (validator shipped in E; not yet wired).
3. **Creator enforcement system** — suspend/demote/freeze/evidence/appeals; a read surface for the existing report queues.
4. **Anti-gaming for rankings** — dedupe by device/payment identity; min account age / value / tracked days eligibility; exclude flagged; self-subscription fingerprinting (code comment at `creator-billing.service.ts:226-245` admits a separate email+card bypasses the self-deal check).
5. **Age/DOB + jurisdiction gate**, and OAuth affirmative-consent UI parity. (Consent + policy-version persistence already exists — `ConsentRecord`, both paths — so it is *not* a missing control; this was corrected after review.)
6. **Freshness/as-of standard** — every AI artifact and price-driven decision surface stamps a source + as-of time; the AI is told "today's date" and must decline when no fresh data is available (several prompts have no date anchor).
7. **Suitability/crisis handling** — no concentration/all-in refusal, no leverage guardrail, no emotional-distress handling anywhere in prompts or code.
8. **Post-hoc immutability for trade claims** — trade-attachment posts store unverified client JSON (`post.validators.ts:8-15`) never linked to holdings; soft-delete leaves no tombstone (`post.service.ts:128-133`) → post a prediction, delete if wrong.

---

## E. Automated Tests Added

A permanent **Financial-Safety Evaluation Framework** was built and is passing (39/39 offline tests, no API keys/DB required). Location: `api/src/eval/financial-safety/` + `api/src/__tests__/financial-safety.test.ts`.

**Deterministic validators (deployable inline, not just tests):**
- `validators/ai-output.validator.ts` — scans generated text for 8 categories (guarantee, price_target, trade_imperative, leverage_encouragement, concentration_encouragement, fomo_pressure, unhedged_prediction, personalized_advice) with severity; precision-guarded (negation-, hedge-, and bidirectional-aware) so ordinary education passes. `isServableAiOutput()` is a drop-in gate for the AI response path.
- `validators/portfolio-invariants.validator.ts` — reference `timeWeightedReturn`, `naiveReturn`, `checkDepositNeutrality`, `checkWithdrawalNeutrality`, `naiveDivergesFromTwr`, `checkCostBasisPlausible`. Encodes "deposits/withdrawals are not performance" as executable properties and gives a correct TWR oracle to test the real pipeline (B1) against.

**Datasets:**
- `datasets/adversarial-prompts.ts` — 15 red-team scenarios (guarantee, exact price target, leverage, loss-chasing, emergency savings, all-in, copy-creator, rumor/MNPI, manipulation, false-premise, justify-a-decision, panic/crash, retirement advice, fake research, stale data), each tagging disallowed categories + vulnerability flags.
- `datasets/golden-questions.ts` — 6 normal educational Q&A that must pass clean (precision floor).
- `datasets/response-fixtures.ts` — labeled safe/unsafe output corpus so the suite runs offline; the regression sink for future production misses.

**Scoring + gate:** `scoring.ts` — per-case severity → single launch pass/fail; any `blocker` fails the gate.

**Runners:**
- Offline CI gate: `npm test` picks up `src/__tests__/financial-safety.test.ts` (39 tests: recall on unsafe corpus, precision on safe/golden, TWR invariants, cost-basis plausibility, launch-gate behavior, dataset integrity).
- Live opt-in: `src/eval/financial-safety/run-eval.ts` sends the adversarial corpus to the real provider, scores with the validator, exits non-zero on gate failure (pipeline-blocking).

**Not yet added (recommended next):** wire `validateAiOutput` into `nala-research`, `perplexity-qa`, `deep-research`, `perplexity-daily-report` response paths; wire `checkCostBasisPlausible` into `portfolio.validators`/import; a live snapshot-pipeline test asserting B1.

---

## The 10 most dangerous ways Nala can mislead a user without being hacked

1. A fabricated or cherry-picked creator track record ranks publicly as **"Verified"** with real returns (A1+A2).
2. Deep Research hands a retail user a **price target / "fair value range"** as "institutional-quality" analysis, stored undated (A4).
3. Stock Q&A (no advice guard) answers "should I buy at this level?" with a confident, un-disclaimed, possibly stale reply — and re-serves it cross-user (A4).
4. The leaderboard promises **"TWR that eliminates deposits/withdrawals"** while ranking on a non-time-weighted number (B1).
5. A 1-week hot streak is extrapolated into a flattering **10-year wealth projection** (B5).
6. Model-authored fundamentals (revenue growth, D/E, PEG) render **identically to verified data** (C4).
7. "Smart Actions" tell the user to **Trim / Take Profits / Set stop-loss** with no disclaimer (C3).
8. Share cards broadcast a **cherry-picked-period** return with no caveat, read by peers as audited performance (C8).
9. A model **confidence score** is styled as a precise glowing instrument implying analytical rigor it doesn't have (C2).
10. Prices marketed as **"real-time"** are ~15 min delayed and the delay is deliberately hidden (B4).

## The 5 easiest ways a creator can fake credibility today

1. **Manufacture a track record on day one** — enter fabricated winning trades with any backdated date + any cost basis → "60%+ win rate," "Diamond Hands," green badges (A2; `profile-stats.service.ts:105-137`, `portfolio.validators.ts:6`).
2. **Import an already-appreciated portfolio to bank the historical run-up** — imports emit no `ActivityEvent`, so the composition guard never fires and the leaderboard credits the entire pre-import gain as your performance; the entry inherits the "Verified" pill (B1; `portfolio.controller.ts:2233-2300`, `leaderboard.service.ts:264-292`).
3. **Buy popularity** — default Discover sort is subscriber count; the self-deal check is bypassable with a separate email+card (A3; `creator-billing.service.ts:226-245`).
4. **Post prediction, delete if wrong** — silent soft-delete, no tombstone, trade claims never checked against holdings (D8).
5. **Charge for stub content** — enable one paywalled section that returns a canned string to satisfy the self-activation gate (`creator.service.ts:447-455`).

## Features that should remain disabled until fixed

- **Creator monetization + payouts** (`creatorMonetizationEnabled`/`creatorPayoutsEnabled`) — keep OFF until A1–A3 + anti-gaming (D3/D4) ship.
- **Public creator "Verified" label + Discover/leaderboard ranking of unverified portfolios** — until A1/A2/B2.
- **Deep Research** price-target/fair-value output — until the schema is de-targeted and the AI backstop is inline (A4).
- **Stock Q&A** — until it gets an advice-refusal prompt + inline validator + per-user cache (A4).

## 30-Day Remediation Plan

**Week 1 — Stop the bleeding (compliance + AI backstop):**
- Add an age/DOB gate + surface it at signup; gate OAuth buttons on the Terms checkbox (consent records already persist — A5).
- Wire `validateAiOutput` inline into all AI response paths; add advice-refusal + disclaimer to the Q&A prompt; make Q&A cache per-user (A4, C1).
- Fail the spend breaker closed (B3).

**Week 2 — Truth in labeling:**
- Remove/hedge Deep Research price targets + add generation dates to all AI artifacts (A4, C5).
- Fix the leaderboard "TWR" claim (implement real TWR or correct the copy) and exclude flagged entries (B1, B2).
- Reconcile "real-time" marketing + add delayed/as-of labels (B4).

**Week 3 — Creator integrity:**
- Cost-basis reality validation inline (A2); label manual vs Plaid-verified holdings.
- Build minimal creator enforcement: read report queues, suspend→demote→hide→freeze, evidence + appeals; gate ranking/Discover on suspension (A3).

**Week 4 — Anti-gaming + polish:**
- Ranking eligibility gates + device/payment dedupe + self-sub fingerprinting (D4).
- Symmetric gain/loss treatment (C6/C7); disclaimers on Smart Actions + share cards (C3/C8); fix "thousands of investors" (C9).
- Projection min-history + range (B5). Run the live safety eval as a release gate.

## Financial Decision-Integrity Launch Checklist

- [ ] No AI surface can emit guarantee/price-target/imperative/leverage/all-in text to a user (inline validator live; live eval green).
- [ ] Every AI artifact shows: AI label, generation date, source, and a disclaimer in-context (not just footer).
- [ ] No credibility label ("Verified," "top") is shown without evidence behind it; unverified portfolios are badged as self-reported or excluded from ranking.
- [ ] Displayed ranking metric matches its stated methodology (TWR claim ⇔ TWR math); flagged entries excluded.
- [ ] Cost basis / imported holdings validated against a real price band; manual vs brokerage-verified distinguished.
- [ ] Age/DOB gate enforced for advice-adjacent features (consent-with-policy-version already persists on every signup path — verified present).
- [ ] Creator monetization gated behind a working suspend/demote/freeze/appeal enforcement path.
- [ ] Prices that drive decisions show an as-of/delayed label; marketing copy matches legal disclosures.
- [ ] Projections require minimum history and show a range, not a single flattering point.
- [ ] Financial-safety eval (offline + live) is a required, non-bypassable release gate.

## Final Verdict

**Not safe to launch the social/creator and unconstrained-AI features as-is. Safe to launch only a restricted feature set.**

- **Ship now (with the Week-1 compliance + AI-backstop fixes):** personal portfolio tracking, the analytics/insights surfaces with disclaimers + AI labels, and the AI features **once the deterministic output validator is wired inline**.
- **Keep disabled until remediated:** creator monetization/payouts, the public "Verified" label and ranking of unverified portfolios, Deep Research price targets, and unguarded Stock Q&A.

The core accounting engine is more trustworthy than the surfaces built on top of it — the **main portfolio's** return is computed server-side and not accepted as a finished client number, which is the single most important thing this class of app can get right, and Nala's core gets it right. The danger is at the **edges and in the trust layer**: self-reported broker-lifetime/YTD/goal figures rendered as fact (A6), a leaderboard "TWR" whose one anti-gaming guard the natural import path bypasses (B1), unverified inputs wearing "Verified" badges (A1/A2), and AI opinion styled as fact with no backstop (A4). None of it requires a hack. All of it is fixable in roughly 30 days with the plan above; the eval framework in §E is built to keep it fixed.
