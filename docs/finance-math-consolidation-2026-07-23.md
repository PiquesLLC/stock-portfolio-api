# Financial-math consolidation — 2026-07-23

An independent audit flagged ≥5 portfolio-value implementations and ≥6
re-implementations of volatility/drawdown/beta that don't use the canonical
`src/utils/finance-math.ts`. This is the ledger of what was consolidated and what
is deliberately **left for a decision** because it would change a user-visible
number. (The UI repo has zero portfolio/risk math — all of this is API-side.)

## SHIPPED — zero-delta (behavior-preserving) + test lock

1. **Golden-test suite freezing the canonical library** —
   `src/__tests__/finance-math.golden.test.ts` (28 cases). Locks the exact current
   behavior of `calculateTWR`, `calculateXIRR`, `calculateCorrelation`,
   `calculateBeta`, `annualizeReturn`, `annualizedVolatility` (SAMPLE stddev ÷(n-1)
   × √252), `sharpeRatio` (RISK_FREE_RATE=0), `maxDrawdown` (positive, peak>0 guard),
   plus the anti-cheat heuristics and the data gates (<20 correlation, <10 beta/vol).
   This is the safety net: any future consolidation that moves a number now breaks a
   test on purpose rather than silently.
2. **`insights.service.ts` correlation dedup** — the local `calculateCorrelation`
   was **byte-identical** to the canonical; deleted and routed through
   `finance-math.calculateCorrelation`. Zero delta.
3. **`portfolioIntelligence.service.ts` beta dedup** — the inline `Cov/Var` beta was
   the same formula; routed through `finance-math.calculateBeta`. Provably zero-delta
   because the upstream guard requires `minLen >= MIN_BETA_DAYS (60)`, so the
   canonical's `<10` gate can never fire differently, and the arrays are already
   equal-length. Alpha computation preserved.

## FLAGGED — behavior-changing, needs your sign-off (each is a number users see)

These are the actual inconsistencies. Each is a one-file change gated behind a new
golden test asserting the delta. Recommendation in **bold**.

1. **Leaderboard volatility uses POPULATION stddev (÷n)** — `leaderboard.service.ts:364`
   — everywhere else uses SAMPLE (÷n-1). Consolidating raises reported vol slightly →
   lowers anti-cheat Sharpe → *fewer* cheat flags. **Fix (route to canonical); it's
   the more-correct statistic — but it changes leaderboard anti-cheat sensitivity, so
   your call.**
2. **`utils/math.ts` drawdown is NEGATIVE and unguarded** (`:98,:120`) vs canonical
   positive + peak>0 guard; its `calculateDailyReturns` (`:59`) also allows a negative
   denominator (`!== 0`) vs the canonical `> 0`. Migrate callers to canonical, then
   delete the file (keep `ema`/`linearRegressionSlope`, which have no canonical
   equivalent). **Fix — the unguarded version returns garbage on a non-positive peak
   (margin accounts); low real-world incidence but strictly a bug.**
3. **`insights` volatility gate is <20, canonical is <10** (`insights.service.ts:124`)
   — routing would emit non-null vol/Sharpe on 10–19-point histories where insights
   currently shows nothing. **Pick one gate app-wide; recommend the canonical <10 for
   consistency, but it surfaces metrics slightly earlier.**
4. **`insights` maxDrawdown has no peak>0 guard** (`:137`, plus `calculateMaxDrawdownWithDates`
   at `:206`) and **`alert.service.ts:200` drawdown is unguarded ×100** — same class as #2.
   **Fix (route to `maxDrawdown()`, keep the ×100/label/dates wrappers).**
5. **Portfolio-value: options ×100 is applied inconsistently.** `portfolio.service.ts:458`
   values options `price*shares*100`; `leaderboard.service.ts` and
   `anomaly-detection.service.ts` use bare `shares*price` (options undervalued 100×).
   **Verify whether those surfaces should include options at all, then unify — widest
   blast radius, do it last behind an extended `portfolio-valuation.service.test.ts`
   with an options case.**
6. **CAGR basis differs: `insights.service.ts:1179` annualizes on 252, `projection`/
   canonical on 365** (~1.44× exponent difference). **Do NOT blindly merge — they feed
   different inputs; decide the intended basis per surface.**
7. **Uncatalogued per-stock beta in `polygon-screener.service.ts:108`** — computes
   stock-vs-SPY beta with its own date-map alignment, a **min-50-point** gate, and
   **rounds to 2 decimals** (`Math.round(beta*100)/100`). Behavior-changing vs the
   canonical (different gate, no rounding, date-map vs tail alignment), so NOT a
   zero-delta dedup. **Route the core Cov/Var through `calculateBeta`, preserving the
   50-point gate + 2dp rounding as wrappers, behind a new test.**

## Minor robustness note (not user-facing)

The canonical zero-variance guards (`calculateCorrelation` `denom === 0`,
`calculateBeta` `varianceB === 0`) only catch *exactly* zero. A truly-flat series
built from an FP-inexact constant (e.g. all `0.01`) leaves sub-ulp noise that slips
past the guard and returns garbage (correlation → 1, beta → noise). Real return
series are never perfectly flat, so impact is negligible, but a `< epsilon` guard
would be more robust. Cheap follow-up.

## Consolidation order when you greenlight the flagged set (safest first)

1. `utils/math.ts` callers → canonical, then delete file (keep ema/linReg) — item #2/#4.
2. `alert.checkDrawdown` guard — item #4.
3. Leaderboard population→sample vol — item #1.
4. Insights vol gate 20→10 — item #3.
5. `polygon-screener` beta core → canonical (keep gate + rounding wrappers) — item #7.
6. Portfolio-value options-×100 unification, last, behind an extended valuation test — item #5.
7. CAGR basis decision — item #6.
