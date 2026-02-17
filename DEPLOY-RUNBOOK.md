# Deploy Runbook

## Quick Deploy

```bash
# 1. Push both repos (UI is cloned during Railway build)
cd "C:\Claude projects\stock-portfolio-api" && git push origin master
cd "C:\Claude projects\stock-portfolio-ui" && git push origin master

# 2. Deploy
cd "C:\Claude projects\stock-portfolio-api" && railway redeploy --yes

# 3. Wait 3-5 min for build, then verify
npm run smoke:test
```

## BILLING_ENABLED Toggle

| Value | Behavior |
|-------|----------|
| `true` (default) | Billing routes mount, startup validates Stripe env vars, fails fast if missing |
| `false` | Billing routes skipped, no Stripe env vars required, `/billing/*` returns 404 |

Set in Railway: `railway variables set BILLING_ENABLED=false`

**Current production setting:** `false` (Stripe not configured yet)

## Required Environment Variables

### Always Required (production)

| Variable | Source |
|----------|--------|
| `DATABASE_URL` | Railway auto-provisioned |
| `JWT_SECRET` | Random 64-char string |
| `JWT_REFRESH_SECRET` | Random 64-char string |
| `FINNHUB_API_KEY` | finnhub.io |
| `POLYGON_API_KEY` | polygon.io |
| `MFA_ENCRYPTION_KEY` | Random 32-byte hex |
| `PLAID_CLIENT_ID` | Plaid dashboard |
| `PLAID_SECRET` | Plaid dashboard |

### Required When BILLING_ENABLED=true

| Variable | Source |
|----------|--------|
| `STRIPE_SECRET_KEY` | Stripe dashboard |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook config |
| `STRIPE_PRO_MONTHLY_PRICE_ID` | Stripe Products |
| `STRIPE_PREMIUM_MONTHLY_PRICE_ID` | Stripe Products |
| `STRIPE_PRO_YEARLY_PRICE_ID` | Stripe Products |
| `STRIPE_PREMIUM_YEARLY_PRICE_ID` | Stripe Products |
| `STRIPE_RETURN_URL` | Your app URL + `/settings/billing` |

### Optional

| Variable | Default | Notes |
|----------|---------|-------|
| `ALPHA_VANTAGE_API_KEY` | — | Economic indicators, fundamentals |
| `PERPLEXITY_API_KEY` | — | AI features (briefing, Q&A, behavior, catalysts) |
| `RESEND_API_KEY` | — | Email OTP for MFA |
| `PLAID_ENV` | `sandbox` | `sandbox` or `production` |

## Validation Commands

```bash
# Check env vars against .env.example
npm run check:env

# Post-deploy smoke test (hits Railway endpoints)
npm run smoke:test

# Override smoke test target URL
SMOKE_BASE_URL=http://localhost:3001 npm run smoke:test
```

## Expected Smoke Test Results

### BILLING_ENABLED=false (current)

| Endpoint | Expected |
|----------|----------|
| `GET /auth/me` | 401 |
| `GET /market/quote/AAPL` | 200 |
| `GET /market/heatmap` | 200 |
| `POST /billing/webhook` (no sig) | 404 |
| `GET /portfolio/holdings` | 401 |
| `GET /insights/briefing` | 401 |

### BILLING_ENABLED=true

| Endpoint | Expected |
|----------|----------|
| `GET /auth/me` | 401 |
| `GET /market/quote/AAPL` | 200 |
| `GET /market/heatmap` | 200 |
| `POST /billing/webhook` (no sig) | 400 |
| `GET /portfolio/holdings` | 401 |
| `GET /insights/briefing` | 401 |

## Build Pipeline

Railway uses `scripts/build-with-client.sh`:

1. `npm install --include=dev`
2. `npx prisma generate`
3. `npx tsc`
4. Clone UI repo from GitHub (`PiquesLLC/stock-portfolio-ui`)
5. `npm install && npx vite build` in UI
6. Copy `dist/` to `client/`

Start command: `npx prisma db push --skip-generate && exec node dist/index.js`

**Important:** Push UI repo before deploying if UI changes were made — the build clones from GitHub.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| 502 on all endpoints | App crashed on startup | Check `railway logs` for error |
| `[Init] Billing deploy safety check failed` | Missing Stripe env vars with `BILLING_ENABLED=true` | Set `BILLING_ENABLED=false` or add Stripe vars |
| Stale UI after deploy | UI repo not pushed before deploy | Push UI, then `railway redeploy --yes` |
| `prisma db push` errors | Schema drift | Run migration manually or check schema.prisma |
