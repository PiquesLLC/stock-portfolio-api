# Stock Portfolio API — Agent Instructions

## Project Overview
**Nala** is a stock portfolio tracking app for the next generation of investors. This is a real product, not a side project — build it like it matters.

- **API**: `C:\Claude projects\stock-portfolio-api` (Express + TypeScript + Prisma + SQLite, port 3001)
- **UI**: `C:\Claude projects\stock-portfolio-ui` (React + Vite + Tailwind, port 5173) — **you do NOT touch this repo. Claude handles all UI work.**

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

## Auth System (Already Fully Implemented — Do NOT Modify Unless Asked)
- Access token: JWT, 15-minute expiry, stored in `authToken` httpOnly cookie
- Refresh token: 30-day expiry, rotation with reuse detection + 30-second grace period for concurrent requests
- `requireAuth` middleware: validates access token, silently refreshes if expired, returns 401 if no valid session
- `optionalAuth` middleware: same but continues without auth if no token present
- Token refresh race conditions are already handled — do NOT add additional rotation logic

## Data Sources (Priority Order)
1. **Finnhub** — real-time quotes (free tier, 60 calls/min)
2. **Polygon.io** — historical candles, daily bars, aggregates (paid premium plan)
3. **Yahoo Finance** — fallback for quotes and extended hours pricing
4. **Alpha Vantage** — fundamentals (company overview, P/E, etc.), economic indicators (free tier, 5 calls/min)
5. **Perplexity sonar-pro** — AI features (catalysts, briefing, Q&A, behavior coach)

All data fetching already has fallback chains (Polygon → Yahoo → Finnhub depending on data type). Do NOT add redundant fallback logic.

### Perplexity Integration
- User message drives the search, not the system prompt. Keep system prompt minimal (JSON format spec only). Put ticker, dates, and search query in user message.
- sonar-pro wraps responses in markdown fences (` ```json ``` `) despite instructions — always use `extractJson()` from `utils/perplexity.ts`
- sonar-pro returns non-standard types and string sentiments — use `normalizeType()` and `normalizeSentiment()`
- Only cache non-empty results to avoid persisting misses
- Shared utility: `utils/perplexity.ts` has `callPerplexity()` and `extractJson()`

## Database (Prisma + SQLite)
- Schema: `prisma/schema.prisma`, DB file: `prisma/dev.db`
- Key tables: `User`, `Holding`, `Transaction`, `RefreshToken`, `Watchlist`, `WatchlistHolding`, `FundamentalsCache`, `AnalystRating`, `DividendEvent`, `PriceAlert`, `PortfolioSnapshot`, `Milestone`
- Use `netEquity` (not `holdingsValue` or `totalAssets`) when displaying portfolio value — it subtracts margin debt

## What's Already Built (Do NOT Rebuild or Duplicate)
- Full portfolio tracking with real-time quotes and extended hours pricing
- Watchlists with P&L tracking, week/month/1Y % change, P/E ratios
- Portfolio value chart with period selection (1D/1W/1M/3M/YTD/1Y/ALL)
- Sparkline charts that sync with selected chart period
- 4 Perplexity AI features (catalysts, briefing, Q&A, behavior coach)
- Dividend tracking and income projections
- Portfolio health score and allocation analysis
- Price alerts system
- CSV and screenshot (OCR) portfolio import
- Economic indicators dashboard
- Leaderboard system
- Analyst ratings aggregation
- Market data endpoints: intraday candles, hourly candles, daily candles, stock details, ticker search

## Deployment
- **Railway** — production deployment, auto-builds from GitHub
- Build script (`scripts/build-with-client.sh`) clones the UI repo from GitHub and bundles it into `client/` directory
- Railway has its own database — local DB changes don't affect production
- After pushing to GitHub, deploy with: `railway redeploy --yes`
- Railway URL: `https://stock-portfolio-api-production.up.railway.app`

## Team Roles
- **Jon** — product vision and direction
- **Claude** — UI/frontend (React, Vite, Tailwind) — all UI changes go through Claude
- **Codex (you)** — API/backend (Express, Prisma, services)

## Commands
- `npm run dev` — start dev server with hot reload (nodemon)
- `npx prisma studio` — browse database
- `npx prisma migrate dev` — run migrations
- `npm run build` — compile TypeScript

## Rules
1. Never suggest auth changes for multi-user support — single-portfolio app by design
2. Never touch or suggest UI changes — that's Claude's domain
3. Never expose API keys or secrets in output — use indirect checks (key length, "key is set/missing")
4. Always normalize tickers to uppercase (already done everywhere, maintain the pattern)
5. Don't over-engineer — if something works for the current use case, leave it alone
6. Commit and push directly to `master` — single-owner repo
7. Create focused, single-purpose commits
