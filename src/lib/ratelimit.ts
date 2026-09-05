import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } from 'astro:env/server';
import type { RateLimiter } from './ratelimit-core';

// Paid public endpoints require one distributed safety gate in production.
// A per-instance fallback looks safe but multiplies its allowance whenever the
// platform scales out, so missing or unavailable Redis fails closed instead.

export { clientIp, MemoryLimiter, type RateLimiter } from './ratelimit-core';

const redis =
  UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })
    : null;

export function makeLimiter(prefix: string, limit: number, windowMs: number): RateLimiter | null {
  if (redis) {
    const upstash = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${windowMs} ms`),
      prefix,
      timeout: 3_000,
    });
    return {
      async limit(key) {
        const result = await upstash.limit(key);
        if (result.reason === 'timeout') {
          throw new Error('Distributed rate limiting timed out.');
        }
        return { success: result.success };
      },
    };
  }
  if (import.meta.env.PROD) {
    return {
      async limit() {
        throw new Error('Distributed rate limiting is not configured.');
      },
    };
  }
  return null;
}
