import { describe, expect, it } from 'vitest';
import {
  captureTone,
  indexOnOrAfter,
  indexOnOrBefore,
  linePath,
  niceTicks,
} from './TradeLifecycle';

describe('niceTicks', () => {
  it('produces clean steps covering the range', () => {
    const ticks = niceTicks(93.2, 118.7);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.length).toBeLessThanOrEqual(4);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(93.2);
      expect(t).toBeLessThanOrEqual(118.7);
    }
  });
  it('handles sub-dollar crypto ranges', () => {
    const ticks = niceTicks(0.088, 0.112);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.every((t) => t > 0.08 && t < 0.115)).toBe(true);
  });
  it('is empty on degenerate input', () => {
    expect(niceTicks(5, 5)).toEqual([]);
    expect(niceTicks(NaN, 10)).toEqual([]);
    expect(niceTicks(10, 5)).toEqual([]);
  });
});

describe('linePath', () => {
  it('moves then lines', () => {
    expect(linePath([0, 10, 20], [5, 6, 7])).toBe('M 0.0 5.0 L 10.0 6.0 L 20.0 7.0');
  });
});

describe('date index lookup', () => {
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
  it('small peaks never glow red (noise, not signal)', () => {
    expect(captureTone(6, 10)).toBe('text-text-muted');
  });
  it('missing data is subtle', () => {
    expect(captureTone(null, null)).toBe('text-text-subtle');
    expect(captureTone(12, null)).toBe('text-text-subtle');
  });
});
