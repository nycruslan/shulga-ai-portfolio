import type { APIRoute } from 'astro';
import { AI_GATEWAY_API_KEY, GITHUB_TOKEN } from 'astro:env/server';
import { createAgentUIStreamResponse, safeValidateUIMessages, type InferAgentUIMessage } from 'ai';
import { turso } from '../../../lib/turso-client';
import { about } from '../../../data/about';
import { buildEnvoyAgent, ENVOY_MODEL } from '../../../lib/bridge/agents/envoy';
import { getProject, listProjects, searchPortfolio } from '../../../lib/portfolio-content';
import { readEvalRuns } from '../../../lib/turso';
import { mockEnvoyModel, mockScoutModel } from '../../../lib/bridge/agents/mock-models';
import { loadConversation, saveConversation } from '../../../lib/bridge/persistence/messages';
import { finalizeSpend, reserveCall } from '../../../lib/bridge/persistence/budget';
import { estimateCostUsd } from '../../../lib/bridge/pricing';
import { clientIp, makeLimiter } from '../../../lib/ratelimit';
import { bridgeIdentity } from '../../../lib/bridge/identity';
import { envoyRequestSchema } from '../../../lib/bridge/request-schema';
import { json, readJson, withTimeout } from '../../../lib/http';

export const prerender = false;

// Comms: the visitor side of Envoy. Auth-free but defended in depth: per-IP
// rate limit, a daily request cap on the whole station, capped step counts in
// the agent itself. Without a gateway key, dev gets deterministic mock models
// (full UX, zero cost) and production reports the station offline honestly.

const limiter = makeLimiter('bridge-envoy', 20, 60 * 60_000);
const ENVOY_DAILY_CAP = 150;
const GITHUB_USERNAME = about.github.split('/').pop() ?? 'nycruslan';

export const POST: APIRoute = async ({ request, clientAddress, cookies }) => {
  if (!turso) return json({ error: 'Comms station not configured.' }, 503);

  const mock = !AI_GATEWAY_API_KEY;
  if (mock && !import.meta.env.DEV) {
    return json({ error: 'Comms offline: the gateway key is not installed yet.' }, 503);
  }

  if (limiter) {
    try {
      const { success } = await limiter.limit(clientIp(clientAddress));
      if (!success) return json({ error: 'Rate limit: 20 messages per hour.' }, 429);
    } catch (err) {
      console.error('[bridge] envoy rate limiter unavailable:', err);
      return json({ error: 'Comms safety gate unavailable. Try again shortly.' }, 503);
    }
  }

  const nowIso = new Date().toISOString();
  const parsed = await readJson(request, envoyRequestSchema);
  if (!parsed.ok) return parsed.response;
  const { conversationId } = parsed.data;
  const incoming = parsed.data.messages.at(-1);
  if (incoming?.role !== 'user' || incoming.parts.some((part) => part.type !== 'text')) {
    return json({ error: 'Invalid message list.' }, 400);
  }

  const { ownerHash, visitorId } = bridgeIdentity(cookies);
  const stored = await loadConversation(turso, conversationId, ownerHash);
  if (stored === null) {
    return json({ error: 'Conversation ownership expired.', reset: true }, 409);
  }
  if (stored.some((message) => message.id === incoming.id)) {
    return json({ error: 'Message already processed.' }, 409);
  }

  const agent = buildEnvoyAgent({
    client: turso,
    visitorId,
    username: GITHUB_USERNAME,
    githubToken: GITHUB_TOKEN,
    knowledge: { searchPortfolio, getProject, listProjects, readEvalRuns },
    ...(mock ? { model: mockEnvoyModel(), scoutModel: mockScoutModel() } : {}),
  });
  const validated = await safeValidateUIMessages<InferAgentUIMessage<typeof agent>>({
    messages: [...stored.slice(-23), incoming],
    tools: agent.tools,
  });
  if (!validated.success) return json({ error: 'Invalid message list.' }, 400);
  if (!mock && !(await reserveCall(turso, 'envoy', ENVOY_DAILY_CAP, nowIso))) {
    return json({ error: "Envoy hit today's budget cap. Back tomorrow." }, 429);
  }

  const usage = { inputTokens: 0, outputTokens: 0 };
  return createAgentUIStreamResponse({
    agent,
    uiMessages: validated.data,
    abortSignal: withTimeout(request.signal, 90_000),
    onStepFinish: (step) => {
      usage.inputTokens += step.usage.inputTokens ?? 0;
      usage.outputTokens += step.usage.outputTokens ?? 0;
    },
    onFinish: async ({ messages: finalMessages, isAborted }) => {
      try {
        if (!isAborted && turso) {
          const saved = await saveConversation(
            turso,
            conversationId,
            ownerHash,
            visitorId,
            finalMessages,
            nowIso,
          );
          if (!saved) console.warn('[bridge] conversation ownership changed before save');
        }
        if (turso && !mock) {
          await finalizeSpend(
            turso,
            { agent: 'envoy', ...usage, costUsd: estimateCostUsd(ENVOY_MODEL, usage) },
            nowIso,
          );
        }
      } catch (err) {
        console.error('[bridge] envoy persistence failed:', err);
      }
    },
  });
};
