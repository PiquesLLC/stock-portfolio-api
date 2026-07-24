# Observability / launch-canary alerting (2026-07-23)

From an observability review. Sentry init + PII scrubbing + capture coverage were
already solid; the gaps were **silent-failure signals** — the exact precursors to
both 2026-07 outages fired events (or didn't) with no alert rule. This batch makes
those signals fire and routes them.

## SHIPPED (backend, verified 1242 tests green, tsc clean, blind-reviewed)

1. **Retention failure/cap alerting** (`snapshot-retention.service.ts`) — a generic
   retention failure was console-only (`alertOnCorruption` escalates only the
   `SQLITE_CORRUPT` sub-case). Now emits an unconditional Sentry `error`
   (`component: snapshot-retention`) on ANY failure, plus a `warning` when the run hits
   a time/chunk cap (didn't fully drain → creeping growth). This is the job that caused
   the 2026-07-14 write-stampede.
2. **Backup-staleness alert** (`db-watchdog.service.ts`) — the backup alert previously
   fired only on an *attempted-and-failed* backup; a WEDGED cron that never fires left
   yesterday's `ok` and nothing noticed. A pure, unit-tested `isBackupStale()` now rides
   the watchdog's 5-min tick and raises a throttled Sentry `error` (`component: backup`)
   when there's no backup, the last one failed, or the newest is >26h old.
3. **Auth metrics exposed in prod** (`health.routes.ts`) — `/health/auth-metrics` was
   dev-only; now registered in prod too (already `requireAuth`+`requireAdmin`), so
   OAuth/login/signup/MFA/rate-limit counters are watchable at launch.
4. **Extended the Sentry alert-rule script** (`scripts/setup-sentry-alerts.ts`) — added
   rules for the five outage-precursor components that emit events but had NO rule:
   `db-brownout`, `db-corruption`, `wal-watchdog`, `disk_guard`, `offsite_backup`, plus
   the new `snapshot-retention`.

## NEEDS YOU (operator / dashboard — not shippable from code)

- **Run the alert-rule script** once to actually create the rules in Sentry:
  `SENTRY_AUTH_TOKEN=<token> SENTRY_ORG_SLUG=<org> npx ts-node scripts/setup-sentry-alerts.ts`
  (token needs `project:write`; revoke after). Until this runs, the new events fire but
  page only if a Sentry-side default rule exists. Then, in the Sentry UI, swap the
  default email action for Slack/PagerDuty if you want paging.
- **Confirm `SNAPSHOT_RETENTION_ENABLED=true` in prod** — the retention job (and thus its
  new failure alert) is a no-op while unset.
- **External uptime monitor** on `GET /health/deep` (it already returns 503 correctly on
  a DB-write failure) — e.g. BetterStack. The endpoint is ready; the monitor is external.

## DEFERRED (backend, next observability pass)

- **Job failure-rate + dead-letter growth evaluator** — `job-runner` computes a per-job
  `alertSeverity` (warning/critical) but nothing evaluates/pages it, and dead-letter
  growth is queryable but unwatched. A scheduled evaluator mirroring the existing
  `evaluateWebhookThresholds` would `captureMessage` when a job goes critical or the
  dead-letter backlog exceeds a threshold. Additive; deferred to keep this batch tight.
- **Persistent metrics store** — auth/webhook/provider counters are in-memory and reset
  on deploy. A single `MetricCounter { name, bucketStart, value }` model flushed on the
  existing 5-min tick + on SIGTERM would make them durable. No new infra.
