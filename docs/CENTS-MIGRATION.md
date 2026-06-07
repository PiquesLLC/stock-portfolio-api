# Cents Migration — Float → Int minor units (money only)

_Status: design complete; execution staged. Owner: do not skip Stage 0._

## Why this is delicate (read first)

1. **Auto-apply on deploy.** `package.json` → `"start": "prisma migrate deploy && node dist/index.js"`. Any committed migration runs against **prod SQLite automatically** on the next deploy. `git push` of a migration *is* the prod money rewrite. There is **no off-site backup** today, so a wrong transform is **irreversible**.
2. **"Float" means four different things — only one becomes cents:**
   - **Money amounts** → migrate to `Int` cents.
   - **Share quantities** (`shares`) → fractional (e.g. 1.5); **must stay Float/Decimal**.
   - **Per-share prices** (`price`, `averageCost`, `targetPrice`, `week52*`) → fractional, sub-cent possible; **stay Float** (cents would lose precision).
   - **Percentages / rates / beta / thresholds** → not money; **stay Float**.

   A naive `s/Float/Int/` corrupts shares and prices. Classification below is the spec.

## Field classification

### → `Int` cents (money amounts)
- **Portfolio**: `cashBalance`, `marginDebt`
- **UserSettings**: `cashBalance`, `marginDebt`, `ytdBaselineValue`, `baselineTotalValue`, `baselineCashBalance`, `brokerLifetimeDeposits`, `brokerLifetimeWithdrawals`, `brokerLifetimeValue`, `ytdStartEquity`, `ytdNetContributions`, `annualSalary`
- **Settings** (legacy global singleton — confirm still read before migrating): same set
- **PortfolioSnapshot**: `totalValue`, `cashBalance`, `dailyPL`, `totalPL`, `netEquity` _(NOT `dailyPLPercent`, `totalPLPercent`)_
- **SnapshotHolding**: `marketValue`, `dayPL` _(NOT `shares`, `price`, `dayPLPercent`)_
- **Transaction**: `amount`, `fees`
- **DividendCredit**: `amountGross` · **DripTransaction**: `totalAmount` · **CostBasisLot**: `totalCost` · **Goal**: `targetValue`, `currentValue`, `monthlyContribution`

### Stays Float (do NOT touch)
- All `shares`, `averageCost`, `price`, `pricePerShare`, `costPerShare`, `optionStrike`, `targetPrice`, `triggerPrice`, `currentPrice`, `thresholdPrice`, `week52High/Low`, analyst `target*`, `amountPerShare` — quantities & per-share prices.
- All `*Percent`, `twrPct`, `beta`, `eps`, `annualDividend`, `cashInterestRate`, `priceSpikePct`, `threshold`, `costUsdEstimate`.

### Deferred / borderline (leave as Float in v1; revisit)
- `Dividend.amountPerShare` (per-share), `CongressTrade.amountFrom/To` (display ranges), `CreatorWealth.baseNetWorthUsd`/`computedNetWorth` (display-only). Migrating these adds surface for little money-safety gain; do them in a later pass.

## Safe rollout — parallel change (expand → migrate → contract)

Non-destructive: originals are preserved until parity is proven AND a real backup exists.

- **Stage 0 — Backup (PREREQUISITE).** Off-site dump of prod SQLite to R2 (needs the R2 bucket+token). Until that exists, Stage 1's preserved Float columns are the only recovery path — acceptable for Stage 1, **mandatory before Stage 3**.
- **Stage 1 — EXPAND (additive; safe to deploy alone).** Add `<field>Cents Int?` beside each money field. Backfill `Cents = CAST(ROUND(<float> * 100) AS INTEGER)`. Keep the Float columns. No behavior change → safe even on prod. Verify a recon query: `COUNT(*) WHERE <field>Cents <> CAST(ROUND(<float>*100) AS INT)` must be 0.
- **Stage 2 — DUAL-WRITE + read-from-cents (the big code change).** Writers set both columns; readers/services compute in cents; convert to dollars only at the API boundary (or migrate the API contract too, coordinated with UI). Ship behind the preserved Float columns, so any bug is data-recoverable. Add a startup/cron parity check that alarms on `Cents != round(Float*100)` drift.
- **Stage 3 — CONTRACT (irreversible; gated).** After N days of zero parity drift **and** a verified off-site backup: drop the Float columns, make `Cents` non-null. This is the only irreversible step.

## Rollback
- Stage 1: drop the `*Cents` columns (Float untouched). Zero risk.
- Stage 2: revert code to read Float; `*Cents` columns are harmless.
- Stage 3: irreversible → that's why it's gated on parity + backup.

## Hard gate (non-negotiable)
Do **not** `git push` any stage until it is (a) applied + verified on a **copy of the prod DB**, and (b) for Stage 3, an **off-site backup exists** — because `start` auto-runs `migrate deploy` and there is no undo on prod.

## Test plan
- Unit: cents helpers (`toCents`, `fromCents`, rounding) + every migrated service's money math.
- Migration: apply Stage 1 to a restored copy of prod data; run the recon query → expect 0 drift.
- Parity cron: dual-write window monitored for drift before Stage 3.
