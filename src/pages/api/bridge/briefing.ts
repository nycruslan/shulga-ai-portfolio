import type { APIRoute } from 'astro';
import { AI_GATEWAY_API_KEY } from 'astro:env/server';
import { createUIMessageStream, createUIMessageStreamResponse, safeValidateUIMessages } from 'ai';
import { turso } from '../../../lib/turso-client';
import { bridgeStore } from '../../../lib/bridge/store';
import { normalizeBridgeWorld } from '../../../lib/bridge/engine/tick';
import {
  briefingSectionDataSchema,
  briefingStatusDataSchema,
  CURATOR_MODEL,
  runBriefing,
  sanitizeRole,
  type BriefingUIMessage,
} from '../../../lib/bridge/briefing';
import { getProject, listProjects, searchPortfolio } from '../../../lib/portfolio-content';
import { readEvalRuns } from '../../../lib/turso';
import { loadConversation, saveConversation } from '../../../lib/bridge/persistence/messages';
import { reserveCall } from '../../../lib/bridge/persistence/budget';
import { clientIp, makeLimiter } from '../../../lib/ratelimit';
import { bridgeIdentity } from '../../../lib/bridge/identity';
import { briefingRequestSchema } from '../../../lib/bridge/request-schema';
import { json, readJson, withTimeout } from '../../../lib/http';

export const prerender = false;

// The Briefing Room endpoint. Frontier model, but ONLY on explicit trigger:
// per-IP limit, a daily cap on the whole room, and the run is a mission with
// its spend on the public meter. Dev without a key gets a scripted assembly.

const limiter = makeLimiter('bridge-briefing', 3, 60 * 60_000);
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

export const POST: APIRoute = async ({ request, clientAddress, cookies }) => {
  if (!turso) return json({ error: 'Briefing room not configured.' }, 503);

  const mock = !AI_GATEWAY_API_KEY;
  if (mock && !import.meta.env.DEV) {
    return json({ error: 'Briefing room offline: the gateway key is not installed yet.' }, 503);
  }

  if (limiter) {
    try {
      const { success } = await limiter.limit(clientIp(clientAddress));
      if (!success) return json({ error: 'Rate limit: 3 briefings per hour.' }, 429);
    } catch (err) {
      console.error('[bridge] briefing rate limiter unavailable:', err);
      return json({ error: 'Briefing safety gate unavailable. Try again shortly.' }, 503);
    }
  }

  const nowIso = new Date().toISOString();
  const parsed = await readJson(request, briefingRequestSchema);
  if (!parsed.ok) return parsed.response;
  const incoming = parsed.data.messages.at(-1);
  if (incoming?.role !== 'user' || incoming.parts.some((part) => part.type !== 'text')) {
    return json({ error: 'Invalid message list.' }, 400);
  }

  const briefingId = parsed.data.briefingId;
  const { ownerHash, visitorId } = bridgeIdentity(cookies);
  const stored = await loadConversation(turso, briefingId, ownerHash);
  if (stored === null) {
    return json({ error: 'Conversation ownership expired.', reset: true }, 409);
  }
  if (stored.some((message) => message.id === incoming.id)) {
    return json({ error: 'Message already processed.' }, 409);
  }

  const validated = await safeValidateUIMessages<BriefingUIMessage>({
    messages: [...stored.slice(-23), incoming],
    dataSchemas: {
      briefingSection: briefingSectionDataSchema,
      briefingStatus: briefingStatusDataSchema,
    },
  });
  if (!validated.success) return json({ error: 'Invalid message list.' }, 400);

  const messages = validated.data;
  const lastUser = messages.at(-1)!;
  const role = sanitizeRole(
    lastUser?.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join(' ') ?? '',
  );
  if (role.length < 8) {
    return json({ error: 'Tell the room a bit more about the role (one sentence).' }, 400);
  }
  if (!mock && !(await reserveCall(turso, 'briefing', BRIEFING_DAILY_CAP, nowIso))) {
    return json({ error: "The briefing room hit today's cap. Back tomorrow." }, 429);
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
        abortSignal: withTimeout(request.signal, 90_000),
        ...(mock ? { scripted: SCRIPTED } : {}),
      });
    },
    onError: () => 'Composition failed. Send the role line again.',
    onFinish: async ({ messages: finalMessages, isAborted }) => {
      try {
        if (!isAborted) {
          const saved = await saveConversation(
            client,
            briefingId,
            ownerHash,
            visitorId,
            finalMessages,
            nowIso,
          );
          if (!saved) console.warn('[bridge] briefing ownership changed before save');
        }
      } catch (err) {
        console.error('[bridge] briefing persistence failed:', err);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
};
