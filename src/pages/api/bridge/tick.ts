import type { APIRoute } from 'astro';
import { TICK_SECRET } from 'astro:env/server';
import { runTick } from '../../../lib/bridge/run-tick';
import { clientIp, makeLimiter } from '../../../lib/ratelimit';

export const prerender = false;

// The Bridge's pulse. The GitHub Actions heartbeat calls this with the shared
// secret every 3 hours (autonomy with zero visitors); the BridgeView island
// calls it without one on page load, which is how a visitor's arrival wakes
// the crew. Untrusted callers are rate-limited AND cadence-gated, and the
// daily narration cap bounds spend no matter what.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const limiter = makeLimiter('bridge-tick', 6, 10 * 60_000);

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const trusted = !!TICK_SECRET && request.headers.get('x-tick-secret') === TICK_SECRET;
  if (!trusted && limiter) {
    const { success } = await limiter.limit(clientIp(clientAddress));
    if (!success) return json({ ok: false, reason: 'rate' }, 429);
  }

  const outcome = await runTick(trusted ? 'heartbeat' : 'visitor');
  if (!outcome.ran) {
    const status = outcome.reason === 'unconfigured' ? 503 : 200;
    return json({ ok: false, reason: outcome.reason }, status);
  }
  return json({ ok: true, ...outcome });
};
