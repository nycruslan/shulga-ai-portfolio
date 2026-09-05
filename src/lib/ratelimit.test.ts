import { describe, expect, it, vi, afterEach } from 'vitest';
import { MemoryLimiter, clientIp } from './ratelimit-core';

describe('MemoryLimiter', () => {
  afterEach(() => vi.useRealTimers());

  it('allows up to the limit, then blocks, per key', async () => {
    const rl = new MemoryLimiter(3, 60_000);
    expect((await rl.limit('a')).success).toBe(true);
    expect((await rl.limit('a')).success).toBe(true);
    expect((await rl.limit('a')).success).toBe(true);
    expect((await rl.limit('a')).success).toBe(false); // 4th over the cap
    // A different key has its own bucket.
    expect((await rl.limit('b')).success).toBe(true);
  });

  it('lets hits back in once they age out of the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const rl = new MemoryLimiter(2, 1000);
    expect((await rl.limit('a')).success).toBe(true);
    expect((await rl.limit('a')).success).toBe(true);
    expect((await rl.limit('a')).success).toBe(false);
    vi.setSystemTime(1001); // both prior hits now older than the 1s window
    expect((await rl.limit('a')).success).toBe(true);
  });

  it('bounds the number of keys with least-recently-used eviction', async () => {
    const rl = new MemoryLimiter(1, 60_000, 2);
    expect((await rl.limit('a')).success).toBe(true);
    expect((await rl.limit('a')).success).toBe(false);
    expect((await rl.limit('b')).success).toBe(true);
    expect((await rl.limit('c')).success).toBe(true);
    expect((await rl.limit('a')).success).toBe(true);
  });
});

describe('clientIp', () => {
  it('uses the platform address when present', () => {
    expect(clientIp('203.0.113.7')).toBe('203.0.113.7');
  });
  it('never trusts a client-supplied fallback: shares one bucket instead', () => {
    expect(clientIp(undefined)).toBe('shared');
    expect(clientIp('')).toBe('shared');
  });
});
