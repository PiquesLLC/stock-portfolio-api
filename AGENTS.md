# Stock Portfolio API — Agent Instructions

## Project Overview
**Nala** is a stock portfolio tracking app for the next generation of investors. This is a real product, not a side project — build it like it matters. Jon is ambitious and creative — his ideas drive the product. Execute with the same ambition. Don't trim ideas down or play it safe.

- **API**: `C:\Claude projects\stock-portfolio-api` (Express + TypeScript + Prisma + SQLite, port 3001)
- **UI**: `C:\Claude projects\stock-portfolio-ui` (React + Vite + Tailwind, port 5173) — **you do NOT touch this repo. Claude handles all UI work.**

## Team Roles
- **Jon** — product vision and direction
- **Claude** — UI/frontend (React, Vite, Tailwind) — all UI changes go through Claude
- **Codex (you)** — API/backend (Express, Prisma, services)

---

## Critical Architecture: Single-Portfolio Design
- **System user ID**: `237198da-612e-411c-9ef8-f267c887a9f1`
- ALL portfolio data, holdings, watchlists, and settings belong to this single system user
- Auth (JWT access token + refresh token with httpOnly cookies) exists for **access control only** — it gates who can view the app, NOT for multi-user data isolation
- **NEVER** use `req.user.userId` for portfolio/holdings/watchlist lookups — ALWAYS use the hardcoded `SYSTEM_USER_ID`
- Every service function already defaults to `SYSTEM_USER_ID` — this is intentional, not a bug
- Never suggest auth changes for multi-user support — this is a single-portfolio app by design

## API Code Pattern
```
routes/*.routes.ts → controllers/*.controller.ts → services/*.service.ts
```
- Routes are mounted in `src/routes/index.ts` via `app.use('/', routes)` with prefixes (`/market`, `/insights`, `/watchlists`, etc.)
- Controllers handle HTTP (req/res, status codes, error responses)
- Services contain business logic and data access via Prisma
- The controller layer already has proper 404/409 error codes with stable responses

---

## ⛔ DO NOT TOUCH ZONES — Carefully Tuned Logic

The following areas have been extensively tuned over many iterations to handle edge cases around market hours, data quality, and chart rendering. **Do NOT modify this logic unless Jon specifically asks AND you fully understand the consequences.**

### 1. The 1D Chart Handler (`portfolio.controller.ts` → `getChartHandler`, period === '1D')

This is the most sensitive code in the entire API. It reconstructs today's portfolio value chart from per-ticker intraday candles and has been carefully tuned.

**How it works:**
1. Calls `reconstructPortfolioHistoryHiRes(holdings, cash, margin, '1d', '5m')` to build points from Yahoo/Polygon 5-minute candles
2. Falls back to last 24h of snapshots if Yahoo returns <5 points
3. Fills the gap between last candle (~15min delayed) and now using recent snapshots (recorded every ~60 seconds)
4. **Always appends the current live value** as the final point (so the chart extends to "now")
5. Applies composition rebaseline if holdings changed within the last day (avoids false jumps)
6. Calculates `periodStartValue` from `previousCloseValue` (for gain/loss display)

**Rules — DO NOT:**
- ❌ Filter points by market session (REG/PRE/POST) — the chart should show ALL intraday data Yahoo provides
- ❌ Gate the live value append behind a session check — it must ALWAYS append regardless of market hours
- ❌ Pass `minActualRatio` lower than 0.5 — this creates phantom points with wrong values (stray dots on chart)
- ❌ Add any "smart" filtering that removes data points — the existing logic already handles bad data
- ❌ Change the Yahoo range/interval parameters ('1d', '5m') without understanding the downstream effects

**Why these rules exist (real incident):** On Feb 12 2026, Codex lowered minActualRatio to 0.25, added REG-only filtering, and gated live value behind a session check. Result: phantom dots scattered across the chart, chart starting halfway through the x-axis, and the line cutting off before reaching "now" after hours. All three changes had to be reverted.

### 2. `reconstructPortfolioHistoryHiRes()` in `snapshot.service.ts`

This function builds portfolio value from per-ticker candles. It is the engine behind 1D, 1W, 1M, and YTD charts.

**Key thresholds — DO NOT change:**
- **`minActualRatio` default = 0.5 (50%)** — A point is only included if ALL tickers have a price (actual or forward-filled) AND at least 50% have REAL (non-forward-filled) data. This prevents phantom early points when most tickers are still forward-filled from stale prices.
- **Outlier filtering (5% deviation)** — Interior points that deviate >5% from neighbors are replaced with interpolated averages. This prevents after-hours junk data spikes. Do not remove or loosen this.
- **Forward-fill logic** — When a ticker has no data at a timestamp but has data later, uses the first available price. This prevents holdings from silently "disappearing" from the total.

**Cache TTLs (already tuned):**
- Intraday/hourly candles: 5-minute cache
- Daily candles: 24-hour cache

### 3. Snapshot Creation (`snapshot.service.ts` → `createSnapshotIfNeeded()`)

Records portfolio state every ~60 seconds with validation thresholds that prevent bad data from polluting history:

- **>50% of quotes unavailable**: Skip snapshot (premarket/after-hours tolerance)
- **Total assets < $100**: Skip (noise prevention)
- **>25% sudden drop + unavailable quotes**: Skip — likely bad data from provider glitch, not a real crash

**Critical distinction:**
- `totalValue` = holdingsValue + cashBalance (NO marginDebt) — for performance tracking
- `netEquity` = totalValue - marginDebt — for display/balance sheet

Do NOT change these thresholds. They prevent cascading data corruption.

### 4. Price Fallback Chain

The system uses multiple data providers with a carefully ordered fallback chain:
- Extended price (pre/post market) → Current price → Previous close
- **NEVER use 0 as a fallback price** — this creates wildly incorrect portfolio calculations
- The fallback chain is already implemented in `portfolio.service.ts` → `getPortfolio()`. Do not add redundant fallback logic.

---

## Chart System — Complete Reference

All chart periods go through `getChartHandler` in `portfolio.controller.ts`:

| Period | Yahoo Range | Yahoo Interval | Function | Notes |
|--------|------------|----------------|----------|-------|
| 1D | `1d` | `5m` | `reconstructPortfolioHistoryHiRes` | + snapshot gap-fill + live value |
| 1W | `5d` | `15m` | `reconstructPortfolioHistoryHiRes` | ~130 points per ticker |
| 1M | `1mo` | `1h` | `reconstructPortfolioHistoryHiRes` | ~150 points per ticker |
| YTD | Dynamic | `1h` or `1d` | `reconstructPortfolioHistoryHiRes` | <90 days = hourly, ≥90 = daily |
| 3M | — | daily | `reconstructPortfolioHistory` (legacy) | 90 days |
| 1Y | — | daily | `reconstructPortfolioHistory` (legacy) | 365 days |
| ALL | — | daily | `reconstructPortfolioHistory` (legacy) | 5 years |

**Composition change rebaseline** applies to ALL periods: if holdings changed within the chart window, all points before the change are filtered out to avoid false jumps.

**Polygon.io range mapping** (in `reconstructPortfolioHistoryHiRes`):
- Yahoo `1d` → Polygon `2d`, Yahoo `5d` → Polygon `7d`, Yahoo `1mo` → Polygon `35d`
- Limit: 300 candles per ticker

---

## Auth System (Fully Implemented — Do NOT Modify Unless Asked)
- Access token: JWT, 15-minute expiry, stored in `authToken` httpOnly cookie
- Refresh token: 30-day expiry, rotation with reuse detection + 30-second grace period for concurrent requests
- `requireAuth` middleware: validates access token, silently refreshes if expired, returns 401 if no valid session
- `optionalAuth` middleware: same but continues without auth if no token present
- Token refresh race conditions are already handled — do NOT add additional rotation logic

---

## Data Sources (Priority Order)
1. **Polygon.io** — primary for historical candles, daily bars, aggregates (paid premium plan)
2. **Yahoo Finance** — fallback for candles, extended hours pricing
3. **Finnhub** — real-time quotes (free tier, 60 calls/min)
4. **Alpha Vantage** — fundamentals (company overview, P/E, etc.), economic indicators (free tier, 5 calls/min)
5. **Perplexity sonar-pro** — AI features (catalysts, briefing, Q&A, behavior coach)

All data fetching already has fallback chains (Polygon → Yahoo → Finnhub depending on data type). Do NOT add redundant fallback logic.

### Perplexity Integration (4 features)
1. **Ticker Catalysts** — `GET /market/stock/:ticker/ai-events` → `perplexity-events.service.ts`
2. **Portfolio Briefing** — `GET /insights/briefing` → `perplexity-briefing.service.ts` (30min cache)
3. **Stock Q&A** — `POST /market/stock/:ticker/ask` → `perplexity-qa.service.ts` (no cache)
4. **Behavior Coach** — `GET /insights/behavior` → `perplexity-behavior.service.ts` (1hr cache)

**Rules:**
- User message drives the search, not the system prompt. Keep system prompt minimal (JSON format spec only). Put ticker, dates, and search query in user message.
- sonar-pro wraps responses in markdown fences (` ```json ``` `) despite instructions — always use `extractJson()` from `utils/perplexity.ts`
- sonar-pro returns non-standard types ("Earnings", "PRODUCT", "Corporate") — use `normalizeType()`
- sonar-pro returns string sentiments ("positive"/"negative") — use `normalizeSentiment()`
- Only cache non-empty results to avoid persisting misses
- Shared utility: `utils/perplexity.ts` has `callPerplexity()` and `extractJson()`

---

## Market Hours Utility (`utils/market-hours.ts`)

`getMarketSession(date?)` returns: **PRE** | **REG** | **POST** | **CLOSED**
- PRE: 4:00 AM – 9:30 AM ET
- REG: 9:30 AM – 4:00 PM ET
- POST: 4:00 PM – 8:00 PM ET
- CLOSED: 8:00 PM – 4:00 AM ET (+ weekends)

`getMarketSessionForTicker()` supports international markets:
- Crypto (24/7): `-USD`, `-CAD`, `-EUR`, `-GBP`
- Commodity futures: `=F` suffix (Sun evening through Fri, 24/5)
- Canada: `.TO`, `.V` (TSX), London: `.L` (LSE), Europe: `.PA`, `.AS`, `.DE`, etc.
- Tokyo: `.T`, Hong Kong: `.HK`, Australia: `.AX`

---

## Database (Prisma + SQLite)
- Schema: `prisma/schema.prisma`, DB file: `prisma/dev.db`
- Key tables: `User`, `Holding`, `Transaction`, `RefreshToken`, `Watchlist`, `WatchlistHolding`, `FundamentalsCache`, `AnalystRating`, `DividendEvent`, `PriceAlert`, `PortfolioSnapshot`, `Milestone`
- **`netEquity`** (not `holdingsValue` or `totalAssets`) for displaying portfolio value — it subtracts margin debt
- **`totalAssets`** (no marginDebt) for performance tracking — ensures margin debt changes don't affect historical performance

---

## Service Inventory

| Service | Purpose |
|---------|---------|
| `market.service.ts` | Live quote fetching (Polygon/Yahoo/Finnhub), intraday candles |
| `portfolio.service.ts` | Holdings CRUD, portfolio calculation, getPortfolio(), getHoldings() |
| `snapshot.service.ts` | Snapshot creation, portfolio reconstruction from candles |
| `projection.service.ts` | S&P 500 projections, realized returns, pace calculations |
| `benchmark.service.ts` | Performance comparison vs SPY/QQQ/DIA |
| `transaction.service.ts` | Deposit/withdrawal tracking for TWR |
| `dividend.service.ts` | Dividend tracking & income calculations |
| `dividend-post.service.ts` | Dividend credit posting |
| `drip.service.ts` | DRIP (dividend reinvestment) settings |
| `activity.service.ts` | User activity events |
| `earnings.service.ts` | Earnings date & EPS info |
| `earnings-summary.service.ts` | Batch earnings summaries |
| `analyst.service.ts` | Analyst ratings & price targets |
| `goals.service.ts` | Financial goal tracking |
| `leaderboard.service.ts` | Leaderboard rankings |
| `milestone.service.ts` | Achievement tracking |
| `alert.service.ts` | Alert management |
| `priceAlert.service.ts` | Price-based alerts |
| `watchlist.service.ts` | Watchlist CRUD |
| `news.service.ts` | News aggregation |
| `fundamentals.service.ts` | Company fundamentals (P/E, market cap) |
| `insights.service.ts` | Portfolio health, attribution, risk |
| `income-insights.service.ts` | Income analysis |
| `portfolioIntelligence.service.ts` | Sector analysis, correlations |
| `user-portfolio.service.ts` | Public user profiles/portfolios |
| `auth.service.ts` | Authentication |
| `screenshot-ocr.service.ts` | OCR for portfolio import |
| `historical-cagr.service.ts` | Historical CAGR calculations |
| `economic.service.ts` | Economic indicators (Alpha Vantage) |
| `follow.service.ts` | User following |
| `nala-research.service.ts` | Nala AI research |
| `perplexity-briefing.service.ts` | AI briefing (30min cache) |
| `perplexity-qa.service.ts` | Stock Q&A (no cache) |
| `perplexity-events.service.ts` | Ticker catalysts |
| `perplexity-behavior.service.ts` | Behavior coaching (1hr cache) |
| `perplexity-daily-report.service.ts` | Daily AI reports |

---

## Complete Endpoint Catalog (~145 endpoints)

### Auth (`/auth`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/login` | None | Login |
| POST | `/auth/logout` | None | Logout |
| POST | `/auth/refresh` | None | Refresh tokens |
| GET | `/auth/me` | requireAuth | Current user |
| POST | `/auth/set-password` | None | Set password |
| GET | `/auth/has-password/:username` | None | Check if user has password |
| POST | `/auth/signup` | None | Create account |
| GET | `/auth/check-username/:username` | None | Check availability |
| POST | `/auth/change-password` | requireAuth | Change password |
| DELETE | `/auth/delete-account` | requireAuth | Delete account |

### Market (`/market`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/market/search` | None | Search symbols |
| GET | `/market/prices` | None | Batch prices |
| GET | `/market/quote/:ticker` | None | Stock quote |
| GET | `/market/fast-quote/:ticker` | None | Fast quote |
| GET | `/market/stock/:ticker/details` | None | Stock details |
| GET | `/market/stock/:ticker/intraday` | None | Intraday candles |
| GET | `/market/stock/:ticker/hourly` | None | Hourly candles |
| GET | `/market/stock/:ticker/daily` | None | Daily candles |
| GET | `/market/stock/:ticker/etf-holdings` | None | ETF holdings |
| GET | `/market/stock/:ticker/about` | None | Asset about info |
| GET | `/market/stock/:ticker/news` | None | Ticker news |
| GET | `/market/stock/:ticker/ai-events` | None | AI events (Perplexity) |
| POST | `/market/stock/:ticker/ask` | None | Stock Q&A (Perplexity) |
| GET | `/market/benchmark/:ticker/closes` | None | Benchmark closes |
| GET | `/market/news` | None | Market news |
| GET | `/market/historical-cagr` | None | Historical CAGR |

### Portfolio (`/portfolio`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/portfolio/` | optionalAuth | Get portfolio |
| POST | `/portfolio/holdings` | requireAuth | Add holding |
| DELETE | `/portfolio/holdings/:ticker` | requireAuth | Remove holding |
| PUT | `/portfolio/cash` | requireAuth | Set cash balance |
| GET | `/portfolio/history` | None | Snapshot history |
| GET | `/portfolio/history/chart` | None | **Chart data** (all periods) |
| GET | `/portfolio/projections` | None | Projections |
| GET | `/portfolio/projections/current-pace` | None | Current pace |
| GET | `/portfolio/metrics` | None | Metrics |
| GET | `/portfolio/summary` | None | Summary |
| GET | `/portfolio/performance` | None | Performance |
| GET | `/portfolio/activity/:ticker` | requireAuth | Ticker activity |
| POST | `/portfolio/import/csv` | requireAuth | CSV import |
| POST | `/portfolio/import/screenshot` | requireAuth | Screenshot OCR import |
| POST | `/portfolio/import/confirm` | requireAuth | Confirm import |
| POST | `/portfolio/clear` | requireAuth | Clear portfolio |

### Insights (`/insights`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/insights/health` | None | Portfolio health |
| GET | `/insights/attribution` | None | Performance attribution |
| GET | `/insights/leak-detector` | None | Leak detector |
| GET | `/insights/risk-forecast` | None | Risk forecast |
| GET | `/insights/income` | None | Income insights |
| GET | `/insights/briefing` | None | AI briefing (Perplexity) |
| POST | `/insights/briefing/explain` | None | Explain briefing point |
| GET | `/insights/behavior` | None | Behavior coach (Perplexity) |
| GET | `/insights/daily-report` | None | Daily report |
| POST | `/insights/daily-report/regenerate` | None | Regenerate report |
| GET | `/insights/earnings-summary` | None | Earnings summary |

### Dividends (`/dividends`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/dividends/events` | None | Dividend events |
| GET | `/dividends/events/upcoming` | None | Upcoming dividends |
| POST | `/dividends/events` | requireAuth | Add event |
| DELETE | `/dividends/events/:id` | requireAuth | Delete event |
| GET | `/dividends/credits` | None | Posted dividends |
| GET | `/dividends/credits/:id/timeline` | None | Credit timeline |
| POST | `/dividends/credits/:id/reinvest` | requireAuth | Reinvest dividend |
| GET | `/dividends/reinvestments` | None | Reinvestments |
| GET | `/dividends/summary` | None | Dividend summary |
| GET | `/dividends/drip` | None | DRIP settings |
| PUT | `/dividends/drip` | requireAuth | Update DRIP |
| POST | `/dividends/sync` | requireAuth | Sync from Yahoo |
| POST | `/dividends/backfill` | requireAuth | Backfill postings |

### Watchlists (`/watchlists`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/watchlists/` | requireAuth | List watchlists |
| POST | `/watchlists/` | requireAuth | Create watchlist |
| GET | `/watchlists/:id` | requireAuth | Get watchlist |
| GET | `/watchlists/:id/chart` | requireAuth | Watchlist chart |
| PUT | `/watchlists/:id` | requireAuth | Update watchlist |
| DELETE | `/watchlists/:id` | requireAuth | Delete watchlist |
| POST | `/watchlists/:id/holdings` | requireAuth | Add holding |
| PUT | `/watchlists/:id/holdings/:ticker` | requireAuth | Update holding |
| DELETE | `/watchlists/:id/holdings/:ticker` | requireAuth | Remove holding |

### Settings (`/settings`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/settings/` | optionalAuth | Get settings |
| PUT | `/settings/` | requireAuth | Update settings |
| POST | `/settings/baseline` | requireAuth | Set baseline |
| POST | `/settings/broker-lifetime` | requireAuth | Set broker lifetime |
| DELETE | `/settings/broker-lifetime` | requireAuth | Clear broker lifetime |
| GET | `/settings/ytd` | optionalAuth | Get YTD returns |
| POST | `/settings/ytd` | requireAuth | Set YTD |
| DELETE | `/settings/ytd` | requireAuth | Clear YTD |
| POST | `/settings/cleanup-snapshots` | requireAuth | Clean old snapshots |
| POST | `/settings/tracking/activate` | requireAuth | Activate tracking |
| POST | `/settings/tracking/restart` | requireAuth | Restart tracking |

### Users (`/users`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/users/` | optionalAuth | List profiles |
| GET | `/users/:userId/portfolio` | optionalAuth | User portfolio |
| GET | `/users/:userId/chart` | optionalAuth | User chart |
| GET | `/users/:userId/profile` | optionalAuth | User profile |
| GET | `/users/:userId/is-following` | optionalAuth | Check following |
| GET | `/users/:userId/followers` | None | Followers |
| GET | `/users/:userId/following` | None | Following |
| GET | `/users/:userId/settings` | requireAuth | User settings |
| GET | `/users/:userId/intelligence` | optionalAuth | User intelligence |
| POST | `/users/:userId/follow` | requireAuth | Follow |
| DELETE | `/users/:userId/follow` | requireAuth | Unfollow |
| PUT | `/users/:userId/region` | requireAuth | Update region |
| PUT | `/users/:userId/holdings-visibility` | requireAuth | Holdings visibility |
| PUT | `/users/:userId/settings` | requireAuth | Update settings |

### Other Endpoints
| Prefix | Key Endpoints |
|--------|--------------|
| `/goals` | CRUD for financial goals |
| `/intelligence` | GET `/intelligence/` — sector analysis, correlations |
| `/leaderboard` | GET `/leaderboard/` — rankings |
| `/social` | GET `/social/feed` — social feed |
| `/transactions` | CRUD for deposits/withdrawals |
| `/alerts` | CRUD + read/unread for alerts |
| `/price-alerts` | CRUD + events for price alerts |
| `/analyst` | Analyst events, snapshots, read/unread |
| `/milestones` | Milestone events, read/unread |
| `/fundamentals` | Company fundamentals, earnings, economic data |
| `/nala` | POST `/nala/ask` — Nala AI, GET `/nala/suggestions` |
| `/health` | GET `/health/` — health check |

---

## What's Already Built (Do NOT Rebuild or Duplicate)
- Full portfolio tracking with real-time quotes and extended hours pricing
- Watchlists with P&L tracking, week/month/1Y % change, P/E ratios
- Portfolio value chart with period selection (1D/1W/1M/3M/YTD/1Y/ALL)
- Sparkline charts that sync with selected chart period
- 4 Perplexity AI features (catalysts, briefing, Q&A, behavior coach)
- Nala AI assistant with research capabilities
- Dividend tracking, income projections, DRIP
- Portfolio health score, attribution, risk forecast, leak detector
- Price alerts system
- CSV and screenshot (OCR) portfolio import
- Economic indicators dashboard (domestic + international)
- Leaderboard system with public profiles
- Analyst ratings aggregation
- Market data endpoints: intraday, hourly, daily candles, stock details, ticker search, ETF holdings
- Social features: following, feed
- Financial goals tracking
- Milestone achievements

---

## Deployment
- **Railway** — production deployment, auto-builds from GitHub
- Build script (`scripts/build-with-client.sh`) clones the UI repo from GitHub and bundles it into `client/` directory
- Railway has its own database — local DB changes don't affect production
- After pushing to GitHub, deploy with: `railway redeploy --yes`
- Railway URL: `https://stock-portfolio-api-production.up.railway.app`
- Must push BOTH API and UI repos before deploying (UI is cloned during build)

---

## Commands
- `npm run dev` — start dev server with hot reload (nodemon)
- `npx prisma studio` — browse database
- `npx prisma migrate dev` — run migrations
- `npm run build` — compile TypeScript
- `npx tsc --noEmit` — type check without building (run after edits)

---

## Rules
1. Never suggest auth changes for multi-user support — single-portfolio app by design
2. Never touch or suggest UI changes — that's Claude's domain
3. Never expose API keys or secrets in output — use indirect checks (key length, "key is set/missing")
4. Always normalize tickers to uppercase (already done everywhere, maintain the pattern)
5. Don't over-engineer — if something works for the current use case, leave it alone
6. Commit and push directly to `master` — single-owner repo
7. Create focused, single-purpose commits
8. **Before modifying any "DO NOT TOUCH" zone**: Read the full function, understand the edge cases it handles, and explain your reasoning. If you can't explain why every existing check exists, you don't understand it well enough to change it.
9. **Never use 0 as a fallback price** — cascades into incorrect portfolio calculations everywhere
10. **Test after changes** — run `npx tsc --noEmit` at minimum before committing

---

## Past Mistakes to Never Repeat

### Feb 12 2026 — 1D Chart Broken
**What happened:** Changed `minActualRatio` from 0.5 to 0.25, added REG-only session filtering to chart points, and gated live value append behind `sessionNow === 'REG'`.

**Result:** Phantom stray dots scattered across chart (bad data points from lowered threshold), chart starting halfway through the x-axis (pre-market data filtered out), line cutting off before reaching "now" (no live value appended after hours).

**Root cause:** Modified carefully tuned chart logic without understanding why each piece existed. The 50% threshold, the inclusion of all session data, and the unconditional live value append were all intentional design decisions, not oversights.

**Lesson:** The chart handler is the most user-visible feature. Every change is immediately visible. Read the full function and understand every line before making modifications.
