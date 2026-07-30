import { describe, expect, it } from 'vitest';
import { captureTone, fmtBarTime, fmtPx, indexOnOrAfter, indexOnOrBefore } from './TradeLifecycle';
import { pickInterval } from '../../pages/admin/api/trade-chart';

describe('date index lookup (marker placement)', () => {
  const days = ['2026-07-01', '2026-07-02', '2026-07-06', '2026-07-07'];
  it('entry snaps forward over a weekend gap', () => {
    expect(indexOnOrAfter(days, '2026-07-04')).toBe(2);
  });
  it('exit snaps backward', () => {
    expect(indexOnOrBefore(days, '2026-07-05')).toBe(1);
  });
  it('exact hits land on the bar', () => {
    expect(indexOnOrAfter(days, '2026-07-02')).toBe(1);
    expect(indexOnOrBefore(days, '2026-07-02')).toBe(1);
  });
  it('out-of-range and missing dates return -1', () => {
    expect(indexOnOrAfter(days, '2026-08-01')).toBe(-1);
    expect(indexOnOrBefore(days, '2026-06-01')).toBe(-1);
    expect(indexOnOrAfter(days, null)).toBe(-1);
  });
  it('works on numeric timestamps too (intraday bar matching)', () => {
    const ts = [1000, 2000, 3000, 4000];
    expect(indexOnOrAfter(ts, 2500)).toBe(2); // first bar at/after the fill
    expect(indexOnOrBefore(ts, 2500)).toBe(1); // last bar at/before the close
    expect(indexOnOrAfter(ts, 2000)).toBe(1); // exact
    expect(indexOnOrBefore(ts, 500)).toBe(-1);
  });
});

describe('fmtBarTime — axis + readout labels', () => {
  const t = Date.parse('2026-07-30T14:05:00Z') / 1000;
  it('shows the clock on intraday bars', () => {
    expect(fmtBarTime(t, true)).toBe('07-30 14:05');
  });
  it('shows the date on daily bars', () => {
    expect(fmtBarTime(t, false)).toBe('2026-07-30');
  });
});

describe('pickInterval — adaptive granularity', () => {
  it('uses 5-minute bars for a fresh same-day trade (the playground case)', () => {
    expect(pickInterval(0.2, 0).interval).toBe('5m'); // opened and closed today
  });
  it('uses hourly for a multi-day hold', () => {
    expect(pickInterval(5, 5).interval).toBe('60m');
  });
  it('uses daily for a swing trade', () => {
    expect(pickInterval(30, 30).interval).toBe('1d');
  });
  it('falls back off intraday once Yahoo no longer serves it', () => {
    expect(pickInterval(1, 120).interval).toBe('60m'); // same-day but 120d old → 5m rolled off
    expect(pickInterval(1, 900).interval).toBe('1d'); // and 900d old → hourly gone too
  });
});

describe('captureTone — the round-trip red flag', () => {
  it('flags a real gain mostly given back', () => {
    expect(captureTone(21.5, 12)).toBe('text-rose-300'); // TH-style: +21.5% peak, kept 12%
    expect(captureTone(6.1, -56)).toBe('text-rose-300'); // round-tripped to a loss
  });
  it('praises exits that kept most of the peak', () => {
    expect(captureTone(16.2, 100)).toBe('text-emerald-300');
    expect(captureTone(10, 65)).toBe('text-emerald-300');
  });
  it('stays neutral in the typical trailing band', () => {
    expect(captureTone(20, 55)).toBe('text-text-muted');
  });
  it('small peaks never glow red unless they went negative', () => {
    expect(captureTone(6, 10)).toBe('text-text-muted');
  });
  it('missing data is subtle', () => {
    expect(captureTone(null, null)).toBe('text-text-subtle');
    expect(captureTone(12, null)).toBe('text-text-subtle');
  });
});

describe('fmtPx — marker/readout price format', () => {
  it('keeps 4 decimals on alt-coin prices, 2 on stocks', () => {
    expect(fmtPx(0.1009)).toBe('$0.1009');
    expect(fmtPx(152.6512)).toBe('$152.65');
  });
  it('groups thousands', () => {
    expect(fmtPx(65188.33)).toBe('$65,188.33');
  });
  it('dashes on missing/invalid values', () => {
    expect(fmtPx(null)).toBe('—');
    expect(fmtPx(Number.NaN)).toBe('—');
  });
});
