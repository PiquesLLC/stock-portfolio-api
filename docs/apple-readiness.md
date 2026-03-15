# Apple Backend Readiness Checklist

Date: 2026-03-10
Owner: Backend (API)
Scope: App Store Server Notifications v2 + Apple IAP activation/restore flows in `stock-portfolio-api`.

## 1. Environment Variables

Set these in Railway (production) and local `.env` (development/testing) before enabling Apple IAP.

Required:
- `APPLE_IAP_ENABLED=true`
- `APPLE_BUNDLE_ID=com.nala.portfolio` (must match App Store Connect app bundle id)

Recommended for parity and fallback compatibility:
- `APPLE_IAP_SHARED_SECRET=<app-specific-shared-secret>` (legacy receipt flows or fallback integrations)
- `APPLE_TEAM_ID=<apple-developer-team-id>`
- `APPLE_KEY_ID=<apple-key-id>`
- `APPLE_PRIVATE_KEY=<apple-private-key-pem-with-escaped-newlines>`

Operational support vars:
- `NODE_ENV=production` in prod (service rejects sandbox transactions in prod verification paths)
- `SENTRY_DSN=<dsn>`

Validation checks:
- `APPLE_IAP_ENABLED` should be `false` in environments not ready for App Store traffic.
- `APPLE_BUNDLE_ID` must exactly match the iOS app target bundle id.
- Never log full private keys or secrets. Only log "set/missing" and length checks.

## 2. App Store Connect Setup

1. In App Store Connect, open the app and configure In-App Purchases products used by backend mapping:
   - `nala_pro_monthly`
   - `nala_pro_yearly`
   - `nala_premium_monthly`
   - `nala_premium_yearly`
   - `nala_elite_monthly`
   - `nala_elite_yearly`
2. Enable App Store Server Notifications v2.
3. Register production webhook URL:
   - `POST https://stock-portfolio-api-production.up.railway.app/billing/apple-webhook`
4. Register sandbox notification URL (can use same endpoint if environment separation is handled by app config/deploy target).
5. Confirm notification types needed for subscription lifecycle are enabled:
   - `SUBSCRIBED`, `DID_RENEW`, `DID_CHANGE_RENEWAL_STATUS`, `DID_CHANGE_RENEWAL_INFO`, `EXPIRED`, `REVOKE`, `REFUND`
6. Save and send a test notification from App Store Connect.
7. Verify API logs show accepted webhook request and processing output.

## 3. Key Management

Storage:
- Store Apple private keys only in Railway environment variables / secret manager.
- Keep no unencrypted `.p8` files in repo, commits, or shared docs.

Access control:
- Limit key visibility to deploy admins only.
- Use separate keys by environment where possible.

Rotation:
1. Generate a new key in Apple Developer portal.
2. Add new key to Railway vars (`APPLE_PRIVATE_KEY`, `APPLE_KEY_ID`) without deleting old key yet.
3. Redeploy and verify login/IAP verification paths.
4. Revoke old key in Apple portal.
5. Document rotation date, operator, and rollback key id in internal ops notes.

Incident response:
- If key compromise is suspected, revoke immediately and rotate before re-enabling `APPLE_IAP_ENABLED`.

## 4. Webhook Endpoint Requirements

Endpoint:
- `POST /billing/apple-webhook`

Requirements:
- Route uses raw body parsing (`express.raw`) for signed payload handling.
- Service verifies signed payload and enforces idempotency via `AppleIAPWebhookEvent`.
- Webhook processing runs through job runner retry/DLQ pipeline for resilience.

Database prerequisites:
- `AppleIAPWebhookEvent` table present and migrated.
- Background job tables present (`BackgroundJobRun`, `DeadLetterEntry`) for retry telemetry and DLQ.

## 5. Sandbox vs Production Switch

Environment policy:
- Keep `APPLE_IAP_ENABLED=false` in dev/staging until keys + App Store Connect are confirmed.
- Production deploy: set `APPLE_IAP_ENABLED=true` only when webhook URL + products + keys are live.

Transaction handling expectations:
- Production API should process production notifications and valid signed payloads.
- Sandbox testing should be done against sandbox app/testers and corresponding Apple notification source.

Release toggle procedure:
1. Deploy with `APPLE_IAP_ENABLED=false` first.
2. Validate endpoint reachability and logs.
3. Flip `APPLE_IAP_ENABLED=true`.
4. Redeploy.
5. Execute sandbox purchase + webhook validation checklist below.

## 6. Sandbox Testing Checklist

Create test users:
1. Create/verify Sandbox Apple IDs in App Store Connect Users and Access > Sandbox.
2. Sign into sandbox account on test iOS device/simulator.

Run end-to-end tests:
1. Purchase each subscription SKU once in sandbox.
2. Validate `POST /billing/apple-verify` upgrades plan in API.
3. Validate `POST /billing/apple-restore` restores active purchase.
4. Trigger renewal/cancel/refund sandbox events and verify user plan transitions.
5. Re-send same notification payload and confirm duplicate is ignored (idempotent).
6. Confirm webhook failures produce retries and dead-letter record after max attempts.

Observability checks:
- `GET /health/status` remains healthy.
- Background job telemetry shows `apple_iap_webhook_*` attempts/success/failures.
- Dead letters (if any) include Apple webhook context for triage.

Sign-off before launch:
- All mandatory notification types observed at least once in sandbox.
- No unresolved critical dead letters for Apple webhook jobs.
- Sentry has no sustained Apple IAP error spike for the last 24 hours.
