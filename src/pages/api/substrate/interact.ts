import type { APIRoute } from 'astro';
import { CONFIG, type Interaction } from '../../../lib/substrate/types';
import { CREW } from '../../../lib/substrate/crew';
import { enqueueInteraction, isConfigured } from '../../../lib/substrate/store';
import { clientIp, makeLimiter, slidingWindow } from '../../../lib/ratelimit';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

// Strip control characters, collapse whitespace, trim, clamp length.
const clean = (v: unknown) =>
  String(v ?? '')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

// Visitor actions never hit an LLM synchronously. They land in a queue the next
// paid tick consumes, rate-limited per IP, so interaction is free and safe.
const actionLimiter = makeLimiter('sub-act', slidingWindow(CONFIG.actionsPerMinute, '1 m'));
const questionLimiter = makeLimiter('sub-q', slidingWindow(CONFIG.questionsPerHour, '1 h'));

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!isConfigured()) return json({ ok: false, configured: false }, 503);

  let body: { kind?: string; text?: string; agentId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }

  const ip = clientIp(request, clientAddress);
  if (actionLimiter) {
    const { success } = await actionLimiter.limit(ip);
    if (!success) return json({ error: 'Easy there, slow down a moment.' }, 429);
  }

  let interaction: Interaction;
  if (body.kind === 'anomaly') {
    interaction = { kind: 'anomaly' };
  } else if (body.kind === 'directive') {
    const text = clean(body.text);
    if (!text) return json({ error: 'A directive needs some text.' }, 400);
    interaction = { kind: 'directive', text };
  } else if (body.kind === 'question') {
    const agentId = String(body.agentId ?? '');
    if (!CREW.some((c) => c.id === agentId)) return json({ error: 'Unknown officer.' }, 400);
    const text = clean(body.text);
    if (!text) return json({ error: 'Ask an actual question.' }, 400);
    if (questionLimiter) {
      const { success } = await questionLimiter.limit(ip);
      if (!success) return json({ error: 'Question limit reached. Try again later.' }, 429);
    }
    interaction = { kind: 'question', agentId, text };
  } else {
    return json({ error: 'Unknown action.' }, 400);
  }

  const queued = await enqueueInteraction(interaction);
  if (!queued) return json({ error: 'The queue is full right now. Try again shortly.' }, 429);
  return json({ ok: true });
};
