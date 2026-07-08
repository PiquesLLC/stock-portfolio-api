# Stock Portfolio API

A Robinhood-style REST API for real-time stock portfolio tracking with momentum-based projection engine.

## Quick Start

```bash
npm install
cp .env.example .env  # Add your FINNHUB_API_KEY
npx prisma generate
npx prisma db push
npm run dev
```

## Tech Stack

- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js
- **Database**: SQLite with Prisma ORM
- **Market Data**: Finnhub API (60 calls/min free tier)
- **Caching**: node-cache (5-second TTL for prices)

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check |
| GET | /portfolio | Current portfolio with real-time P/L |
| POST | /portfolio/holdings | Add/update holding (upsert) |
| DELETE | /portfolio/holdings/:ticker | Remove holding |
| PUT | /portfolio/cash | Update cash balance |
| GET | /portfolio/history | Historical snapshots |
| GET | /portfolio/projections | Growth projections |
| GET | /market/prices?tickers=X,Y | Batch price lookup |
| GET | /market/quote/:ticker | Detailed single quote |

## Project Structure

```
src/
├── index.ts           # Server entry point
├── app.ts             # Express setup
├── config/            # Environment config
├── controllers/       # Request handlers
├── services/          # Business logic
├── routes/            # Route definitions
├── types/             # TypeScript interfaces
└── utils/             # Finnhub client, math helpers
```

## Projection Engine

The projection service uses momentum-based analysis when 20+ days of history exist:

- **Velocity**: 20-day EMA of daily returns
- **Acceleration**: Linear regression slope of velocity history
- **Volatility**: Standard deviation of recent returns (penalizes projections)
- **Drawdown**: Current distance from peak (penalizes if > 10%)

Falls back to simple CAGR projections (7% base) for new portfolios.

## Development

```bash
npm run dev      # Start with nodemon
npm run build    # Compile TypeScript
npm start        # Run compiled JS
npx prisma studio  # Database GUI
```

## Environment Variables

- `PORT` - Server port (default: 3001, matching the UI dev proxy)
- `FINNHUB_API_KEY` - Required for market data
- `DATABASE_URL` - SQLite path (default: file:./dev.db)
- `PRICE_CACHE_TTL` - Cache duration in seconds (default: 5)
