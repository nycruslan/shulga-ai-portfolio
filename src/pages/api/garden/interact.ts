import type { APIRoute } from 'astro';
import { GARDEN_CONFIG, type GardenInteraction } from '../../../lib/garden/types';
import { enqueueInteraction, isConfigured } from '../../../lib/garden/store';
import { clientIp, makeLimiter, slidingWindow } from '../../../lib/ratelimit';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const clean = (v: unknown) =>
  String(v ?? '')
    .replace(/[^\p{L}\p{N} ,.'!?-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

// Visitor actions never hit an LLM synchronously. They land in a queue the next
// tick consumes. A whisper becomes a memory an agent mulls over, never a system
// prompt, so there is nothing to inject into.
const actionLimiter = makeLimiter('garden-act', slidingWindow(GARDEN_CONFIG.interactionsPerMinute, '1 m'));
const whisperLimiter = makeLimiter('garden-whisper', slidingWindow(GARDEN_CONFIG.whispersPerHour, '1 h'));

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!isConfigured()) return json({ ok: false, configured: false }, 503);

  let body: { kind?: string; text?: string; x?: number; y?: number };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }

  const ip = clientIp(request, clientAddress);
  if (actionLimiter) {
    const { success } = await actionLimiter.limit(ip);
    if (!success) return json({ error: 'Easy there, let the garden breathe.' }, 429);
  }

  const pos =
    typeof body.x === 'number' && typeof body.y === 'number'
      ? { x: Math.max(0, Math.min(1, body.x)), y: Math.max(0, Math.min(1, body.y)) }
      : undefined;

  let interaction: GardenInteraction;
  if (body.kind === 'rain') {
    interaction = { kind: 'rain' };
  } else if (body.kind === 'seed') {
    interaction = { kind: 'seed', pos };
  } else if (body.kind === 'whisper') {
    const text = clean(body.text);
    if (!text) return json({ error: 'A whisper needs a few words.' }, 400);
    if (whisperLimiter) {
      const { success } = await whisperLimiter.limit(ip);
      if (!success) return json({ error: 'The garden has heard enough whispers for now.' }, 429);
    }
    interaction = { kind: 'whisper', text };
  } else {
    return json({ error: 'Unknown action.' }, 400);
  }

  const queued = await enqueueInteraction(interaction);
  if (!queued) return json({ error: 'The garden is busy. Try again shortly.' }, 429);
  return json({ ok: true });
};
