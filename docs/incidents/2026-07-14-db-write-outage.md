# Incident: DB write-timeout storm → user-facing outage (2026-07-14)

**Status:** resolved (self-recovered ~17:00 UTC; permanent fixes deployed same day)
**User impact:** app showed full-screen "Connection Error" from ~13:30 UTC (market open, 9:30 ET) for logged-in users whose portfolio bootstrap failed; degraded windows from 12:15 UTC. Reads/static were served throughout; DB **writes** were timing out.
**Duration:** ~4h45m of write brownout (12:15–17:00 UTC), user-visible from at least 13:31 UTC.

## Timeline (UTC)

| Time | Event |
|---|---|
| Jul 13 12:11 | Weekly Bottlenecks content commit auto-deploys; process boot anchors every `setInterval(24h)` maintenance timer to ~12:12 UTC |
| Jul 14 12:12 | 24h timers fire together: daily backup, snapshot retention, analyst/economic/international refreshes, backfills |
| Jul 14 12:12–12:14 | Backup: `wal_checkpoint(TRUNCATE)` (freed 247MB WAL — the only reason the copy fit on the 79%-full volume), then **synchronous `fs.copyFileSync` of the 1.24GB DB froze the Node event loop** for the copy duration |
| Jul 14 12:15–12:16 | Post-freeze thundering herd: piled-up timers + requests hit the single serialized libsql connection at once → mass Prisma **P1008 "Operation has timed out" / SocketTimeout** on every write (`backgroundJobRun.create`, `deadLetterEntry.create`, `aVDailyUsage.create`, …) |
| Jul 14 12:16→17:00 | Self-sustaining storm: every job tick burned 4–7 doomed 5s telemetry writes (run record, dead letter, idempotency) without running the job; WAL ballooned to **258MB** (checkpoint starvation — a pinned reader); every write slower → more timeouts |
| Jul 14 13:30 | Market open: `GET /portfolio` **awaits `createSnapshotIfNeeded` (a DB write) inline** → portfolio bootstrap fails/hangs → "Connection Error" screen (screenshot 9:31 ET). Client made it worse: 5s polls with no timeout/single-flight stacked hanging requests |
| Jul 14 ~17:00 | Pinned WAL reader released (connection recycle); checkpoint succeeded; writes recovered; system self-healed |
| Jul 14 evening | Permanent fixes deployed (API `b57e03c`, UI `998f124`) |

**Why nothing alerted:** `/health` (BetterStack) does no DB probe — it returned 200 the whole time. Sentry alerting existed only for `SQLITE_CORRUPT`; P1008 timeout storms were invisible. Railway edge logged **zero 5xx** (requests eventually completed or died client-side), and HTTP edge logs retain only ~15 minutes.

## Root cause

1. **Boot-anchored maintenance scheduling**: all "daily" jobs used `setTimeout(30s)/setInterval(24h)` from process start, so the entire maintenance fleet fired in the same minute — a minute chosen by deploy timing (Monday's 12:11 UTC content deploy → 12:12 UTC daily, pre-market).
2. **Event-loop-freezing backup copy** (`fs.copyFileSync`, 1.24GB) as the stampede's detonator.
3. **Telemetry write amplification in the job runner** (no breaker) as the sustainer, plus **WAL checkpoint starvation** (258MB high-water) keeping write latency above the ~5s timeout.
4. **Write-on-read coupling** (`GET /portfolio` awaiting a snapshot write) as the user-impact bridge.

## Fixes (deployed 2026-07-14)

- `VACUUM INTO` on a dedicated connection replaces the sync copy; real disk-requirement guard (~DB size + margin) with WAL-truncate reclaim and CRITICAL alert on skip; post-snapshot passive WAL drain; partial-file cleanup.
- `scheduleDailyAtUTC`: backup **07:10 UTC**, retention **06:40 UTC**, offsite ship **08:10 UTC** — fixed off-peak hours, never overlapping, deploy-time-independent.
- Job-runner **DB brownout breaker**: on observed write timeouts, telemetry writes stand down (jobs still run — previously a timed-out run-record create consumed the attempt and the job never executed); one throttled Sentry event per storm.
- **WAL watchdog**: passive checkpoint every 5min; Sentry alert when un-backfilled frames persist (checkpoint starvation detected in minutes, not hours).
- **`GET /health/deep`**: real DB read+write probe (3s deadline) → 503 when writes are down. Point BetterStack here. `/health` stays pure liveness (Railway deploy gate must not block deploying a fix mid-brownout).
- `GET /portfolio` snapshot write is fire-and-forget — write brownouts can't take down reads.
- Polygon fundamentals no-filings sentinel bumps `lastFetchedAt` on rows holding a real overview — kills the infinite `holding-stale` re-pick loop (BABA burned a Polygon call + DB writes every ~30s).
- UI: single-flight polling, 20s request deadline, failure backoff (10s→60s) with self-healing reset.

## Runbook: NalaAI is down

1. `curl -sS https://www.nalaai.com/health` and `.../health/deep` (also the Railway-direct URL). `deep` 503 with `writeOk:false` → DB write brownout; `wal.lastCheckpoint` shows starvation (`log` ≫ `checkpointed`).
2. `railway logs -s stock-portfolio-api -e production -d -n 200` — look for `P1008/Operation has timed out/SocketTimeout` (brownout), `[DB] BROWNOUT`, `[WalWatchdog]`, `[Backup] CRITICAL`, `SQLITE_CORRUPT` (different playbook — see rebuild-and-swap runbook).
3. Historical windows: `railway logs ... --since <ISO> --until <ISO>` (500-line cap per fetch — narrow the window). Railway HTTP logs (`--http`) only go back ~15min.
4. Check `railway deployment list` — did a deploy just happen? Rollback = Railway dashboard → previous deployment → Redeploy (or `railway redeploy` — run it bare, never piped).
5. Disk: `/health` reports it; `railway ssh -- sh -c "true; df -h /data; ls -la /data"` (note the `true;` gotcha). WAL frozen large + `deep` failing = stuck reader: a restart (`railway redeploy`) clears it — deploy-safe.
6. If writes are down but reads are fine: it will often self-heal when the pinned reader releases; the brownout breaker + watchdog now bound the blast radius. Restart if user-facing and not recovering within ~10min.
7. Verify recovery: `/health/deep` 200, `[Snapshot Scheduler] N/N snapshots written` in logs, error-line count near zero.

## Follow-ups / remaining risks

- **/data volume is critically tight** (79%): live DB 1.24GB + daily backup 1.24GB + corrupt-DB archive 0.90GB on 4.4GB. Tomorrow's backup needs ~1.31GB free. Mitigations: archive moved off-box (done same-day if verified) and/or **grow volume 5→10GB in the Railway dashboard (recommended, Jon)**.
- **BetterStack monitor URL must be switched to `/health/deep`** (Jon — dashboard).
- The ~dozen other daily jobs are still boot-anchored as a cluster (individually light; backup+retention were the heavy hitters). Consider migrating them to `scheduleDailyAtUTC` with staggered minutes.
- Host-level CPU pressure on this Railway host is chronically high (PSI `some` ≈ 99.7%); the SQLite v2 Postgres migration remains the structural fix.
- R2 offsite backups still unconfigured (needs Cloudflare creds).
