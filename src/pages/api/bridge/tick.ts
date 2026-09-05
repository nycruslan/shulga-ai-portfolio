import { timingSafeEqual } from 'node:crypto';
import type { APIRoute } from 'astro';
import { TICK_SECRET } from 'astro:env/server';
import { runTick } from '../../../lib/bridge/run-tick';
import { json } from '../../../lib/http';
import { clientIp, makeLimiter } from '../../../lib/ratelimit';

export const prerender = false;

// The Bridge's pulse. The GitHub Actions heartbeat calls this with the shared
// secret every 3 hours (autonomy with zero visitors); the BridgeView island
// calls it without one on page load, which is how a visitor's arrival wakes
// the crew. Untrusted callers are rate-limited AND cadence-gated, and the
// daily narration cap bounds spend no matter what.

const limiter = makeLimiter('bridge-tick', 6, 10 * 60_000);

function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const actualBytes = new TextEncoder().encode(provided);
  const expectedBytes = new TextEncoder().encode(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const trusted = secretMatches(request.headers.get('x-tick-secret'), TICK_SECRET);
  if (!trusted && limiter) {
    try {
      const { success } = await limiter.limit(clientIp(clientAddress));
      if (!success) return json({ ok: false, reason: 'rate' }, 429);
    } catch (err) {
      console.error('[bridge] tick rate limiter unavailable:', err);
      return json({ ok: false, reason: 'safety-gate' }, 503);
    }
  }

  const outcome = await runTick(trusted ? 'heartbeat' : 'visitor');
  if (!outcome.ran) {
    const status = outcome.reason === 'unconfigured' ? 503 : 200;
    return json({ ok: false, reason: outcome.reason }, status);
  }
  return json({ ok: true, ...outcome });
};
