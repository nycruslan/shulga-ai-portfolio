import type { APIRoute } from 'astro';
import {
  CHAT_API_KEY,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} from 'astro:env/server';
import Anthropic from '@anthropic-ai/sdk';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { systemPrompt, about } from '../../data/about';

export const prerender = false;

const MAX_MESSAGES = 20;

// Per-IP rate limit. Created once if Upstash is configured; otherwise null (no-op in dev).
const ratelimit =
  UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN
    ? new Ratelimit({
        redis: new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN }),
        limiter: Ratelimit.slidingWindow(20, '1 h'),
        prefix: 'chat',
      })
    : null;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const client = CHAT_API_KEY ? new Anthropic({ apiKey: CHAT_API_KEY }) : null;
  if (!client) {
    return json({ error: `Chat unavailable — contact ${about.email}` }, 503);
  }

  if (ratelimit) {
    const ip =
      clientAddress ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      'anon';
    const { success } = await ratelimit.limit(ip);
    if (!success) {
      return json({ error: `Easy there. Too many questions for now — email ${about.email}.` }, 429);
    }
  }

  let body: { messages?: { role: string; content: string }[] };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }

  const messages = (body.messages ?? []).slice(-MAX_MESSAGES).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content).slice(0, 2000),
  })) as { role: 'user' | 'assistant'; content: string }[];

  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return json({ error: 'Invalid message list' }, 400);
  }

  const stream = client.messages.stream({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: systemPrompt,
    messages,
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          if (
            chunk.type === 'content_block_delta' &&
            chunk.delta.type === 'text_delta'
          ) {
            controller.enqueue(encoder.encode(chunk.delta.text));
          }
        }
      } catch (err) {
        console.error('[api/chat] stream failed:', err);
        controller.enqueue(encoder.encode(`\n\n[error — try again or email ${about.email}]`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
