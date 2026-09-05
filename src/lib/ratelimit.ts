import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } from 'astro:env/server';
import { MemoryLimiter, type RateLimiter } from './ratelimit-core';

// Upstash is the production-wide gate when configured. If it is absent, keep
// a per-instance cap rather than taking every public AI route offline. Once a
// distributed limiter exists, timeout responses fail closed.

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
  return import.meta.env.PROD ? new MemoryLimiter(limit, windowMs) : null;
}
