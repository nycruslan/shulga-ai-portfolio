import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } from 'astro:env/server';

// Shared Upstash-backed limiter factory. Returns null when Upstash isn't
// configured (dev, or before the integration is provisioned), so callers no-op
// cleanly instead of failing.

const redis =
  UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })
    : null;

type Limiter = ReturnType<typeof Ratelimit.slidingWindow>;

export function makeLimiter(prefix: string, limiter: Limiter): Ratelimit | null {
  if (!redis) return null;
  return new Ratelimit({ redis, limiter, prefix });
}

export const slidingWindow = Ratelimit.slidingWindow;

export function clientIp(request: Request, clientAddress?: string): string {
  return (
    clientAddress ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'anon'
  );
}
