import type { APIRoute } from 'astro';
import { AI_GATEWAY_API_KEY, GITHUB_TOKEN } from 'astro:env/server';
import { createAgentUIStreamResponse } from 'ai';
import { turso } from '../../../lib/turso-client';
import { about } from '../../../data/about';
import { buildEnvoyAgent, ENVOY_MODEL } from '../../../lib/bridge/agents/envoy';
import { getProject, listProjects, searchPortfolio } from '../../../lib/portfolio-content';
import { readEvalRuns } from '../../../lib/turso';
import { mockEnvoyModel, mockScoutModel } from '../../../lib/bridge/agents/mock-models';
import { saveConversation } from '../../../lib/bridge/persistence/messages';
import { daySpend, recordSpend } from '../../../lib/bridge/persistence/budget';
import { estimateCostUsd } from '../../../lib/bridge/pricing';
import { clientIp, makeLimiter } from '../../../lib/ratelimit';

export const prerender = false;

// Comms: the visitor side of Envoy. Auth-free but defended in depth: per-IP
// rate limit, a daily request cap on the whole station, capped step counts in
// the agent itself. Without a gateway key, dev gets deterministic mock models
// (full UX, zero cost) and production reports the station offline honestly.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const limiter = makeLimiter('bridge-envoy', 20, 60 * 60_000);
const ENVOY_DAILY_CAP = 150;
const GITHUB_USERNAME = about.github.split('/').pop() ?? 'nycruslan';

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!turso) return json({ error: 'Comms station not configured.' }, 503);

  const mock = !AI_GATEWAY_API_KEY;
  if (mock && !import.meta.env.DEV) {
    return json({ error: 'Comms offline: the gateway key is not installed yet.' }, 503);
  }

  if (limiter) {
    const { success } = await limiter.limit(clientIp(clientAddress));
    if (!success) return json({ error: 'Rate limit: 20 messages per hour.' }, 429);
  }

  const nowIso = new Date().toISOString();
  if ((await daySpend(turso, nowIso, 'envoy')).llmCalls >= ENVOY_DAILY_CAP) {
    return json({ error: "Envoy hit today's budget cap. Back tomorrow." }, 429);
  }

  const body = (await request.json()) as {
    messages?: unknown[];
    conversationId?: string;
    visitorId?: string;
  };
  const messages = Array.isArray(body.messages) ? body.messages.slice(-24) : [];
  const conversationId = String(body.conversationId ?? '').slice(0, 64);
  const visitorId = String(body.visitorId ?? 'anon').slice(0, 64);
  if (!messages.length || !conversationId) return json({ error: 'Bad request.' }, 400);

  const agent = buildEnvoyAgent({
    client: turso,
    visitorId,
    username: GITHUB_USERNAME,
    githubToken: GITHUB_TOKEN,
    knowledge: { searchPortfolio, getProject, listProjects, readEvalRuns },
    ...(mock ? { model: mockEnvoyModel(), scoutModel: mockScoutModel() } : {}),
  });

  const usage = { inputTokens: 0, outputTokens: 0 };
  return createAgentUIStreamResponse({
    agent,
    uiMessages: messages,
    onStepFinish: (step) => {
      usage.inputTokens += step.usage.inputTokens ?? 0;
      usage.outputTokens += step.usage.outputTokens ?? 0;
    },
    onFinish: async ({ messages: finalMessages, isAborted }) => {
      try {
        if (!isAborted && turso) {
          await saveConversation(turso, conversationId, visitorId, finalMessages, nowIso);
        }
        if (turso) {
          await recordSpend(
            turso,
            { agent: 'envoy', ...usage, costUsd: mock ? 0 : estimateCostUsd(ENVOY_MODEL, usage) },
            nowIso,
          );
        }
      } catch (err) {
        console.error('[bridge] envoy persistence failed:', err);
      }
    },
  });
};
