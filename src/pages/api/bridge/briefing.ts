import type { APIRoute } from 'astro';
import { AI_GATEWAY_API_KEY } from 'astro:env/server';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { turso } from '../../../lib/turso-client';
import { bridgeStore } from '../../../lib/bridge/store';
import { normalizeBridgeWorld } from '../../../lib/bridge/engine/tick';
import {
  CURATOR_MODEL,
  runBriefing,
  sanitizeRole,
  type BriefingUIMessage,
} from '../../../lib/bridge/briefing';
import { getProject, listProjects, searchPortfolio } from '../../../lib/portfolio-content';
import { readEvalRuns } from '../../../lib/turso';
import { saveConversation } from '../../../lib/bridge/persistence/messages';
import { daySpend } from '../../../lib/bridge/persistence/budget';
import { clientIp, makeLimiter, slidingWindow } from '../../../lib/ratelimit';

export const prerender = false;

// The Briefing Room endpoint. Frontier model, but ONLY on explicit trigger:
// per-IP limit, a daily cap on the whole room, and the run is a mission with
// its spend on the public meter. Dev without a key gets a scripted assembly.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const limiter = makeLimiter('bridge-briefing', slidingWindow(3, '1 h'));
const BRIEFING_DAILY_CAP = 30;

const SCRIPTED = [
  {
    title: '[mock] Why this fits',
    body: 'Scripted dev section. In production Curator writes this from the dossier for your specific role line.',
  },
  {
    title: '[mock] A relevant system',
    body: 'This section would anchor on a real case study and link to it.',
    projectSlug: 'multi-agent-platform',
  },
  {
    title: '[mock] The ask',
    body: 'Short closing with a direct ask. Three sections in dev; four to six in production.',
  },
];

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!turso) return json({ error: 'Briefing room not configured.' }, 503);

  const mock = !AI_GATEWAY_API_KEY;
  if (mock && !import.meta.env.DEV) {
    return json({ error: 'Briefing room offline: the gateway key is not installed yet.' }, 503);
  }

  if (limiter) {
    const { success } = await limiter.limit(clientIp(request, clientAddress));
    if (!success) return json({ error: 'Rate limit: 3 briefings per hour.' }, 429);
  }

  const nowIso = new Date().toISOString();
  if ((await daySpend(turso, nowIso, 'curator')).llmCalls >= BRIEFING_DAILY_CAP) {
    return json({ error: "The briefing room hit today's cap. Back tomorrow." }, 429);
  }

  const body = (await request.json()) as {
    messages?: BriefingUIMessage[];
    briefingId?: string;
    visitorId?: string;
  };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const briefingId = String(body.briefingId ?? '').slice(0, 64);
  const visitorId = String(body.visitorId ?? 'anon').slice(0, 64);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const role = sanitizeRole(
    lastUser?.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join(' ') ?? '',
  );
  if (role.length < 8 || !briefingId) {
    return json({ error: 'Tell the room a bit more about the role (one sentence).' }, 400);
  }

  const row = await bridgeStore.readState();
  const world = row ? normalizeBridgeWorld(row.world, nowIso) : null;
  const client = turso;

  const stream = createUIMessageStream<BriefingUIMessage>({
    originalMessages: messages,
    execute: async ({ writer }) => {
      await runBriefing({
        client,
        writer,
        role,
        visitorId,
        knowledge: { searchPortfolio, getProject, listProjects, readEvalRuns },
        lastShipped: world?.scout.lastCommit ?? null,
        model: CURATOR_MODEL,
        nowIso,
        ...(mock ? { scripted: SCRIPTED } : {}),
      });
    },
    onError: () => 'Composition failed. Send the role line again.',
    onFinish: async ({ messages: finalMessages, isAborted }) => {
      try {
        if (!isAborted) {
          await saveConversation(client, briefingId, visitorId, finalMessages, nowIso);
        }
      } catch (err) {
        console.error('[bridge] briefing persistence failed:', err);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
};
