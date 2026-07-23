/**
 * Deterministic portfolio-performance invariants.
 *
 * These are the financial-correctness properties that any displayed return
 * number MUST satisfy, expressed as pure functions so they can be asserted in
 * CI and used as a reference oracle against the live snapshot/leaderboard
 * pipeline.
 *
 * The central failure the audit targets: a naive return of
 * (endValue - startValue) / startValue counts external cash flows (deposits,
 * withdrawals, transfers) as investment performance. A deposit inflates the
 * number; a withdrawal deflates it. Time-weighted return (TWR) neutralises
 * flows and is the only flow-safe basis for cross-user comparison / ranking.
 *
 * Nothing here touches the DB — callers pass in a normalised series.
 */

/** One daily observation of a portfolio. */
export interface DailyMark {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /**
   * External net cash flow applied at the START of this day, before the day's
   * market move: positive = deposit / transfer-in, negative = withdrawal /
   * transfer-out. Use 0 on days with no external flow.
   */
  flow: number;
  /** End-of-day total portfolio value (market value of positions + cash). */
  value: number;
}

/**
 * Naive money-unaware return: (end - start) / start.
 *
 * This is the WRONG formula for a portfolio with cash flows and is included so
 * tests can prove the app does not use it. It treats every deposit as a gain.
 */
export function naiveReturn(marks: DailyMark[]): number | null {
  if (marks.length < 2) return null;
  const start = marks[0].value;
  const end = marks[marks.length - 1].value;
  if (start <= 0) return null;
  return (end - start) / start;
}

/**
 * Time-weighted return (TWR): chain of sub-period returns, each computed on the
 * capital base AFTER that day's external flow, so flows contribute 0% return.
 *
 * Convention: on day i the flow is applied first, then the market moves to
 * value[i]. Sub-period return_i = value[i] / (value[i-1] + flow[i]) - 1.
 * TWR = Π(1 + return_i) - 1.
 *
 * Returns null when the series is too short or a capital base is non-positive
 * (e.g. fully withdrawn / margin-negative) — callers must treat null as
 * "not computable", never as 0%.
 */
export function timeWeightedReturn(marks: DailyMark[]): number | null {
  if (marks.length < 2) return null;
  let product = 1;
  let valid = false;
  for (let i = 1; i < marks.length; i++) {
    const base = marks[i - 1].value + marks[i].flow;
    if (base <= 0) return null; // undefined sub-period; refuse to fabricate
    const subReturn = marks[i].value / base;
    if (!Number.isFinite(subReturn) || subReturn <= 0) return null;
    product *= subReturn;
    valid = true;
  }
  return valid ? product - 1 : null;
}

export interface InvariantResult {
  name: string;
  passed: boolean;
  detail: string;
}

const EPSILON = 1e-9;

/**
 * Property 1 — Deposit neutrality: inserting a pure cash deposit on a day with
 * no market move must not change TWR. A performance metric that fails this is
 * counting deposits as gains.
 */
export function checkDepositNeutrality(base: DailyMark[]): InvariantResult {
  if (base.length < 2) {
    return { name: 'deposit_neutrality', passed: false, detail: 'series too short to evaluate' };
  }
  const before = timeWeightedReturn(base);

  // Insert a deposit day (no market P/L: value rises by exactly the deposit),
  // then SCALE every later value by the capital-growth factor so the original
  // percentage market moves are preserved after the larger base. A correct TWR
  // is unchanged; a flow-counting metric is not.
  const insertAt = Math.max(1, Math.floor(base.length / 2));
  const priorValue = base[insertAt - 1].value;
  const deposit = 10_000;
  const scale = (priorValue + deposit) / priorValue;
  const withDeposit: DailyMark[] = [
    ...base.slice(0, insertAt),
    { date: base[insertAt - 1].date + 'T12:00', flow: deposit, value: priorValue + deposit },
    ...base.slice(insertAt).map((m) => ({ ...m, value: m.value * scale })),
  ];
  const after = timeWeightedReturn(withDeposit);

  if (before === null || after === null) {
    return { name: 'deposit_neutrality', passed: false, detail: 'TWR not computable on one branch' };
  }
  const passed = Math.abs(before - after) < 1e-6;
  return {
    name: 'deposit_neutrality',
    passed,
    detail: `TWR before=${(before * 100).toFixed(4)}% after inserting deposit=${(after * 100).toFixed(4)}%`,
  };
}

/**
 * Property 2 — Withdrawal is not a loss: a pure cash withdrawal on a flat day
 * must not reduce TWR.
 */
export function checkWithdrawalNeutrality(base: DailyMark[]): InvariantResult {
  if (base.length < 2) {
    return { name: 'withdrawal_neutrality', passed: false, detail: 'series too short to evaluate' };
  }
  const before = timeWeightedReturn(base);
  const insertAt = Math.max(1, Math.floor(base.length / 2));
  const priorValue = base[insertAt - 1].value;
  const withdrawal = Math.min(1_000, priorValue / 2); // never over-withdraw the base
  const scale = (priorValue - withdrawal) / priorValue;
  const withWithdrawal: DailyMark[] = [
    ...base.slice(0, insertAt),
    { date: base[insertAt - 1].date + 'T12:00', flow: -withdrawal, value: priorValue - withdrawal },
    ...base.slice(insertAt).map((m) => ({ ...m, value: m.value * scale })),
  ];
  const after = timeWeightedReturn(withWithdrawal);
  if (before === null || after === null) {
    return { name: 'withdrawal_neutrality', passed: false, detail: 'TWR not computable on one branch' };
  }
  const passed = Math.abs(before - after) < 1e-6;
  return {
    name: 'withdrawal_neutrality',
    passed,
    detail: `TWR before=${(before * 100).toFixed(4)}% after withdrawal=${(after * 100).toFixed(4)}%`,
  };
}

/**
 * Property 3 — Naive return diverges from TWR under flows. This documents (and
 * guards) the specific bug: if a pipeline's number equals naiveReturn on a
 * flow-heavy series, it is unsafe for ranking.
 */
export function naiveDivergesFromTwr(marks: DailyMark[]): InvariantResult {
  const naive = naiveReturn(marks);
  const twr = timeWeightedReturn(marks);
  const hasFlow = marks.some((m) => Math.abs(m.flow) > EPSILON);
  if (naive === null || twr === null) {
    return { name: 'naive_vs_twr', passed: false, detail: 'return not computable' };
  }
  const diverges = Math.abs(naive - twr) > 1e-6;
  return {
    name: 'naive_vs_twr',
    // On a series WITH flows we EXPECT divergence (naive is wrong). This result
    // is informational: passed=true means "the two formulas disagree as they
    // should when flows exist", confirming the test fixture actually exercises
    // the bug.
    passed: hasFlow ? diverges : !diverges,
    detail: `naive=${(naive * 100).toFixed(4)}% twr=${(twr * 100).toFixed(4)}% hasFlow=${hasFlow}`,
  };
}

/**
 * Cost-basis plausibility. User-entered cost basis is unverifiable, but a basis
 * wildly disconnected from the real traded range on the stated date is a strong
 * manipulation signal (e.g. entering a near-zero cost to fabricate a huge gain,
 * or a huge cost to fabricate a loss for tax content).
 *
 * @param enteredCost  user-supplied average cost per share
 * @param referenceLow  lowest plausible price for the security on the basis date
 *                      (e.g. that day's low, or all-time low if no date given)
 * @param referenceHigh highest plausible price (that day's high / all-time high)
 * @param tolerancePct  fractional slack around the reference band (default 0.25)
 */
export function checkCostBasisPlausible(
  enteredCost: number,
  referenceLow: number,
  referenceHigh: number,
  tolerancePct = 0.25,
): InvariantResult {
  if (!Number.isFinite(enteredCost) || enteredCost <= 0) {
    return { name: 'cost_basis_plausible', passed: false, detail: 'entered cost non-positive/invalid' };
  }
  if (!Number.isFinite(referenceLow) || !Number.isFinite(referenceHigh) || referenceLow <= 0 || referenceHigh < referenceLow) {
    // No usable reference band → cannot judge; treat as "unverifiable", not a pass.
    return { name: 'cost_basis_plausible', passed: false, detail: 'no usable reference price band' };
  }
  const lo = referenceLow * (1 - tolerancePct);
  const hi = referenceHigh * (1 + tolerancePct);
  const passed = enteredCost >= lo && enteredCost <= hi;
  return {
    name: 'cost_basis_plausible',
    passed,
    detail: `entered=${enteredCost} band=[${lo.toFixed(2)}, ${hi.toFixed(2)}]`,
  };
}

/** Run the flow-invariance battery over one fixture series. */
export function runInvariantBattery(marks: DailyMark[]): InvariantResult[] {
  return [
    checkDepositNeutrality(marks),
    checkWithdrawalNeutrality(marks),
    naiveDivergesFromTwr(marks),
  ];
}
