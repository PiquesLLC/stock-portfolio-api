# SQLite write-contention load/soak test — 2026-07-23

Harness: `scripts/loadtest-sqlite.mjs` (reproducible). Runs against a **throwaway
temp DB** with the exact prod config (`PRAGMA journal_mode=WAL`,
`busy_timeout=5000`, `auto_vacuum=INCREMENTAL`) and the real write pattern
(per-user `PortfolioSnapshot` insert + batched `HoldingSnapshot` insert, all
through ONE shared libsql connection — the true prod model).

> **Caveat, read first.** These numbers are from a local NVMe/CPU. Railway's
> volume is network-attached and materially slower, so **absolute throughput will
> be lower in prod** — do not read the local wr/s as prod capacity. What transfers
> is the *shape* of contention: where errors/latency begin and whether the July
> retention fix holds.

## Results

**Phase A — single shared connection, ramping in-flight depth (prod scheduler = 8):**

| depth | ok | busy | wr/s | p50 ms | p95 ms | p99 ms | max ms |
|------:|---:|-----:|-----:|-------:|-------:|-------:|-------:|
| 1   | 3412 | 0 | 682 | 1.3 | 2.0 | 5.8 | 7.9 |
| 8   | 3024 | 0 | 605 | 12.2 | 18.0 | 19.1 | 22.5 |
| 16  | 2992 | 0 | 598 | 27.6 | 31.2 | 31.8 | 34.0 |
| 32  | 3424 | 0 | 685 | 46.3 | 55.8 | 61.4 | 63.0 |
| 64  | 3520 | 0 | 704 | 89.9 | 107.8 | 116.1 | 118.5 |
| 128 | 3328 | 0 | 666 | 196.9 | 224.7 | 229.4 | 233.0 |

Throughput is **flat (~600–700 snapshots/s) regardless of concurrency**; latency
grows **linearly** with depth. That is the entire SQLite story: one serial writer,
so concurrency buys queue depth, not throughput. (Each snapshot = 2 writes, so
~1360 writes/s locally.) Zero `SQLITE_BUSY` — a single connection never contends
with itself.

**Phase B — two independent connections writing at once (multi-conn contention):**

| depth/conn | ok | busy (P1008) | p99 |
|-----------:|---:|-------------:|-----|
| 4  | 2838 | 0 | ~20 ms |
| 8  | 2880 | 0 | ~34 ms |
| 16 | 2816 | 0 | ~66 ms |
| 32 | 2816 | 0 | ~124 ms |

Even at 64 concurrent writers across two connections, **zero P1008** — `busy_timeout=5000`
converts lock contention into *latency*, not errors, up to this load. On the slower
Railway volume the same concurrency reaches the 5 s ceiling sooner, at which point
writes start throwing P1008 and the job-runner **brownout breaker** trips (suspends
telemetry writes for 60 s) — that breaker tripping is the prod early-warning signal.

**Phase C — retention fix validation (the 2026-07-14 outage cause):** snapshot
writers steady at prod concurrency 8 on the shared connection while a
retention-style bulk delete runs on the *same* connection.

| retention mode | snapshot p99 | snapshot max | rows deleted |
|---|---|---|---|
| **GOOD** — chunked (1000) + 300 ms yield | 20.0 ms | 48 ms | 120,000 |
| **BAD** — single unbounded `DELETE` | 20.9 ms | **256 ms** | 60,000 |

The chunk-and-yield fix keeps the connection available (max 48 ms). The unbounded
delete head-of-line-blocks it (256 ms locally for 60k rows). That scales ~linearly
in row count and inversely with disk speed: at the incident's real volume (645k
`PortfolioSnapshot` + 3.2M `HoldingSnapshot`) on Railway's slower disk, the single
delete becomes **minutes** of frozen writes — exactly the observed outage. **The
July fix demonstrably prevents it; the pre-fix shape reproduces it.**

## Conclusions

1. **Structural ceiling = one serial writer.** Every app write (snapshot job,
   snapshot-on-read, job-runner telemetry, leaderboard) shares one connection's
   serial budget. As users grow, aggregate write demand approaches that budget and
   latency rises for *everyone* — not a cliff, a gradual degradation.
2. **The retention/backup fixes hold under load.** Chunk+yield keeps writers
   flowing; the separate-connection `VACUUM INTO` backup does not error writers.
   The remaining watch-item is WAL growth pinned by a long backup read (the
   `db-watchdog` service already alerts on this).
3. **`busy_timeout` masks contention as latency** until a single writer holds the
   lock > 5 s; then P1008 cascades and the brownout breaker trips.

## Recommendations

- **SQLite is adequate for a small, gated beta** (low hundreds of active users)
  **with monitoring**: alert on any brownout-breaker trip, P1008 count, and the
  `db-watchdog` WAL-pin warning. The write-stampede proved the ceiling was crossed
  at just 29 users *when a long-writer held the connection* — that specific cause
  is fixed, but the single-writer structural ceiling is not.
- **The real scale unlock is the Postgres migration** (recommendation #1 —
  true concurrent writers, no single-connection ceiling). This test is the
  quantitative argument for prioritizing it before broad launch.
- **Before opening broad signups, re-run this harness against a Railway staging
  instance** (same volume class as prod) for an absolute capacity number — local
  disk can't give one.
- Consider making the two snapshot writes (`PortfolioSnapshot` + `HoldingSnapshot`)
  a single `$transaction` — today they're non-atomic and interleave with every
  other writer, which widens the contention window.
