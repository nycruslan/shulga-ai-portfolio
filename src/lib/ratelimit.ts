import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } from 'astro:env/server';
import { MemoryLimiter, type RateLimiter } from './ratelimit-core';

// Shared rate limiter. Backed by Upstash when configured. When it isn't, we do
// NOT silently disable the cap in production: a missing Upstash env must never
// turn a public, model-spending endpoint into an unmetered one. Instead we fall
// back to an in-process sliding window (per-instance, not global, but a real
// cap beats none). In dev we stay a no-op for local ergonomics.

export { clientIp, MemoryLimiter, type RateLimiter } from './ratelimit-core';

const redis =
  UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })
    : null;

export function makeLimiter(prefix: string, limit: number, windowMs: number): RateLimiter | null {
  if (redis) {
    return new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${windowMs} ms`),
      prefix,
    });
  }
  // No Upstash: enforce an in-process cap in production, no-op in dev.
  return import.meta.env.PROD ? new MemoryLimiter(limit, windowMs) : null;
}
