import type { APIRoute } from 'astro';
import { AI_GATEWAY_API_KEY, CHAT_API_KEY } from 'astro:env/server';
import Anthropic from '@anthropic-ai/sdk';
import { systemPrompt, about } from '../../data/about';
import { getProject, listProjects, searchPortfolio } from '../../lib/portfolio-content';
import { readEvalRuns } from '../../lib/turso';
import { clientIp, makeLimiter } from '../../lib/ratelimit';
import { chatRequestSchema } from '../../lib/bridge/request-schema';
import { json, readJson, withTimeout } from '../../lib/http';

export const prerender = false;

const MAX_TOOL_ROUNDS = 3;

// Public model traffic fails closed in production unless the distributed
// limiter is configured and reachable. Development remains unmetered.
const ratelimit = makeLimiter('chat', 20, 60 * 60_000);
const dailyLimit = makeLimiter('chat-daily', 300, 24 * 60 * 60_000);

async function reserveDailyModelCall(): Promise<boolean> {
  if (!dailyLimit) return true;
  const day = new Date().toISOString().slice(0, 10);
  return (await dailyLimit.limit(day)).success;
}

// The agent's tool surface. Prescriptive descriptions (when to call, not just
// what it does) so Haiku triggers reliably.
const tools: Anthropic.Tool[] = [
  {
    name: 'search_portfolio',
    description:
      "Search Ruslan's resume and case studies for specific passages. Call this when asked about a specific technology, metric, decision, or detail you can't answer confidently from the facts you already have. Returns scored text passages.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Short search terms, e.g. "rerank precision"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_project',
    description:
      'Fetch the full case study for one project (problem, architecture, key decisions, what broke). Call when asked HOW something was built or for depth on one project. Slugs: multi-agent-platform, hybrid-rag, mcp-servers, ai-gateway, document-ai, the-bridge.',
    input_schema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Project slug' } },
      required: ['slug'],
    },
  },
  {
    name: 'get_eval_summary',
    description:
      "Fetch last night's eval scores for THIS chat: groundedness, persona, refusals, injection resistance, judged by an LLM in CI and published at /evals. Call when asked about evals, testing, reliability, or how this assistant is graded.",
    input_schema: { type: 'object', properties: {} },
  },
];

async function runTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ result: string; detail: string }> {
  try {
    if (name === 'search_portfolio') {
      const hits = await searchPortfolio(String(input.query ?? ''), 4);
      if (!hits.length) return { result: 'No matches.', detail: 'no matches' };
      return {
        result: JSON.stringify(
          hits.map((h) => ({ source: h.source, title: h.title, score: h.score, text: h.text })),
        ),
        detail: `${hits.length} passages · top: ${hits[0].title} (score ${hits[0].score})`,
      };
    }
    if (name === 'get_project') {
      const project = await getProject(String(input.slug ?? ''));
      if (!project) {
        const slugs = (await listProjects()).map((p) => p.slug).join(', ');
        return { result: `Unknown slug. Available: ${slugs}`, detail: 'unknown slug' };
      }
      return {
        result: JSON.stringify(project),
        detail: `${project.title} · ${project.body.length.toLocaleString()} chars`,
      };
    }
    if (name === 'get_eval_summary') {
      const [latest] = await readEvalRuns(1);
      if (!latest) return { result: 'No eval runs published yet.', detail: 'no runs yet' };
      return {
        result: JSON.stringify({
          generated_at: latest.generated_at,
          overall: latest.overall,
          passed: `${latest.passed}/${latest.total}`,
          categories: latest.categories,
        }),
        detail: `${latest.overall}/10 overall · ${latest.passed}/${latest.total} passed`,
      };
    }
    return { result: `Unknown tool ${name}`, detail: 'unknown tool' };
  } catch (err) {
    console.error(`[api/chat] tool ${name} failed:`, err);
    return { result: 'Tool failed. Answer from what you know.', detail: 'failed' };
  }
}

const toolAddendum = `

## Tools

You have tools: search_portfolio, get_project, get_eval_summary. Visitors SEE your tool calls live (this chat renders its own trace; that transparency is a feature of the site). Use a tool when the question needs specifics beyond the facts above, and answer simple or personal questions directly without tools. Never invent tool output. After using tools, ground your answer in what they returned. Write plain text only: no markdown, no asterisks, no headers (the widget renders raw text).`;

// Route through the Vercel AI Gateway (valid, funded) rather than a raw
// Anthropic key. Falls back to a direct key only if the gateway isn't set.
const GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh';
const apiKey = AI_GATEWAY_API_KEY || CHAT_API_KEY;
const clientOptions = AI_GATEWAY_API_KEY
  ? { apiKey: AI_GATEWAY_API_KEY, baseURL: GATEWAY_BASE_URL }
  : { apiKey: CHAT_API_KEY ?? '' };
// Gateway uses dotted slugs (anthropic/claude-haiku-4.5); a direct key uses
// the plain Anthropic id.
const CHAT_MODEL = AI_GATEWAY_API_KEY ? 'anthropic/claude-haiku-4.5' : 'claude-haiku-4-5';

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const client = apiKey ? new Anthropic(clientOptions) : null;
  if (!client) {
    return json({ error: `Chat unavailable. Contact ${about.email}` }, 503);
  }

  if (ratelimit) {
    try {
      const { success } = await ratelimit.limit(clientIp(clientAddress));
      if (!success) {
        return json(
          { error: `Easy there. Too many questions for now. Email ${about.email}.` },
          429,
        );
      }
    } catch (err) {
      console.error('[api/chat] rate limit check failed:', err);
      return json({ error: 'Chat safety gate unavailable. Try again shortly.' }, 503);
    }
  }

  const parsed = await readJson(request, chatRequestSchema, 96 * 1024);
  if (!parsed.ok) return parsed.response;
  const history = parsed.data.messages;
  if (history.at(-1)?.role !== 'user') {
    return json({ error: 'Invalid message list' }, 400);
  }

  try {
    if (!(await reserveDailyModelCall())) {
      return json({ error: 'Chat reached its daily model budget.' }, 429);
    }
  } catch (err) {
    console.error('[api/chat] daily safety gate failed:', err);
    return json({ error: 'Chat safety gate unavailable. Try again shortly.' }, 503);
  }

  const encoder = new TextEncoder();
  const abortSignal = withTimeout(request.signal, 90_000);
  const readable = new ReadableStream({
    async start(controller) {
      const emit = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));

      try {
        const messages: Anthropic.MessageParam[] = [...history];

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          if (round > 0) {
            try {
              if (!(await reserveDailyModelCall())) {
                emit({ t: 'err', v: 'Chat reached its daily model budget.' });
                return;
              }
            } catch (err) {
              console.error('[api/chat] daily safety gate failed mid-run:', err);
              emit({ t: 'err', v: 'Chat safety gate unavailable. Try again shortly.' });
              return;
            }
          }

          // Last round: no tools, force a final grounded answer.
          const allowTools = round < MAX_TOOL_ROUNDS;
          const stream = client.messages.stream(
            {
              model: CHAT_MODEL,
              max_tokens: 700,
              system: systemPrompt + toolAddendum,
              messages,
              ...(allowTools ? { tools } : {}),
            },
            { signal: abortSignal },
          );

          for await (const chunk of stream) {
            if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
              emit({ t: 'text', v: chunk.delta.text });
            } else if (
              chunk.type === 'content_block_start' &&
              chunk.content_block.type === 'tool_use'
            ) {
              emit({ t: 'tool', name: chunk.content_block.name });
            }
          }

          const final = await stream.finalMessage();
          if (final.stop_reason !== 'tool_use') break;

          messages.push({ role: 'assistant', content: final.content });
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const block of final.content) {
            if (block.type !== 'tool_use') continue;
            const { result, detail } = await runTool(
              block.name,
              block.input as Record<string, unknown>,
            );
            emit({ t: 'tool_ok', name: block.name, detail, input: block.input });
            results.push({ type: 'tool_result', tool_use_id: block.id, content: result });
          }
          messages.push({ role: 'user', content: results });
        }

        emit({ t: 'done' });
      } catch (err) {
        console.error('[api/chat] stream failed:', err);
        try {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ t: 'err', v: `Something broke. Email ${about.email}.` }) + '\n',
            ),
          );
        } catch {
          /* stream already closed by the client */
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* cancelled streams are already closed */
        }
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
