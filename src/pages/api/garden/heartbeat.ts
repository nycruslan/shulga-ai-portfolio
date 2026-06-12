import type { APIRoute } from 'astro';
import { TICK_SECRET } from 'astro:env/server';
import { GARDEN_CONFIG } from '../../../lib/garden/types';
import {
  acquireLock,
  drainQueue,
  isConfigured,
  llmCallsToday,
  readState,
  recordLlmCall,
  releaseLock,
  writeState,
} from '../../../lib/garden/store';
import { step } from '../../../lib/garden/engine';
import { advanceConversations, runBackground, societyReady } from '../../../lib/garden/society';
import { clientIp, makeLimiter, slidingWindow } from '../../../lib/ratelimit';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// A burst is more expensive than a single tick. The cron sends the shared secret
// and runs freely; untrusted callers are throttled hard so the endpoint can't be
// used to burn the daily budget. The daily cap is the final backstop either way.
const burstLimiter = makeLimiter('garden-hb', slidingWindow(3, '10 m'));

// Keeps the garden living when no one is watching. The GitHub Actions heartbeat
// calls this every few hours; it advances a short burst of ticks so a returning
// visitor finds the world genuinely moved on (plants grew, talks happened, maybe
// a new creature). Bounded by the same daily call cap, single-writer via the lock.
const BURST = 6;
// A burst makes several model calls, so it
// holds a longer lease than a single visitor tick to avoid the lock expiring
// mid-burst and letting a concurrent writer in.
const HEARTBEAT_LOCK_MS = 150_000;

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!isConfigured()) return json({ ok: false, configured: false }, 503);

  const trusted = !!TICK_SECRET && request.headers.get('x-tick-secret') === TICK_SECRET;
  if (!trusted && burstLimiter) {
    const { success } = await burstLimiter.limit(clientIp(request, clientAddress));
    if (!success) return json({ ok: false, reason: 'rate' }, 429);
  }

  if (!(await acquireLock(Date.now(), HEARTBEAT_LOCK_MS))) return json({ ok: false, reason: 'locked' });
  try {
    const row = await readState();
    if (!row) return json({ ok: false });
    const world = row.state;

    let calls = 0;
    for (let i = 0; i < BURST; i++) {
      const interactions = i === 0 ? await drainQueue(6) : [];
      step(world, interactions);
      if (societyReady() && (await llmCallsToday()) < GARDEN_CONFIG.dailyLlmCap) {
        let called = await advanceConversations(world);
        if (!called) called = await runBackground(world);
        if (called) {
          await recordLlmCall();
          calls += 1;
        }
      }
    }

    await writeState(world, new Date().toISOString());
    return json({ ok: true, ticks: BURST, calls, tick: world.world.tick });
  } catch (err) {
    console.error('[garden] heartbeat failed:', err);
    await releaseLock();
    return json({ ok: false, reason: 'error' }, 500);
  }
};
