import type { APIRoute } from 'astro';
import { CHAT_API_KEY } from 'astro:env/server';
import Anthropic from '@anthropic-ai/sdk';
import { systemPrompt, about } from '../../data/about';

export const prerender = false;

const MAX_MESSAGES = 20;

export const POST: APIRoute = async ({ request }) => {
  const client = CHAT_API_KEY ? new Anthropic({ apiKey: CHAT_API_KEY }) : null;
  if (!client) {
    return new Response(JSON.stringify({ error: `Chat unavailable — contact ${about.email}` }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { messages?: { role: string; content: string }[] };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const messages = (body.messages ?? []).slice(-MAX_MESSAGES).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content).slice(0, 2000),
  })) as { role: 'user' | 'assistant'; content: string }[];

  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return new Response(JSON.stringify({ error: 'Invalid message list' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stream = await client.messages.stream({
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
        controller.enqueue(encoder.encode('\n\n[error — try again or email nycruslan@gmail.com]'));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
