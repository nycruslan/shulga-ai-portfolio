import type { APIRoute } from 'astro';
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

// Watcher-triggered, lock-guarded single writer. The deterministic ecosystem
// advances free every tick; at most one Haiku call is spent giving a conversation
// its next line, capped per day. No cron required (a free heartbeat layers on).
const tickLimiter = makeLimiter('garden-tick', slidingWindow(40, '1 m'));

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!isConfigured()) return json({ ticked: false, configured: false });
  if (tickLimiter) {
    const { success } = await tickLimiter.limit(clientIp(request, clientAddress));
    if (!success) return json({ ticked: false, reason: 'rate' });
  }

  const now = Date.now();
  if (!(await acquireLock(now, GARDEN_CONFIG.lockTtlMs))) return json({ ticked: false, reason: 'locked' });

  try {
    const state = await readState();
    if (!state) {
      await releaseLock();
      return json({ ticked: false });
    }
    if (now - Date.parse(state.tickedAt) < GARDEN_CONFIG.tickIntervalMs) {
      await releaseLock();
      return json({ ticked: false, reason: 'fresh', version: state.version });
    }

    const world = state.state;
    const interactions = await drainQueue(6);
    step(world, interactions);

    // One bounded Haiku call: an open conversation's next line, or — when none is
    // open — a background moment (a creature reflects, or two raise a new one).
    if (societyReady() && (await llmCallsToday()) < GARDEN_CONFIG.dailyLlmCap) {
      let called = await advanceConversations(world);
      if (!called) called = await runBackground(world);
      if (called) await recordLlmCall();
    }

    await writeState(world, new Date().toISOString());
    return json({ ticked: true, version: state.version + 1, tick: world.world.tick });
  } catch (err) {
    console.error('[garden] tick failed:', err);
    await releaseLock();
    return json({ ticked: false, reason: 'error' }, 500);
  }
};
