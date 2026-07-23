import { describe, expect, it } from 'vitest';
import { captureTone, fmtPx, indexOnOrAfter, indexOnOrBefore } from './TradeLifecycle';

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
