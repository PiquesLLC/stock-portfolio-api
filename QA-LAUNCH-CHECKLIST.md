# NALA — Beta Launch QA Checklist

> **Owner**: Lead QA / Lead Engineer
> **Date**: March 3, 2026
> **Scope**: Every user-facing service, data point, and interaction
> **Environment**: Production (`nalaai.com`) + Local dev (`localhost:5173`)

---

## How to Use This Document

- **P0** = Launch blocker. Must pass before any beta user touches the app.
- **P1** = Critical. Must pass within 24h of launch.
- **P2** = Important. Must pass within first week.
- Each section lists the **tab/page**, **what to verify**, and **expected behavior**.
- Test in **both dark mode and light mode** unless noted otherwise.
- Test on **desktop (1440px+)**, **tablet (768px)**, and **mobile (375px)**.

### Table Columns

| Column | Purpose |
|--------|---------|
| **#** | Test ID within subsection |
| **Test** | What to do |
| **Expected** | What should happen |
| **Owner** | Initials of the person who ran this test |
| **Result** | `PASS`, `FAIL`, `SKIP`, `BLOCKED` |
| **Evidence** | Link to screenshot, video, Railway log, or terminal output |
| **Date** | Date the test was last executed (YYYY-MM-DD) |

---

## EXIT CRITERIA — Go / No-Go Decision

The launch decision is binary. These criteria must ALL be met before opening beta access.

### Gate 1: P0 Pass Rate (Hard Gate)
- **100% of P0 tests PASS** — zero exceptions, zero waivers.
- Any P0 FAIL = launch is blocked until fixed and re-tested.

### Gate 2: P1 Pass Rate
- **>= 95% of P1 tests PASS** (i.e., at most 5% can be deferred).
- Any P1 FAIL must have a filed issue with severity, owner, and ETA.
- No P1 FAIL in auth, billing, or data integrity categories.

### Gate 3: Open Defects
- **0 open Critical or High severity defects.**
- Medium/Low defects are acceptable if documented in the Known Issues list.

### Gate 4: Known Issues Sign-Off
- A **Known Issues** list exists with:
  - Description, severity, affected users, workaround (if any), owner, ETA.
- The Known Issues list is **reviewed and signed off** by Jon before go-live.

### Gate 5: Infrastructure Readiness
- Railway deploy succeeds and `GET /health` returns 200.
- Sentry is receiving events (test error confirmed).
- BetterStack uptime monitor is green.
- No Finnhub 403 errors in Railway logs (all candles via Polygon).
- Stripe webhooks verified receiving events (check Stripe dashboard).
- Cache headers verified on `nalaai.com` (hard refresh loads latest JS).

### Gate 6: Rollback Plan
- Previous working deploy identified (Railway deployment ID noted).
- Rollback procedure documented: `railway rollback <deployment-id>`.
- Database migration rollback tested (or confirmed forward-compatible).
- DNS / CDN cache purge procedure documented if needed.

### Decision Record

| Field | Value |
|-------|-------|
| **Decision** | GO / NO-GO |
| **Date** | |
| **Decided by** | |
| **P0 pass rate** | __/__ (must be 100%) |
| **P1 pass rate** | __/__ (must be >= 95%) |
| **Open Critical/High** | __ (must be 0) |
| **Known Issues signed off** | YES / NO |
| **Rollback deployment ID** | |
| **Notes** | |

---

## 90-MINUTE LAUNCH SMOKE — Fast Subset Runbook

> **When to use**: Final go/no-go verification on production immediately before opening beta access.
> **Time budget**: 90 minutes. One person. One browser. Production only.
> **If ANY step fails**: STOP. Fix or rollback. Do not continue.

### Phase 1: Infrastructure (5 min)

| Step | Action | Pass Criteria | Result |
|------|--------|---------------|--------|
| S1 | `curl https://nalaai.com/health` | 200 OK, JSON response | |
| S2 | Open `https://nalaai.com` in browser | Landing page renders, no console errors | |
| S3 | Hard refresh (Ctrl+Shift+R) | New JS bundle loads (check Network tab, no 304 on index.html) | |
| S4 | Check Railway logs (`railway logs`) | No crash loops, no Finnhub 403s, Polygon fetching data | |

### Phase 2: Auth Critical Path (10 min)

| Step | Action | Pass Criteria | Result |
|------|--------|---------------|--------|
| S5 | Sign up with new test account (`smoketest_<timestamp>`) | Account created, lands on portfolio | |
| S6 | Logout | Cookies cleared, redirected to landing | |
| S7 | Login with new account | Authenticated, portfolio loads | |
| S8 | Login with wrong password | 401, no information leak | |
| S9 | Google OAuth sign-in (if configured) | Account created or linked | |
| S10 | Open DevTools → Application → Cookies | `authToken` is httpOnly, Secure, SameSite | |

### Phase 3: Portfolio Load & Calculations (15 min)

| Step | Action | Pass Criteria | Result |
|------|--------|---------------|--------|
| S11 | Login as `Piques` account | Portfolio loads with holdings | |
| S12 | Verify header: total value, day change $, day change % | Non-zero, plausible numbers | |
| S13 | Verify holdings table: at least 5 rows with price, change, equity | All columns populated | |
| S14 | Click a holding → stock detail view | Stock page loads with price, chart, stats | |
| S15 | Back to portfolio → switch chart to 1W | Chart renders with data points | |
| S16 | Switch chart to 1M, 3M, YTD | Each period renders, no blank chart | |
| S17 | Switch chart to 1D | Shows 4AM-8PM ET range, data present | |
| S18 | Verify cash balance display | Number shown (may be $0) | |
| S19 | Add a test holding (1 share of AAPL) | Holding appears in table, portfolio recalculates | |
| S20 | Delete the test holding | Removed, portfolio recalculates back | |

### Phase 4: Billing Gate (10 min)

| Step | Action | Pass Criteria | Result |
|------|--------|---------------|--------|
| S21 | Navigate to Pricing page | Free/Pro/Premium cards render with prices | |
| S22 | As free user: navigate to Insights → AI Briefing | PremiumOverlay shown, content blocked | |
| S23 | As free user: navigate to Nala AI (Deep Research) | PremiumOverlay shown, form blocked | |
| S24 | As premium user (`Piques`): navigate to AI Briefing | Briefing content loads | |
| S25 | `GET /billing/prices` via browser | Returns Stripe price IDs (not empty) | |
| S26 | Click Upgrade on pricing page (don't complete) | Stripe checkout page opens | |

### Phase 5: Core Features Spot Check (20 min)

| Step | Action | Pass Criteria | Result |
|------|--------|---------------|--------|
| S27 | Insights → Intelligence tab | Health score loads (0-100), no timeout | |
| S28 | Insights → Allocation tab | Donut chart renders with sectors | |
| S29 | Insights → Earnings tab | Upcoming earnings dates shown | |
| S30 | Discover → Heatmap (S&P 500) | Treemap renders with colored tiles | |
| S31 | Discover → Heatmap (Themes) | Theme categories with tickers | |
| S32 | Watchlists → create "Smoke Test" watchlist | Watchlist created | |
| S33 | Add TSLA to watchlist | Holding added, price shown | |
| S34 | Delete the watchlist | Removed | |
| S35 | Leaderboard tab | Rankings load with TWR%, switch 1D/1W/1M | |
| S36 | Macro tab | Economic indicators render with values | |
| S37 | Stock detail → Fundamentals section | P/E, EPS, revenue shown | |
| S38 | Stock detail → create price alert ($1 above current) | Alert saved | |
| S39 | Delete the price alert | Alert removed | |
| S40 | Notification bell → click | Event list opens (may be empty) | |

### Phase 6: Deep Research (15 min)

| Step | Action | Pass Criteria | Result |
|------|--------|---------------|--------|
| S41 | Nala AI → submit research: "Top 3 AI stocks for 2026" (sector type) | 202, job appears in list as Queued/Submitted | |
| S42 | Wait 30s, check status | Status progresses (Submitted → In Progress) | |
| S43 | Thinking feed shows entries | At least 1 thinking summary appears | |
| S44 | Wait for completion OR 5 min timeout | Job completes with report OR still in progress (acceptable) | |
| S45 | If completed: view report | Formatted text, cost telemetry shown | |
| S46 | If completed: test follow-up question | Response generated | |
| S47 | Submit 2nd job, immediately cancel | Job status → cancelled | |
| S48 | If job failed with empty result | Status = failed (NOT completed), error message shown | |

### Phase 7: Alerts & Notifications (5 min)

| Step | Action | Pass Criteria | Result |
|------|--------|---------------|--------|
| S49 | Settings → Notifications section | Alert toggles render | |
| S50 | Check notification bell unread count | Number matches actual unread events | |
| S51 | Mark all as read | Count goes to 0 | |

### Phase 8: Security & Edge Cases (5 min)

| Step | Action | Pass Criteria | Result |
|------|--------|---------------|--------|
| S52 | Open DevTools → Console | No CSP violations, no uncaught errors | |
| S53 | Clear cookies, hit `/portfolio` directly | Redirected to login/landing (not 500) | |
| S54 | Invalid API path: `GET /nonexistent` | 404 JSON (not HTML error page) | |
| S55 | Check response headers for HSTS | `strict-transport-security` present | |
| S56 | Check response headers for CSP | `content-security-policy` present | |

### Phase 9: Rollback Verification (5 min)

| Step | Action | Pass Criteria | Result |
|------|--------|---------------|--------|
| S57 | Note current Railway deployment ID | Recorded: `__________________` | |
| S58 | Verify `railway rollback` command syntax works (dry run) | Command recognized, shows available deployments | |
| S59 | Confirm database migrations are forward-compatible | No destructive migrations in current release | |

### Smoke Result

| Field | Value |
|-------|-------|
| **Tester** | |
| **Date** | |
| **Start time** | |
| **End time** | |
| **Total steps** | 59 |
| **Passed** | |
| **Failed** | |
| **Skipped** | |
| **SMOKE VERDICT** | PASS / FAIL |
| **Blocking failures** | (list step numbers) |
| **Notes** | |

---

## FULL TEST SUITE (Sections 1–27)

> Below is the exhaustive ~400-test suite. The 90-minute smoke above covers the critical path.
> Run the full suite within 48 hours of launch for complete coverage.

---

## SECTION 1: AUTHENTICATION & ACCOUNT LIFECYCLE

### 1.1 Signup (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | `POST /auth/signup` with valid username/email/password | 201, user created, JWT cookie set | |
| 2 | Signup with duplicate username | 409 conflict | |
| 3 | Signup with duplicate email | 409 conflict | |
| 4 | Signup with weak password (<8 chars) | 400 validation error | |
| 5 | `GET /auth/check-username/:username` availability | 200 with `{ available: true/false }` | |
| 6 | Rate limit: >3 signups in 15 min from same IP | 429 | |
| 7 | UI: Signup form validation (empty fields, password mismatch) | Inline error messages | |
| 8 | UI: Successful signup → redirects to portfolio | Portfolio tab loads | |
| 9 | Referral code applied at signup | Referral tracked in DB | |

### 1.2 Login (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Login with valid credentials | 200, JWT + refresh cookie set | |
| 2 | Login with wrong password | 401 | |
| 3 | Login with nonexistent username | 401 (same error, no enumeration) | |
| 4 | Rate limit: >5 login attempts in 15 min | 429 | |
| 5 | JWT expiry after 15 min → auto-refresh via refresh token | Seamless, no logout | |
| 6 | Refresh token rotation (old token invalidated) | Old refresh token returns 401 | |
| 7 | Login from two devices → independent sessions | Both stay logged in | |

### 1.3 OAuth (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Google Sign-In → new user | Account created, logged in | |
| 2 | Google Sign-In → existing email | Links to existing account | |
| 3 | Apple Sign-In → new user | Account created, logged in | |
| 4 | Apple Sign-In → existing email | Links to existing account | |
| 5 | OAuth with invalid/expired token | 401 | |

### 1.4 MFA (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | TOTP setup: scan QR → enter code | MFA enabled | |
| 2 | Login with TOTP enabled → prompted for code | Challenge screen shown | |
| 3 | TOTP verify with correct code | Login succeeds | |
| 4 | TOTP verify with wrong code | 401, attempts tracked | |
| 5 | Email OTP setup + verify | MFA method enabled | |
| 6 | Backup codes: generate, use one | Code consumed, login succeeds | |
| 7 | Backup codes: regenerate | Old codes invalidated | |
| 8 | Disable TOTP | MFA removed, login no longer prompts | |
| 9 | Rate limit: >10 MFA verify attempts in 15 min | 429 | |

### 1.5 Password Management (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Change password (with correct old password) | 200, new password works | |
| 2 | Change password with wrong old password | 401 | |
| 3 | Forgot password → OTP email sent | Email received | |
| 4 | Reset password with valid OTP | 200, new password works on login | |
| 5 | Reset password with expired/invalid OTP | 400 | |
| 6 | Rate limit: >3 forgot-password requests/hour | Silent success (no email sent) | |

### 1.6 Logout & Session (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Logout → cookies cleared | JWT + refresh token removed | |
| 2 | Logout → refresh token family revoked | Old refresh token fails | |
| 3 | Other sessions unaffected by logout | Still logged in on other device | |

### 1.7 Account Deletion (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Delete account with password confirmation | All data removed permanently | |
| 2 | Delete account revokes Plaid tokens | Plaid items removed | |
| 3 | Deleted user cannot log in | 401 | |

### 1.8 Email Verification (P1 — Awaiting Production Test)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | New signup → verification email sent | OTP email received via Resend | |
| 2 | Enter correct OTP | Email verified, AI endpoints unlocked | |
| 3 | Enter wrong OTP | 400, retry allowed | |
| 4 | Resend verification | New OTP sent | |
| 5 | Unverified user blocked from AI endpoints | 403 with verification prompt | |

---

## SECTION 2: PORTFOLIO — Main Dashboard

### 2.1 Portfolio Header & Value Display (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Total portfolio value displayed | Correct sum of holdings + cash | |
| 2 | Day change ($ and %) | Matches sum of individual day changes | |
| 3 | After-hours change (separate line) | Shows when market closed, extended hours | |
| 4 | Regular hours vs extended hours split | Both display correctly | |
| 5 | Total return since tracking start | Calculated from baseline | |
| 6 | Value updates on 60-second polling | New quotes reflected | |

### 2.2 Portfolio Chart (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | 1D chart: shows 4 AM – 8 PM ET range | Full extended hours visible | |
| 2 | 1D chart: pre-market data NOT filtered | Pre-market candles shown | |
| 3 | 1D chart: `previousCloseValue` as period start | Day change calculated from prev close | |
| 4 | 1D chart: weekend/holiday walk-back | Shows last trading day data | |
| 5 | 5D chart renders | 5 days of data, weekday filter applied | |
| 6 | 1W chart renders | 7 calendar days of data | |
| 7 | 1M chart renders | ~22 trading days | |
| 8 | 3M chart renders | ~66 trading days | |
| 9 | 6M chart renders | ~132 trading days | |
| 10 | YTD chart renders (from Jan 1) | Data from start of year | |
| 11 | 1Y chart renders | ~252 trading days | |
| 12 | ALL chart renders (full history) | All snapshots shown | |
| 13 | Non-1D charts: filter to weekday 4AM-8PM ET | No weekend data points | |
| 14 | Holiday detection (range < 0.1% of value) | Holiday gaps handled | |
| 15 | Chart hover: tooltip shows date + value | Correct date and dollar amount | |
| 16 | Chart: $ vs % toggle | Y-axis rescales correctly | |
| 17 | Chart: period buttons left-aligned with `gap-1` | Visual alignment correct | |
| 18 | `CHART_H=260` for portfolio chart | Correct height | |
| 19 | Offset normalization: last point matches live quote | No gap between chart and current value | |
| 20 | Composition change rebaseline on 1D only | Non-1D uses current holdings x historical prices | |

### 2.3 Holdings Table (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | All holdings listed with ticker + logo | Logos load, tickers correct | |
| 2 | Last price column | Current market price | |
| 3 | Day change ($ and %) per holding | Correct calculation | |
| 4 | Your equity (shares x price) | Correct | |
| 5 | Total return ($ and %) per holding | Based on cost basis | |
| 6 | Shares owned | Matches user input | |
| 7 | Average cost per share | Correct from cost basis | |
| 8 | Display metric toggle (6 options) | Each metric displays correctly | |
| 9 | Sort by: Name, Value, Day$, Day%, P/L$, P/L%, Price | Each sort works | |
| 10 | Compact vs detailed view | Toggle works | |
| 11 | Sparklines in detailed view | 30-day trend visible | |
| 12 | Earnings badge (days until) | Shows correct countdown | |
| 13 | Click holding → stock detail view | Navigation works | |
| 14 | Edit holding (shares/cost basis) | Updates saved | |
| 15 | Delete holding | Removed, portfolio recalculates | |
| 16 | Add holding button → modal | Modal opens with ticker search | |
| 17 | Free plan: max 25 holdings enforced | 26th holding blocked with upgrade prompt | |

### 2.4 Cash & Margin (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Cash balance display | Correct amount | |
| 2 | Set/update cash balance | Saves, portfolio recalculates | |
| 3 | Margin debt display | Shows debt amount | |
| 4 | Net equity = assets - margin | Correct calculation | |
| 5 | Cash interest accrual | Shows accrued amount based on rate | |

### 2.5 Performance Summary (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Unrealized P/L ($ and %) | Sum of all holdings P/L | |
| 2 | Holdings count | Correct number | |
| 3 | Since tracking: total invested | Correct from baseline | |
| 4 | Since tracking: current value | Matches header | |
| 5 | Since tracking: total gain/loss | Correct delta | |
| 6 | Days tracked count | Correct from activation date | |
| 7 | Broker lifetime P/L (when configured) | Displays external lifetime stats | |

### 2.6 Benchmark Widget (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | SPY return for selected period | Correct benchmark return | |
| 2 | QQQ return for selected period | Correct | |
| 3 | DIA return for selected period | Correct | |
| 4 | Portfolio vs benchmark delta | Correct difference shown | |

### 2.7 Portfolio Import (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | CSV upload (Robinhood format) | Parsed, preview shown | |
| 2 | CSV upload (Schwab format) | Parsed, preview shown | |
| 3 | CSV upload (generic/mapped format) | Parsed, preview shown | |
| 4 | Screenshot OCR import | Holdings extracted, preview shown | |
| 5 | Import confirm → holdings created | All positions added | |
| 6 | Import with duplicate tickers | Merged with existing holdings | |
| 7 | Invalid CSV format | Error message shown | |

### 2.8 Options Table (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Options positions display | Correct contracts shown | |
| 2 | Strike price, expiration | Correct data | |
| 3 | P/L calculation | Based on cost basis | |
| 4 | Greeks display (Delta, Gamma, Theta, Vega) | Values shown if available | |
| 5 | Options included in portfolio total | Total value includes options | |

---

## SECTION 3: INSIGHTS TAB (9 Subtabs)

### 3.1 Intelligence (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Portfolio health score (0-100) | Score renders with breakdown | |
| 2 | Diversification score | Reflects actual holdings spread | |
| 3 | Risk metrics | Volatility, beta, drawdown risk | |
| 4 | Concentration risk warnings | Flags >20% single holding | |
| 5 | Sector breakdown | Pie/chart with percentages | |
| 6 | Correlation heatmap | Color matrix of holding pairs | |
| 7 | Loads within 12 seconds | No timeout (Polygon candles) | |

### 3.2 Income Insights (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Annual dividend income projection | Based on current yield | |
| 2 | Income by holding | Sorted by dividend amount | |
| 3 | Historical dividend payments | Timeline visible | |
| 4 | Dividend yield vs market average | Comparison metric | |

### 3.3 Projections & Goals (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Create financial goal | Goal saved | |
| 2 | Goal progress tracking | Current % toward target | |
| 3 | Timeline projection | Expected completion date | |
| 4 | Edit/delete goal | CRUD works | |
| 5 | SP500-mode projection | Based on historical S&P returns | |
| 6 | Realized-mode projection | Based on user's actual returns | |
| 7 | Current pace (1d/1w/1m/ytd) | Annualized pace displayed | |

### 3.4 AI Briefing — PREMIUM (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Free user sees PremiumOverlay | Upgrade prompt shown | |
| 2 | Premium user: briefing loads | AI-generated text appears | |
| 3 | Briefing content relevant to holdings | Mentions user's stocks | |
| 4 | Explain button → follow-up Q&A | AI responds to question | |
| 5 | 30-minute cache | Second load is instant | |

### 3.5 AI Behavior Insights — PREMIUM (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Free user sees PremiumOverlay | Upgrade prompt | |
| 2 | Premium user: behavior analysis loads | Trading pattern insights shown | |
| 3 | Behavioral bias detection | Flags identified patterns | |
| 4 | 1-hour cache | Second load is instant | |

### 3.6 Allocation (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Donut chart by sector | Sectors with correct % | |
| 2 | Donut chart by asset type | Stocks, ETFs, etc. | |
| 3 | Bloomberg-style leader lines | Labels don't overlap | |
| 4 | Mobile touch scrubber | Tap/drag shows values | |
| 5 | Holdings weight list | Each holding's portfolio % | |

### 3.7 What-If Simulator (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Drag to change allocation | Projected returns update | |
| 2 | Risk metrics recalculation | Updated VaR/drawdown | |
| 3 | Save/compare scenarios | Scenarios persist in session | |

### 3.8 Earnings (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Earnings calendar for held stocks | Dates shown | |
| 2 | Days-to-earnings countdown | Correct countdown | |
| 3 | Expected vs actual EPS | Beat/miss indicators | |
| 4 | Historical earnings table | Past quarters shown | |

### 3.9 ETF Overlap (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Detect overlapping holdings in ETFs | Shows shared stocks | |
| 2 | Redundancy percentage | Correct overlap % | |
| 3 | Consolidation suggestions | Actionable recommendations | |

### 3.10 Tax Harvest — PREMIUM (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Tax-loss harvesting opportunities listed | Losing positions identified | |
| 2 | Wash-sale detection | Flags recent buys of same stock | |
| 3 | Projected tax savings | Dollar estimate shown | |

### 3.11 Anomaly Detection (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Anomaly events listed | Volume spikes, drawdowns detected | |
| 2 | Unread count badge | Correct count | |
| 3 | Mark as read | Count decrements | |

### 3.12 Daily Report — PREMIUM (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Daily report modal auto-popup | Shows once per day | |
| 2 | Report content accurate | Reflects today's moves | |
| 3 | Regenerate button | Fresh report generated | |

---

## SECTION 4: DISCOVER TAB (4 Subtabs)

### 4.1 Market Heatmap (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | S&P 500 heatmap renders | All sectors with correct colors | |
| 2 | Dow 30 heatmap | 30 stocks visible | |
| 3 | Nasdaq 100 heatmap | 100 stocks visible | |
| 4 | Themes heatmap (Finviz) | 40 themes, 268 subthemes | |
| 5 | Period selector: 1D, 1W, 1M | Data changes per period | |
| 6 | Color: green = up, red = down | Correct color coding | |
| 7 | Size: proportional to market cap | Larger stocks = larger tiles | |
| 8 | Click stock → stock detail view | Navigation works | |
| 9 | Heatmap preload (3s after boot) | Fast render on tab switch | |
| 10 | Mobile: tap-to-peek | Tooltip on touch | |
| 11 | Extended hours pricing in themes | After-hours data reflected | |

### 4.2 Top 100 Most Followed (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Ranking list loads | 100 stocks with follower counts | |
| 2 | Follow/unfollow button | Toggle works | |
| 3 | Performance metrics per stock | Price + change shown | |

### 4.3 Stock Screener (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Filter by market cap range | Results filtered correctly | |
| 2 | Filter by P/E ratio | Results filtered | |
| 3 | Filter by dividend yield | Results filtered | |
| 4 | Filter by 52-week position | Results filtered | |
| 5 | Sortable columns | Sort toggles work | |

### 4.4 Creators Discovery (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Creator profiles listed | Cards with performance + pricing | |
| 2 | Subscribe button | Checkout flow triggers | |

---

## SECTION 5: STOCK DETAIL VIEW

### 5.1 Stock Header (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Ticker + company name | Correct | |
| 2 | Logo loads | Image renders | |
| 3 | Current price (large) | Correct, updates live | |
| 4 | Price change ($ and %) | Color-coded green/red | |
| 5 | Open / previous close / high / low | All four metrics shown | |

### 5.2 Quick Stats (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Market cap | Correct, formatted (B/T) | |
| 2 | P/E ratio | Correct | |
| 3 | Dividend yield | Correct % | |
| 4 | 52-week high / low | Correct range | |
| 5 | Volume | Current day volume | |
| 6 | Average volume | 30-day average | |
| 7 | Beta | Correct value | |

### 5.3 Holding Info (if owned) (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Your shares count | Correct | |
| 2 | Average cost per share | Correct from cost basis | |
| 3 | Current value | Shares x price | |
| 4 | Unrealized P/L ($ and %) | Correct calculation | |

### 5.4 Stock Price Chart (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | 1D intraday chart | Candles/line for today | |
| 2 | Period selector (1D–ALL) | Each period loads data | |
| 3 | Hover tooltip (OHLCV) | Correct values | |
| 4 | `CHART_H=280` for stock chart | Correct height | |

### 5.5 Fundamentals Section (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | EPS (earnings per share) | Correct value | |
| 2 | Revenue | Correct, formatted | |
| 3 | Profit margin % | Correct | |
| 4 | ROE (return on equity) | Correct | |
| 5 | Debt-to-equity | Correct | |
| 6 | P/B ratio | Correct | |

### 5.6 Earnings Section (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Next earnings date | Correct date | |
| 2 | Expected vs actual EPS | Beat/miss shown | |
| 3 | Historical earnings table | Past quarters | |
| 4 | Earnings track chart | Visual trend | |

### 5.7 Dividends Section (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Annual dividend yield | Correct % | |
| 2 | Dividend per share | Correct amount | |
| 3 | Ex-dividend dates | Timeline shown | |
| 4 | Payment history | Past payments listed | |

### 5.8 Price Alerts (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Create alert (above target) | Alert saved | |
| 2 | Create alert (below target) | Alert saved | |
| 3 | Create alert (% up/down) | Alert saved | |
| 4 | Edit alert | Changes saved | |
| 5 | Delete alert | Alert removed | |
| 6 | Alert triggers when price crosses | Alert event created | |

### 5.9 ETF Details (if ETF) (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Expense ratio | Correct % | |
| 2 | Holdings count | Correct number | |
| 3 | Top 10 holdings breakdown | Tickers + weights | |
| 4 | Sector allocation | Pie chart | |

### 5.10 About Section (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Company description | Text loads | |
| 2 | Industry / sector | Correct classification | |
| 3 | Website link | Opens correctly | |

### 5.11 AI Q&A — PREMIUM (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Ask question about stock | AI response generated | |
| 2 | Response includes citations | Sourced information | |
| 3 | Follow-up questions work | Context maintained | |
| 4 | Free user sees upgrade prompt | PremiumOverlay shown | |

### 5.12 Nala Score — PRO (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Score renders (A+ to F) | Grade with breakdown | |
| 2 | Freshness indicator | Data age shown | |
| 3 | Free user sees upgrade prompt | PremiumOverlay shown | |

### 5.13 AI Events — PREMIUM (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Events timeline loads | Earnings, analyst, dividends | |
| 2 | Events overlaid on chart | Visual markers | |

---

## SECTION 6: WATCHLISTS TAB

### 6.1 Watchlist Management (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Create watchlist (name + color) | Watchlist created | |
| 2 | List all watchlists | Correct list | |
| 3 | Edit watchlist name/color/description | Changes saved | |
| 4 | Delete watchlist | Removed | |

### 6.2 Watchlist Holdings (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Add stock to watchlist | Holding added | |
| 2 | Set shares/cost for watchlist holding | Saved | |
| 3 | Remove from watchlist | Removed | |
| 4 | Holdings table: price, change, P/L | All metrics correct | |

### 6.3 Watchlist Chart (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Chart renders with period selector | All periods work | |
| 2 | Offset normalization | Last point matches live value | |
| 3 | `previousCloseValue` for 1D start | Correct day change | |
| 4 | `extendedPrice` for after-hours | After-hours reflected | |

---

## SECTION 7: NALA AI (Deep Research) TAB

### 7.1 Research Submission (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Select research type: Stock | Form shows ticker input | |
| 2 | Select research type: Portfolio | Uses portfolio context | |
| 3 | Select research type: Sector | Sector-focused prompt | |
| 4 | Select research type: Custom | Free-form prompt | |
| 5 | Submit job → 202 response | Job queued, shows in list | |
| 6 | Idempotency key (clientRequestId) | Duplicate blocked | |
| 7 | Monthly limit (5/month for Premium) | 6th request → 429 | |
| 8 | Concurrent limit (1 at a time) | 2nd concurrent → 429 | |
| 9 | Free user blocked | PremiumOverlay shown | |

### 7.2 Job Status & Polling (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Job list shows all user jobs | Correct list, paginated | |
| 2 | Status badges: Queued → In Progress → Completed | Correct transitions | |
| 3 | Thinking feed shows reasoning steps | Auto-scrolling feed | |
| 4 | ETA display during processing | Estimated time shown | |
| 5 | 15-second auto-polling | Status updates automatically | |
| 6 | Toast on job completion | Notification shown | |

### 7.3 Report View (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Completed job → report renders | Formatted markdown/structured | |
| 2 | Ticker links in report | Navigate to stock detail | |
| 3 | Cost telemetry: tokens, cost, search calls | All fields shown | |
| 4 | PDF download | Downloads formatted PDF | |
| 5 | Follow-up question → response | AI answers in context | |

### 7.4 Cancel (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Cancel active job | Status → cancelled | |
| 2 | Cancel already-completed job | 400 error | |

### 7.5 Error Cases (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Empty result from Gemini → marked failed | Status = failed, error message shown | |
| 2 | Job timeout (90 min) | Marked as failed | |
| 3 | Failed job → retry button | New job submitted | |

---

## SECTION 8: LEADERBOARD TAB

| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Leaderboard loads with rankings | Users sorted by TWR% | |
| 2 | Period selector: 1D, 1W, 1M, YTD, 1Y | Data changes per period | |
| 3 | Region filter: World, NA, Europe, APAC | Filtered correctly | |
| 4 | Columns: Rank, Name, TWR%, Dollar return, Assets | All display | |
| 5 | Click user → public profile | Navigation works | |
| 6 | Follow/unfollow from leaderboard | Toggle works | |
| 7 | 12-second polling during market hours | Data refreshes | |
| 8 | 60-second polling after hours | Slower refresh | |
| 9 | System user (`_system`) excluded | Not in rankings | |

---

## SECTION 9: DIVIDENDS

| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Dividend events listed | All upcoming/past events | |
| 2 | Upcoming payouts | Next payout dates + amounts | |
| 3 | Posted credits | Credits applied to holdings | |
| 4 | Credit timeline (post → reinvest) | Full lifecycle shown | |
| 5 | Manual reinvest | Shares added from dividend | |
| 6 | DRIP settings (enable/disable) | Toggle works | |
| 7 | Dividend summary (annual, YTD, monthly) | Correct totals | |
| 8 | Growth rates (1y, 3y, 5y) | Calculated correctly | |
| 9 | Manual sync trigger | New events fetched | |
| 10 | Backfill missed dividends | Missing credits posted | |
| 11 | iCal export | .ics file downloads | |

---

## SECTION 10: MACRO TAB (Economic Indicators)

| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Federal Funds Rate | Current value | |
| 2 | Treasury yields (2Y, 10Y, 30Y) | Correct rates | |
| 3 | CPI / inflation rate | Current reading | |
| 4 | Unemployment rate | Current reading | |
| 5 | GDP growth rate | Latest quarter | |
| 6 | VIX (volatility index) | Current level | |
| 7 | Sparkline trends per indicator | Historical trends | |
| 8 | International economic indicators | Global data shown | |
| 9 | Portfolio macro impact | How macro affects holdings | |

---

## SECTION 11: SOCIAL & FEED

### 11.1 Activity Feed (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Feed loads followed users' activity | Events shown | |
| 2 | Time grouping (Today, Yesterday, etc.) | Correct groups | |
| 3 | Threshold filter ($1k+, $5k+, $10k+) | Filters applied | |
| 4 | Click user → profile | Navigation works | |
| 5 | Click ticker → stock detail | Navigation works | |
| 6 | Mute user | User hidden from feed | |

### 11.2 User Profiles (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Public profile: display name, username, bio | All shown | |
| 2 | Portfolio value (if public) | Correct | |
| 3 | Returns % (if shared) | Correct TWR | |
| 4 | Followers/following counts | Correct | |
| 5 | Holdings (Top 5 / Sectors / Hidden) | Respects visibility setting | |
| 6 | Follow/unfollow button | Toggle works | |
| 7 | Compare portfolios | Side-by-side view | |
| 8 | Creator badge (if creator) | Shows correctly | |
| 9 | Report user | Report submitted | |

### 11.3 Stock Follow (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Follow stock | Added to followed list | |
| 2 | Unfollow stock | Removed | |
| 3 | Most followed stocks list | Ranked correctly | |
| 4 | My followed stocks | Correct list | |

---

## SECTION 12: ALERTS & NOTIFICATIONS

### 12.1 Notification Bell (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Bell shows unread count (5 types) | Correct aggregate count | |
| 2 | 30-second polling for new events | Updates automatically | |
| 3 | Sound toggle | Sound plays / mutes | |
| 4 | Day-grouped event list | Correct grouping | |
| 5 | Mark single as read | Count decrements | |
| 6 | Mark all as read | Count goes to 0 | |

### 12.2 Portfolio Alerts (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Drawdown alert triggers | Event created at threshold | |
| 2 | 52-week high alert | Triggers on new high | |
| 3 | 52-week low alert | Triggers on new low | |
| 4 | ATH/ATL alerts | Triggers on all-time levels | |
| 5 | Underperform SPY alert | Triggers on underperformance | |

### 12.3 Price Alerts (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Create price alert | Saved | |
| 2 | Alert triggers when crossed | Event created | |
| 3 | CRUD: create, read, update, delete | All operations work | |
| 4 | Unread count accurate | Correct badge number | |

### 12.4 Analyst Events (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Rating changes listed | Upgrade/downgrade events | |
| 2 | Price target changes | New targets shown | |
| 3 | Unread count | Correct | |
| 4 | Mark all read | Count resets | |

### 12.5 Milestones (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Portfolio milestone events | $10K, $50K, etc. | |
| 2 | 52-week high/low per holding | Correct triggers | |

---

## SECTION 13: SETTINGS PAGE

### 13.1 Profile Settings (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Edit display name | Saved, reflected everywhere | |
| 2 | Edit bio | Saved | |
| 3 | Public/private toggle | Privacy enforced on profile view | |
| 4 | Region selection | Saved, leaderboard filters work | |
| 5 | Holdings visibility: All / Top 5 / Sectors / Hidden | Public profile respects setting | |

### 13.2 Appearance (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Dark/light mode toggle | Theme switches globally | |
| 2 | Extended hours toggle | Chart shows/hides after-hours | |
| 3 | Starfield toggle | Background effect on/off | |
| 4 | Cash interest rate input | Accrual calculated correctly | |

### 13.3 Security (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Password change form | Works (tested above) | |
| 2 | MFA setup/disable | Works (tested above) | |
| 3 | Backup codes visible | Codes shown | |

### 13.4 Billing Settings (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Current plan displayed | Correct tier | |
| 2 | Upgrade buttons | Stripe checkout flow | |
| 3 | Manage subscription (portal) | Stripe portal opens | |
| 4 | Subscription renewal date | Correct date | |

### 13.5 Portfolio Data (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | CSV import from settings | Same as portfolio import | |
| 2 | Export portfolio | CSV downloads | |
| 3 | Wipe portfolio data | Confirmation → all cleared | |

### 13.6 Tracking Configuration (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Activate tracking | Baseline set | |
| 2 | Restart tracking | Baseline reset | |
| 3 | Set YTD start equity | YTD calculations use new baseline | |

---

## SECTION 14: BILLING & PRICING

### 14.1 Pricing Page (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Free/Pro/Premium cards render | All tiers shown | |
| 2 | Monthly/yearly toggle | Prices change | |
| 3 | Feature comparison table | Accurate per tier | |
| 4 | Current plan highlighted | Correct plan marked | |
| 5 | Upgrade button → Stripe checkout | Checkout session opens | |
| 6 | Annual savings badge | Correct % savings | |

### 14.2 Checkout Flow (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Stripe checkout → success redirect | `?checkout=success` → toast + plan refresh | |
| 2 | Stripe checkout → cancel redirect | `#tab=pricing` | |
| 3 | Webhook: `checkout.session.completed` | Plan upgraded in DB | |
| 4 | JWT refreshed after upgrade | New plan in token within seconds | |

### 14.3 Plan Enforcement (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Free user → AI briefing | 403 → PremiumOverlay | |
| 2 | Free user → deep research | 403 → PremiumOverlay | |
| 3 | Free user → Plaid link | 403 → PremiumOverlay | |
| 4 | Pro user → all premium features | Access granted | |
| 5 | Plan hierarchy: pro > premium > free | Correct ordering | |

### 14.4 Subscription Lifecycle (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Subscription updated (plan change) | DB updated via webhook | |
| 2 | Subscription deleted (cancel) | Downgraded to free | |
| 3 | Payment failed | Grace period banner shown | |
| 4 | Refund processed | Auto-downgrade to free | |
| 5 | Webhook idempotency | Duplicate event ignored | |

---

## SECTION 15: PLAID INTEGRATION

### 15.1 Brokerage Linking (P0 — Blocking Beta)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | `PLAID_ENABLED=true` in Railway | Feature active | |
| 2 | Link token creation | Plaid Link opens | |
| 3 | Token exchange → access token encrypted | AES-256-GCM stored | |
| 4 | Holdings sync from broker | Positions imported | |
| 5 | Re-sync holdings | Updated positions | |
| 6 | Disconnect account (MFA required) | Plaid token revoked, items removed | |
| 7 | Plaid webhook → item update | Sync triggered | |
| 8 | Pro plan required | Free users blocked | |
| 9 | Options support (OCC parsing) | Options imported correctly | |
| 10 | Sync transparency (skipped items) | Reasons shown for skips | |

---

## SECTION 16: CREATOR MONETIZATION

### 16.1 Creator Setup (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Apply to become creator | Application submitted | |
| 2 | Self-activate (if enabled) | Creator profile active | |
| 3 | Stripe Connect onboarding | Onboarding URL opens | |
| 4 | Visibility settings | Show/hide holdings, trades, etc. | |
| 5 | Pricing setup ($5 / $15 / $49) | Price saved | |

### 16.2 Creator Dashboard (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | MRR display | Correct monthly recurring | |
| 2 | Active subscribers count | Correct | |
| 3 | Earnings chart | Monthly trend | |
| 4 | Referral breakdown | Correct attribution | |

### 16.3 Creator Ledger (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Earning entries | Subscription payments recorded | |
| 2 | Platform fee entries (20%) | Correct fee amounts | |
| 3 | Payout entries | Payout records shown | |
| 4 | Refund entries | Reversals recorded | |
| 5 | Filter by type | Filters work | |

### 16.4 Subscription Flow (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Subscribe to creator | Stripe checkout, subscription created | |
| 2 | Cancel subscription | Access revoked at period end | |
| 3 | Access levels: public → follower → paid | Correct gating per level | |

### 16.5 Payouts (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Request payout (≥$50) | Payout initiated | |
| 2 | Under $50 → blocked | Error message | |
| 3 | 14-day reserve enforced | Reserved funds excluded | |
| 4 | Duplicate pending payout blocked | Error message | |

### 16.6 Creator Webhooks (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | `invoice.paid` → earning recorded | Ledger entry created | |
| 2 | `charge.refunded` → reversal | Access revoked, ledger reversed | |
| 3 | `payout.paid` → confirmed | Payout status updated | |
| 4 | `payout.failed` → alert | Creator notified | |
| 5 | Duplicate webhook → ignored | Idempotency check | |

---

## SECTION 17: MARKET DATA SERVICES

### 17.1 Search (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Search by ticker (e.g., "AAPL") | Results include AAPL | |
| 2 | Search by name (e.g., "Apple") | Results include AAPL | |
| 3 | Market cap enrichment in results | Cap shown per result | |
| 4 | Empty/no results | Graceful empty state | |

### 17.2 Quotes & Prices (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | `GET /market/quote/:ticker` | Full quote data | |
| 2 | `GET /market/fast-quote/:ticker` | Quick price | |
| 3 | `GET /market/prices?tickers=A,B,C` | Batch prices | |
| 4 | Extended hours pricing | `extendedPrice` when available | |

### 17.3 News (P2)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | General market news | Articles load | |
| 2 | Stock-specific news | Relevant to ticker | |
| 3 | News age filter | `maxAge` param works | |

### 17.4 Candle Data (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Intraday candles (1D) | Minute-level data | |
| 2 | Hourly candles (1W–1Y) | Hourly bars | |
| 3 | Daily candles (historical) | Daily bars via Polygon | |
| 4 | Polygon primary, Yahoo fallback | Both paths tested | |
| 5 | No Finnhub 403 errors in logs | All candles via Polygon | |

---

## SECTION 18: NAVIGATION & UX

### 18.1 Routing (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | `nalaai.com` → Portfolio tab | Default landing | |
| 2 | `nalaai.com/#tab=insights` → Insights | Direct navigation | |
| 3 | `nalaai.com/#tab=portfolio&stock=AAPL` → Stock detail | Correct stock shown | |
| 4 | Browser back/forward | Hash routing works | |
| 5 | No sessionStorage tab restore on bare URL | Always lands on portfolio | |

### 18.2 Header & Navigation (P0)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Desktop: all tabs visible | 7 primary + More dropdown | |
| 2 | Mobile: bottom nav (4 tabs + More) | Correct layout | |
| 3 | Search bar → autocomplete | Tickers found | |
| 4 | Theme toggle (sun/moon icon) | Dark/light switches | |
| 5 | User menu dropdown | Profile, settings, logout | |
| 6 | Keyboard shortcuts work | All shortcuts functional | |

### 18.3 Market Strip (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | S&P 500 value + change | Live data | |
| 2 | Dow Jones value + change | Live data | |
| 3 | Nasdaq value + change | Live data | |
| 4 | VIX value | Current level | |

### 18.4 Responsive Design (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Desktop (1440px+) | Full 3-column layout | |
| 2 | Tablet (768px) | 2-column layout | |
| 3 | Mobile (375px) | Single column, stacked | |
| 4 | Charts resize correctly | No overflow/clipping | |
| 5 | Tables scroll horizontally on mobile | No layout break | |

### 18.5 Loading & Error States (P1)
| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Skeleton loaders while data loads | Gray placeholders shown | |
| 2 | Network error → retry button | Toast + retry available | |
| 3 | 404 page | Graceful not-found | |
| 4 | Error boundary catches render crash | Error UI shown, not blank page | |

---

## SECTION 19: DARK MODE / LIGHT MODE

| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | All pages render correctly in dark mode | No white/broken elements | |
| 2 | All pages render correctly in light mode | No dark/broken elements | |
| 3 | Proper Tailwind pairs used | `dark:` prefixes on all theme colors | |
| 4 | Dropdowns: `bg-white dark:bg-[#1a1a1e]/95` | Correct backgrounds | |
| 5 | Modal borders: `border-gray-200/60 dark:border-white/[0.1]` | Visible borders | |
| 6 | Starfield only in dark mode | Stars not visible in light | |
| 7 | Charts readable in both modes | Correct contrast | |
| 8 | Heatmap colors clear in both modes | Red/green distinct | |

---

## SECTION 20: PERFORMANCE & CACHING

| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | `index.html`: `no-cache, no-store, must-revalidate` | Never stale after deploy | |
| 2 | `/assets/*`: `max-age=1y, immutable` | Hashed assets cached aggressively | |
| 3 | Other static: `max-age=1h, etag` | Short cache with validation | |
| 4 | `express.static` has `index: false` | No cache bypass on root | |
| 5 | Lazy-loaded pages (code splitting) | Chunks load on demand | |
| 6 | Heatmap preloads 3s after boot | Fast discovery tab | |
| 7 | API caches: briefing (30min), behavior (1hr), candles (24hr) | Repeat loads faster | |
| 8 | Hard refresh gets new UI version | No stale JS served | |

---

## SECTION 21: SECURITY

| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | CSP header blocks inline scripts (except unsafe-inline) | XSS mitigated | |
| 2 | CSP allows: Plaid, Cloudflare, Google, Apple | No blocked scripts | |
| 3 | HSTS enforced (1 year) | HTTPS-only | |
| 4 | Cookies: httpOnly, secure, sameSite | Not accessible via JS | |
| 5 | Rate limiting on all mutation endpoints | 429 after threshold | |
| 6 | No API keys in client responses | Secrets server-only | |
| 7 | Plaid tokens encrypted at rest (AES-256-GCM) | Not readable in DB | |
| 8 | Read-only mode blocks writes | `READ_ONLY=true` → 403 on POST/PUT/DELETE | |
| 9 | Cross-user data isolation | User A can't read User B's data | |
| 10 | Webhook signature verification (Stripe, Plaid) | Invalid signatures rejected | |

---

## SECTION 22: INFRASTRUCTURE & HEALTH

| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | `GET /health` returns 200 | Liveness check | |
| 2 | `GET /health/status` returns provider details | DB, APIs, cache status | |
| 3 | BetterStack uptime monitor pinging | 3-minute checks active | |
| 4 | Sentry capturing errors | Test error appears in dashboard | |
| 5 | Railway deploy succeeds | Build + start without errors | |
| 6 | Prisma migrations applied on startup | `prisma migrate deploy` runs | |
| 7 | No Finnhub `/stock/candle` 403s in logs | All candles via Polygon | |

---

## SECTION 23: ONBOARDING

| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | New user sees onboarding tour | 6-step walkthrough | |
| 2 | Tour can be skipped | Skip button works | |
| 3 | Tour completes → not shown again | `localStorage` flag set | |
| 4 | Sample portfolio seeded for new users | 5 stocks auto-added | |

---

## ~~SECTION 24: WATCH TAB~~ (Removed — no streaming rights for launch)

---

## SECTION 25: PUSH NOTIFICATIONS (P2)

| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | VAPID key endpoint | Returns public key | |
| 2 | Subscribe to push | Subscription stored | |
| 3 | Test push → notification appears | Browser notification shown | |
| 4 | Unsubscribe | Subscription removed | |

---

## SECTION 26: REFERRALS & WAITLIST

| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | Validate referral code | 200 with valid/invalid | |
| 2 | Referral stats (earned, conversions) | Correct counts | |
| 3 | Join waitlist | Entry created | |
| 4 | Admin approve/reject waitlist | Status changes | |

---

## SECTION 27: PRIVACY & COMPLIANCE

| # | Test | Expected | Owner | Result | Evidence | Date |
|---|------|----------|-------|--------|----------|------|
| 1 | `GET /privacy` returns privacy policy HTML | Full page renders | |
| 2 | Privacy policy content accurate | Matches current practices | |
| 3 | Account deletion removes ALL data | No orphaned records | |
| 4 | Consent records tracked | GDPR compliance | |
| 5 | No PII in Sentry events | Auth headers stripped | |

---

## PRE-LAUNCH BLOCKERS CHECKLIST

| # | Blocker | Owner | Result | Evidence | Date |
|---|---------|-------|--------|----------|------|
| 1 | Set Plaid secrets in Railway (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=sandbox`) | Engineer | |
| 2 | Test Plaid with real brokerage account | QA | |
| 3 | Production email verification smoke test | QA | |
| 4 | Flip `PLAID_ENABLED=true` in Railway | Engineer | |
| 5 | Confirm `DEEP_RESEARCH_ENABLED=true` + Gemini key set | Engineer | |
| 6 | Verify no Finnhub 403 errors in Railway logs | QA | |
| 7 | Confirm Stripe webhooks receiving events | QA | |
| 8 | Pin repos on GitHub profile page | Jon | |
| 9 | Test full checkout flow (Free → Pro → Premium) | QA | |
| 10 | Verify cache headers on `nalaai.com` (hard refresh gets new JS) | QA | |

---

## TOTAL TEST COUNTS

| Section | Tests |
|---------|-------|
| Authentication & Account | 45 |
| Portfolio Dashboard | 52 |
| Insights (9 subtabs) | 42 |
| Discover (4 subtabs) | 17 |
| Stock Detail View | 42 |
| Watchlists | 11 |
| Nala AI (Deep Research) | 19 |
| Leaderboard | 9 |
| Dividends | 11 |
| Macro/Economic | 9 |
| Social & Feed | 14 |
| Alerts & Notifications | 18 |
| Settings | 16 |
| Billing & Pricing | 15 |
| Plaid Integration | 10 |
| Creator Monetization | 21 |
| Market Data | 11 |
| Navigation & UX | 17 |
| Dark/Light Mode | 8 |
| Performance & Caching | 8 |
| Security | 10 |
| Infrastructure | 7 |
| Onboarding | 4 |
| Watch/Push/Referrals/Privacy | 12 |
| **TOTAL** | **~400 tests** |
