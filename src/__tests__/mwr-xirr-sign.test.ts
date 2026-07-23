import { describe, it, expect } from 'vitest';
import { calculateXIRR } from '../utils/finance-math';
import { buildXirrFlows } from '../services/benchmark.service';

// Regression for audit finding C1 (2026-07-12): benchmark.service.ts reused the
// TWR-signed cashflow array (deposit = +amount) verbatim as the XIRR intermediate
// flows, where the XIRR convention requires a deposit to be NEGATIVE (money
// invested). A deposit-only account then reported a large positive money-weighted
// return instead of ~0%.
//
// These drive the ACTUAL fixed construction (buildXirrFlows) with TWR-signed
// inputs, so reverting the negation in benchmark.service.ts fails this suite.
describe('MWR/XIRR sign convention (C1)', () => {
  const day = (n: number) => new Date(2026, 0, 1 + n);

  it('deposit-only portfolio has ~0% MWR through the real buildXirrFlows path', () => {
    // Start $1,000; deposit $1,000 mid-window; end $2,000 — pure deposit, no gain.
    // Inputs are TWR-signed (deposit = +amount), exactly as benchmark.service passes them.
    const snapshotPoints = [
      { date: day(0), value: 1000 },
      { date: day(365), value: 2000 },
    ];
    const cashflows = [{ date: day(182), amount: 1000 }]; // TWR sign: deposit = +
    const xirr = calculateXIRR(buildXirrFlows(snapshotPoints, cashflows));
    expect(xirr).not.toBeNull();
    expect(Math.abs(xirr!)).toBeLessThan(0.02); // ~0% — deposit is not counted as return
  });

  it('a withdrawal-only portfolio is likewise ~0% (both signs handled)', () => {
    // Start $2,000; withdraw $1,000 mid-window; end $1,000 — no gain/loss.
    const snapshotPoints = [
      { date: day(0), value: 2000 },
      { date: day(365), value: 1000 },
    ];
    const cashflows = [{ date: day(182), amount: -1000 }]; // TWR sign: withdrawal = −
    const xirr = calculateXIRR(buildXirrFlows(snapshotPoints, cashflows));
    expect(xirr).not.toBeNull();
    expect(Math.abs(xirr!)).toBeLessThan(0.02);
  });

  it('the pre-fix (un-negated) construction inflates MWR — reproduces the bug', () => {
    // Feeding TWR-signed flows straight to XIRR (the pre-fix behavior).
    const buggyFlows = [
      { date: day(0), amount: -1000 },
      { date: day(182), amount: 1000 }, // deposit as +amount = the C1 bug
      { date: day(365), amount: 2000 },
    ];
    const xirr = calculateXIRR(buggyFlows);
    expect(xirr).not.toBeNull();
    expect(xirr!).toBeGreaterThan(0.5); // large positive out of thin air
  });

  it('a genuine gain still reports a positive MWR (no over-correction)', () => {
    // Start $1,000, no flows, end $1,100 → ~10%.
    const snapshotPoints = [
      { date: day(0), value: 1000 },
      { date: day(365), value: 1100 },
    ];
    const xirr = calculateXIRR(buildXirrFlows(snapshotPoints, []));
    expect(xirr).not.toBeNull();
    expect(xirr!).toBeGreaterThan(0.08);
    expect(xirr!).toBeLessThan(0.12);
  });
});
