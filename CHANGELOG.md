# Changelog

## [2026-03-02] Security Audit

142-finding security audit completed across 86 files, plus 3 follow-up fixes from Codex review. 30 regression tests added to lock in critical fixes.

### Removed Endpoints

- **`POST /dividends/events`** — Manual dividend event creation disabled (shared market data, not user-scoped)
- **`DELETE /dividends/events/:id`** — Manual dividend event deletion disabled
- **`POST /analyst/events/:id/read`** — Single-event read marking removed (use `POST /analyst/events/read-all`)

### Stricter Privacy Gates

- **Intelligence visibility**: `GET /users/:userId/intelligence` now returns 404 unless `holdingsVisibility` is `'all'` (was leaking full position data for top5/sectors users)
- **Profile privacy**: Intelligence endpoint now checks `profilePublic` before returning data
- **Owner bypass**: Self-lookup still works regardless of visibility settings

### SSRF Prevention

- **Push subscription endpoint allowlist**: Validates push endpoints against allowlisted domains (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`, `push.services.mozilla.com`) using dot-boundary matching to prevent subdomain spoofing (e.g., `evilfcm.googleapis.com` is rejected)
- **HTTPS required**: Non-HTTPS push endpoints rejected

### User-Scoped Operations

- **Dividend sync**: `syncHandler` and `backfillHandler` now pass authenticated `userId` to `postDividendsForDate`, `backfillMissedDividends`, and `syncAllHeldTickers` — previously could affect all users
- **deleteHolding cascade**: Lot, trade, dividend credit, and dividend reinvestment cleanup is scoped to `{ ticker, userId }` inside a `$transaction` — prevents orphaned records and cross-user data leaks

### Anti-Enumeration

- **Waitlist join**: All three scenarios (new email, already on waitlist, already registered) return `{ success: true }` with HTTP 200 — attackers cannot determine which emails have accounts

### Input Validation & Rate Limiting

- Push subscription key length limits (`MAX_ENDPOINT_LENGTH: 2048`, `MAX_KEY_LENGTH: 512`)
- Enumeration rate limiters on user lookup endpoints
- Mutation rate limiters on all write endpoints
- Email format validation on waitlist join

### Other Security Fixes

- Daily report regeneration returns 403 `email_verification_required` for unverified users
- `reinvestHandler` and `updateDripSettingsHandler` always use `req.user.userId` — never accept userId from request body
- `Stripe customerId` unique constraint added (migration `20260302_stripe_customer_id_unique`)
- Dividend event `dividendType` validated against allowlist (`cash`, `drip`, `regular`)

### Migrations

- `20260301_user_settings_tracking` — Per-user tracking fields (baseline values, broker lifetime data)
- `20260302_add_analyst_last_read_at` — Analyst last-read timestamp on UserSettings
- `20260302_stripe_customer_id_unique` — Unique index on `User.stripeCustomerId`

### Test Coverage

- 30 new regression tests in `security-regression.test.ts` covering all 5 critical fixes
- 3 existing tests in `security-audit-fixes.test.ts` covering endpoint removal and email verification gate
- Total suite: 371 tests passing
