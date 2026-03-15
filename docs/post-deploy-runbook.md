# Post-Deploy Runbook

Date: 2026-03-10
Owner: Backend On-Call
Scope: Production deploy verification and first-hour monitoring for `stock-portfolio-api`.

## 1. Immediate Health Verification (0-10 minutes)

1. Confirm Railway deploy completed for target commit.
2. Verify API health endpoints:
   - `GET /health` returns `status=ok`
   - `GET /health/status` returns healthy dependencies and job summary
3. Verify auth baseline:
   - `GET /auth/me` without session returns expected auth error (not 500)
4. Run smoke test:
   - `SMOKE_BASE_URL=https://stock-portfolio-api-production.up.railway.app npm run smoke:test`
5. Verify billing/webhook guards:
   - Stripe webhook without signature returns 400/expected guard behavior
   - Apple webhook route is reachable (`POST /billing/apple-webhook`)

If any of the above fail, stop rollout and initiate rollback/hotfix procedure.

## 2. Key Metrics to Monitor (first 60 minutes)

Application metrics:
- API p95 latency (overall + critical endpoints: `/portfolio`, `/market/quote/:ticker`, `/insights/briefing`)
- 5xx rate
- 4xx spikes that indicate auth/cookie regression
- Request throughput by route

Job health:
- Background job failure rate (`BackgroundJobRun`)
- Dead letter growth (`DeadLetterEntry`)
- Stuck/running jobs beyond threshold

Webhook health:
- Webhook failures/dedupes from `/health/webhook-metrics`
- Apple and Stripe webhook error volume in logs/Sentry

## 3. Alert Thresholds / Sentry Watchlist

Watch these Sentry alerts first:
- Unhandled exceptions in `billing.controller`, `apple-iap.service`, `auth` middleware, and `portfolio` controllers
- Spike in `JobRunner DEAD LETTERED` events
- Repeated webhook signature verification failures

Operational thresholds (trigger incident response):
- API 5xx rate > 2% for 5 consecutive minutes
- p95 latency > 1200ms for 10 minutes on critical routes
- Any continuous auth failure pattern affecting login/refresh
- More than 3 new dead letters in 15 minutes for the same job family

## 4. Hotfix / Rollback Procedure

Hotfix path (preferred for isolated issues):
1. Branch from current production commit.
2. Implement smallest safe fix.
3. Run `npx tsc --noEmit`, `npm test`, and targeted smoke checks.
4. Merge and redeploy.
5. Re-verify health + metrics.

Rollback path (for widespread regressions):
1. Identify last known good commit/tag.
2. Redeploy prior release in Railway.
3. Confirm `/health`, smoke test, and key route behavior.
4. Post status update with rollback timestamp and cause.

## 5. Incident Response Template

Use this template for production incidents:

- Incident ID:
- Start Time (UTC):
- Detected By:
- Impact Summary:
- Affected Endpoints/Services:
- Error Signature (Sentry/log excerpt):
- Current Severity (SEV1/SEV2/SEV3):
- Mitigation in Progress:
- Owner:
- Next Update ETA:

Resolution block:
- Root Cause:
- Fix Commit/Deploy:
- Recovery Time:
- Customer/User Impact Duration:
- Follow-up Actions:
- Regression Tests Added:

## 6. Completion Criteria

Post-deploy monitoring can be closed when all are true:
- No sustained error/latency alert for 60 minutes.
- No new unresolved critical Sentry issues tied to the release.
- No growing dead-letter queue for critical jobs.
- Smoke tests and health checks remain green.
