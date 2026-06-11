import type { APIRoute } from 'astro';
import { CONFIG } from '../../../lib/substrate/types';
import {
  acquireLock,
  drainQueue,
  isConfigured,
  llmCallsToday,
  readState,
  recordLlmCall,
  releaseLock,
  writeState,
} from '../../../lib/substrate/store';
import { step } from '../../../lib/substrate/engine';
import { narrate, narratorReady, type Question } from '../../../lib/substrate/narrate';
import { clientIp, makeLimiter, slidingWindow } from '../../../lib/ratelimit';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

// Watcher-triggered, lock-guarded single writer. Any number of clients may call
// this; the lease lock + freshness check guarantee at most one real advance per
// tickInterval, and the daily budget caps LLM spend. No cron, no Vercel Pro.
const tickLimiter = makeLimiter('sub-tick', slidingWindow(40, '1 m'));

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!isConfigured()) return json({ ticked: false, configured: false });

  if (tickLimiter) {
    const { success } = await tickLimiter.limit(clientIp(request, clientAddress));
    if (!success) return json({ ticked: false, reason: 'rate' });
  }

  const now = Date.now();
  const acquired = await acquireLock(now, CONFIG.lockTtlMs);
  if (!acquired) return json({ ticked: false, reason: 'locked' });

  try {
    const state = await readState();
    if (!state) {
      await releaseLock();
      return json({ ticked: false });
    }
    if (now - Date.parse(state.tickedAt) < CONFIG.tickIntervalMs) {
      await releaseLock();
      return json({ ticked: false, reason: 'fresh', version: state.version });
    }

    const world = state.world;
    const interactions = await drainQueue(6);
    const questions: Question[] = interactions
      .filter((i) => i.kind === 'question' && i.agentId)
      .map((i) => {
        const a = world.agents.find((x) => x.id === i.agentId);
        return a ? { callsign: a.callsign, text: i.text ?? '' } : null;
      })
      .filter((q): q is Question => q !== null);

    step(world, interactions);

    if (narratorReady()) {
      const want =
        (await llmCallsToday()) < CONFIG.dailyLlmCap &&
        (questions.length > 0 || world.tick % CONFIG.llmHeartbeatTicks === 0);
      if (want) {
        await recordLlmCall();
        await narrate(world, questions);
      }
    }

    await writeState(world, new Date().toISOString()); // also clears the lock
    return json({ ticked: true, version: state.version + 1 });
  } catch (err) {
    console.error('[substrate] tick failed:', err);
    await releaseLock();
    return json({ ticked: false, reason: 'error' }, 500);
  }
};
