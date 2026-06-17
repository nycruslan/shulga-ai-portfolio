import { describe, expect, it } from 'vitest';
import { relativeTime } from './relative-time';

describe('relativeTime', () => {
  const now = Date.parse('2026-06-16T12:00:00Z');

  it('reads fresh timestamps as "just now"', () => {
    expect(relativeTime('2026-06-16T11:59:58Z', now)).toBe('just now');
  });

  it('formats seconds, minutes, hours, days', () => {
    expect(relativeTime('2026-06-16T11:59:30Z', now)).toBe('30s ago');
    expect(relativeTime('2026-06-16T11:45:00Z', now)).toBe('15m ago');
    expect(relativeTime('2026-06-16T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-06-14T12:00:00Z', now)).toBe('2d ago');
  });

  it('never goes negative for a near-future clock skew', () => {
    expect(relativeTime('2026-06-16T12:00:03Z', now)).toBe('just now');
  });

  it('returns empty string for an unparseable date', () => {
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});
