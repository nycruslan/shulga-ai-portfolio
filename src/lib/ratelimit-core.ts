// Env-free rate-limit primitives, unit-testable without the Astro runtime.
// The Upstash-backed factory lives in ratelimit.ts (which imports astro:env).

export interface RateLimiter {
  limit(key: string): Promise<{ success: boolean }>;
}

// Minimal in-process sliding window: keeps recent hit timestamps per key and
// prunes on read. Bounded so a flood of distinct keys can't grow it unbounded.
export class MemoryLimiter implements RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly limitCount: number,
    private readonly windowMs: number,
    private readonly maxKeys = 5000,
  ) {}
  async limit(key: string): Promise<{ success: boolean }> {
    const cutoff = Date.now() - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    // Refresh insertion order so the map doubles as a bounded LRU.
    this.hits.delete(key);
    if (recent.length >= this.limitCount) {
      this.hits.set(key, recent);
      return { success: false };
    }
    recent.push(Date.now());
    this.hits.set(key, recent);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
    return { success: true };
  }
}

// The caller's bucket key. Use only the platform-provided address; do NOT fall
// back to the client-controlled X-Forwarded-For header (rotating it would mint
// a fresh bucket per request). Without a trusted address, everyone shares one
// bucket, which throttles conservatively rather than failing open.
export function clientIp(clientAddress?: string): string {
  return clientAddress || 'shared';
}
