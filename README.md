# Nala — Portfolio Intelligence Platform (API)

The backend powering [Nala](https://stock-portfolio-api-production.up.railway.app), a portfolio tracking and analytics platform with real-time market data, AI insights, and brokerage integration.

**[Live App](https://stock-portfolio-api-production.up.railway.app)** · **[UI Repo](https://github.com/PiquesLLC/stock-portfolio-ui)**

---

## Architecture

```
src/
├── controllers/    # 29 request handlers
├── services/       # 56 business logic modules
├── routes/         # 25 route definitions
├── utils/          # Market data clients, encryption, helpers
├── middleware/      # Auth, rate limiting, error handling
├── validators/     # Zod request validation schemas
└── types/          # Shared TypeScript types

prisma/
└── schema.prisma   # 38 models
```

## Key Features

### Plaid Integration
- **Token exchange** — `POST /plaid/exchange-token` converts Plaid public tokens to access tokens
- **AES-256-GCM encryption** — All Plaid access tokens encrypted at rest with `crypto.createCipheriv`
- **Holdings sync** — `investmentsHoldingsGet()` imports equities and derivatives from linked brokerages
- **OCC options parsing** — Decodes option contract symbols (`AAPL260220C00150000`) into underlying, strike, expiry, type
- **Token lifecycle** — Revokes Plaid access tokens on account deletion via `itemRemove()`
- **Webhook handler** — Processes `ITEM` events (ERROR, PENDING_EXPIRATION) for proactive token management

### AI Engine (Perplexity sonar-pro)
- **Portfolio Briefing** — `GET /insights/briefing` — AI-generated daily portfolio summary (30min cache)
- **Behavioral Coach** — `GET /insights/behavior` — Detects concentration risk, loss aversion, overtrading (1hr cache)
- **Stock Q&A** — `POST /market/stock/:ticker/ask` — Natural language questions about any ticker
- **Catalyst Detection** — `GET /market/stock/:ticker/ai-events` — Upcoming events impacting holdings

### Market Data Pipeline
- **Real-time quotes** — Polygon.io with 30s cache, Finnhub fallback
- **Intraday candles** — 5-minute bars for 1D charts via Polygon
- **Historical data** — Yahoo Finance for daily/weekly/monthly candles
- **Options pricing** — Finnhub `/stock/option/chain` with queue-based rate limiting
- **Economic indicators** — Alpha Vantage (GDP, CPI, unemployment, fed funds rate)
- **S&P 500 heatmap** — Aggregated sector/sub-sector performance data

### Authentication & Security
- **JWT** with httpOnly secure cookies + refresh token rotation
- **MFA** — TOTP (authenticator apps) + email OTP (via Resend) + backup codes
- **bcrypt** password hashing with salt rounds
- **AES-256-GCM** encryption for Plaid tokens and MFA secrets
- **Rate limiting** — Tiered limits for auth endpoints, reads, and mutations
- **CORS** — Strict origin allowlist (no wildcards in production)
- **Helmet** — CSP, HSTS, X-Frame-Options, referrer policy
- **Zod** — Request validation on all mutation endpoints
- **IDOR protection** — All data queries scoped to authenticated user

### Portfolio Analytics
- **Nala Score** — 5-dimension portfolio health rating (diversification, risk, growth, income, momentum)
- **Milestone detection** — Automatic alerts for 52-week high/low, all-time high/low
- **Dividend tracking** — Income projections, DRIP simulation, ex-date scheduling
- **Portfolio snapshots** — Periodic value captures for historical charting

### Payments (Stripe)
- Checkout session creation with plan-based pricing
- Webhook handler for subscription lifecycle events
- Plan gating middleware for premium features

---

## Data Models (38 tables)

Key entities:
- `User`, `RefreshToken`, `MfaSecret`, `MfaBackupCode`
- `Holding`, `PlaidItem`, `PlaidAccount`
- `PortfolioSnapshot`, `PortfolioHistoryPoint`
- `Watchlist`, `WatchlistItem`
- `PriceAlert`, `MilestoneEvent`, `Notification`
- `StockFundamentals`, `NalaScore`, `EarningsHistory`
- `DividendHistory`, `PerplexityCache`

## API Routes

| Prefix | Description | Endpoints |
|--------|-------------|-----------|
| `/auth` | Authentication, MFA, account management | signup, login, refresh, mfa/*, delete-account |
| `/market` | Market data, quotes, charts, search | quote/:ticker, stock/:ticker/*, heatmap, search |
| `/portfolio` | Portfolio data, snapshots, holdings | holdings, chart, summary, cash |
| `/insights` | AI features, dividends, projections | briefing, behavior, dividends, nala-score |
| `/plaid` | Brokerage linking | link-token, exchange-token, items, webhook |
| `/social` | Leaderboard, profiles, feed | leaderboard, profile/:id, feed |
| `/alerts` | Price alerts, notifications | alerts, notifications, milestones |
| `/stripe` | Subscription management | checkout, webhook, status |

## Setup

```bash
npm install
cp .env.example .env          # Fill in API keys
npx prisma migrate deploy     # Run migrations
npx prisma generate           # Generate Prisma client
npm run dev                   # Starts on http://localhost:3001
```

See `.env.example` for all required environment variables.

## Deployment

Deployed on [Railway](https://railway.app) with automatic builds from GitHub. The build script (`scripts/build-with-client.sh`) clones the UI repo and bundles it into the `client/` directory for single-origin serving.

---

Built by [Piques LLC](https://github.com/PiquesLLC)
