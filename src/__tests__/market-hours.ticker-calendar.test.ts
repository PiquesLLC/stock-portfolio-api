import { describe, expect, it } from 'vitest';
import { WEEKEND_SESSION_PROBE, getMarketSessionForTicker, tradesOnWeekends, tradesWithinEtCalendarDay } from '../utils/market-hours';

// These two predicates decide how the candle services detect a market-data
// provider that has fallen a session behind (see fetchIntradayCandles /
// fetchHourlyCandles). They run against the REAL session logic here, unmocked,
// because a silent misclassification would degrade the charts without failing
// anything else.
describe('tradesOnWeekends', () => {
  it('is true only for markets that run through the weekend', () => {
    expect(tradesOnWeekends('BTC-USD')).toBe(true);
    expect(tradesOnWeekends('ETH-CAD')).toBe(true);
    expect(tradesOnWeekends('GC=F')).toBe(true);  // futures reopen Sunday 6 PM ET
    expect(tradesOnWeekends('CL=F')).toBe(true);
  });

  it('is false for every Monday–Friday market, including the ones whose day is offset from ET', () => {
    for (const ticker of ['AAPL', 'DE', 'SHOP.TO', 'ABX.V', 'BP.L', 'AIR.PA', 'SAP.DE', '7203.T', '0700.HK', 'BHP.AX']) {
      expect(tradesOnWeekends(ticker), ticker).toBe(false);
    }
  });

  it('pins the probe instant: Asia-Pacific still pre-open while futures already trade', () => {
    // The probe is Sunday 19:00 ET. An hour later Tokyo opens for Monday and
    // would read as a weekend market; an hour earlier futures are still shut and
    // would read as weekday-only. Both mistakes are silent, so assert the window
    // the classification depends on — against the real constant, so moving it
    // fails here rather than in production.
    const probe = WEEKEND_SESSION_PROBE;
    expect(probe.toISOString()).toBe('2025-08-17T23:00:00.000Z');
    expect(getMarketSessionForTicker('GC=F', probe)).not.toBe('CLOSED');
    for (const ticker of ['7203.T', '0700.HK', 'BHP.AX', 'AAPL', 'BP.L', 'AIR.PA', 'SHOP.TO']) {
      expect(getMarketSessionForTicker(ticker, probe), ticker).toBe('CLOSED');
    }

    // The margins themselves — one hour of slack on each side.
    expect(getMarketSessionForTicker('GC=F', new Date('2025-08-17T21:00:00Z'))).toBe('CLOSED'); // 17:00 ET, pre-reopen
    expect(getMarketSessionForTicker('7203.T', new Date('2025-08-18T00:00:00Z'))).not.toBe('CLOSED'); // 09:00 JST, Tokyo open
  });
});

describe('tradesWithinEtCalendarDay', () => {
  it('is true for markets whose session fits inside one ET date', () => {
    for (const ticker of ['AAPL', 'DE', 'SHOP.TO', 'ABX.V', 'BP.L', 'AIR.PA', 'ASML.AS', 'SAP.DE', 'ENI.MI', 'ITX.MC', 'KBC.BR']) {
      expect(tradesWithinEtCalendarDay(ticker), ticker).toBe(true);
    }
  });

  it('is false for sessions that straddle ET midnight', () => {
    // Crypto and futures run around the clock; Tokyo 09:00 JST is 20:00 ET the
    // previous day, so an ET-date filter would cut off the session's open.
    for (const ticker of ['BTC-USD', 'ETH-EUR', 'GC=F', '7203.T', '0700.HK', 'BHP.AX']) {
      expect(tradesWithinEtCalendarDay(ticker), ticker).toBe(false);
    }
  });

  it('answers false for exchanges nothing in this codebase models', () => {
    // The allowlist exists for these: symbol search returns arbitrary Yahoo
    // suffixes, and Seoul, Taipei, Shanghai, Jakarta, Singapore and Auckland all
    // trade during the ET evening. A blacklist would silently truncate them.
    for (const ticker of ['005930.KS', '2330.TW', '600519.SS', 'BBCA.JK', 'D05.SI', 'AIR.NZ', 'RELIANCE.NS']) {
      expect(tradesWithinEtCalendarDay(ticker), ticker).toBe(false);
    }
  });

  it('keeps US class shares, units and warrants on the US session', () => {
    // BRK.B carries a dot and BRK-B a hyphen, but both are US equities — an
    // allowlist that reads either as a foreign or 24/7 market would quietly
    // exclude them from the single-session filter. Both forms are live in this
    // repo (sectors.ts, the billionaire holdings in index.ts).
    for (const ticker of ['BRK.B', 'BRK.A', 'BRK-B', 'ACME.U', 'ACME.W', 'ACME.WS']) {
      expect(tradesWithinEtCalendarDay(ticker), ticker).toBe(true);
    }
    // …without letting a hyphen mean "US" in general.
    expect(tradesWithinEtCalendarDay('BTC-USD')).toBe(false);
  });

  it('does not mistake a Toronto listing for a Tokyo one', () => {
    // '.TO' ends in 'O', not 'T' — a sloppy suffix check would strip Canadian
    // tickers of their ET-day filter.
    expect(tradesWithinEtCalendarDay('SHOP.TO')).toBe(true);
    expect(tradesWithinEtCalendarDay('7203.T')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(tradesWithinEtCalendarDay('btc-usd')).toBe(false);
    expect(tradesWithinEtCalendarDay('aapl')).toBe(true);
    expect(tradesOnWeekends('btc-usd')).toBe(true);
  });
});
