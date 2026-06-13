import {
  ToolLoopAgent,
  readUIMessageStream,
  stepCountIs,
  tool,
  type LanguageModel,
  type UIMessage,
} from 'ai';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import { systemPrompt } from '../../../data/about';
import { CREW } from '../crew';
import { appendEvent } from '../persistence/events';
import { completeMission, createMission } from '../persistence/missions';
import { buildScoutAgent } from './scout-agent';

// Envoy: the comms officer. Carries the old portfolio assistant's knowledge
// tools, plus the ship's telemetry and the first dispatch tool. Dispatching
// is the Phase 3 centerpiece: the visitor's question becomes a real mission
// row, Scout's run streams into the conversation as it happens, and the
// outcome lands in the ship's log with the visitor's (anonymous) id on it.

export const ENVOY_MODEL = 'anthropic/claude-sonnet-4-6';

const ENVOY_INSTRUCTIONS = `${systemPrompt}

## You are Envoy
You are also "Envoy", comms officer of the Bridge (the /bridge page): a crew of five AI agents that runs this site. The crew: ${CREW.map((m) => `${m.name} (${m.role})`).join(', ')}. The bridge page shows a live event log, the crew's real model budget, and a mission board. Everything on it is real and timestamped; you can say so with confidence.

## Dispatching
When a visitor asks about Ruslan's recent GitHub activity, what he shipped lately, or wants to "send Scout", call dispatch_scout with a short task description. The visitor watches the mission run live, so do not repeat Scout's full report afterward; one line of acknowledgment is enough. Use it at most once per reply. For questions about Ruslan's career, projects, or evals, use the knowledge tools instead.`;

/** What the dispatch tool yields while a mission runs (rendered as a card). */
export type DispatchProgress =
  | { state: 'working'; missionId: number; note: string }
  | { state: 'done'; missionId: number; report: string }
  | { state: 'failed'; missionId: number; report: string };

function lastText(message: UIMessage | undefined): string {
  if (!message) return '';
  return message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

// Knowledge functions are injected: their real implementations live behind
// Astro virtual modules (astro:content, astro:env) that only exist at runtime,
// and injection keeps the agent testable on plain stubs.
export type EnvoyKnowledge = {
  searchPortfolio: (query: string, limit?: number) => Promise<unknown>;
  getProject: (slug: string) => Promise<unknown>;
  listProjects: () => Promise<Array<{ slug: string }>>;
  readEvalRuns: (limit?: number) => Promise<
    Array<{
      generated_at: string;
      overall: number;
      passed: number;
      total: number;
      categories: unknown;
    }>
  >;
};

const NO_KNOWLEDGE: EnvoyKnowledge = {
  searchPortfolio: async () => [],
  getProject: async () => null,
  listProjects: async () => [],
  readEvalRuns: async () => [],
};

export function buildEnvoyAgent(options: {
  client: Client;
  visitorId: string;
  username: string;
  githubToken?: string;
  model?: LanguageModel;
  scoutModel?: LanguageModel;
  knowledge?: EnvoyKnowledge;
}) {
  const {
    client,
    visitorId,
    username,
    githubToken,
    model = ENVOY_MODEL,
    scoutModel,
    knowledge = NO_KNOWLEDGE,
  } = options;

  return new ToolLoopAgent({
    model,
    instructions: ENVOY_INSTRUCTIONS,
    stopWhen: stepCountIs(5),
    maxOutputTokens: 700,
    tools: {
      search_portfolio: tool({
        description:
          "Search Ruslan's resume and case studies for specific passages. Call when asked about a specific technology, metric, or decision you can't answer confidently from the facts you already have.",
        inputSchema: z.object({ query: z.string().describe('Short search terms') }),
        execute: async ({ query }) => ({ hits: await knowledge.searchPortfolio(query, 4) }),
      }),
      get_project: tool({
        description:
          'Fetch the full case study for one project (problem, architecture, key decisions). Call when asked HOW something was built. Slugs: multi-agent-platform, hybrid-rag, mcp-servers, ai-gateway, document-ai, the-bridge.',
        inputSchema: z.object({ slug: z.string() }),
        execute: async ({ slug }) => {
          const project = await knowledge.getProject(slug);
          if (project) return project;
          const slugs = (await knowledge.listProjects()).map((p) => p.slug).join(', ');
          return { error: `Unknown slug. Valid: ${slugs}` };
        },
      }),
      get_eval_summary: tool({
        description:
          "Fetch last night's eval scores for this assistant (groundedness, persona, refusals, injection resistance), judged by an LLM in CI and published at /evals.",
        inputSchema: z.object({}),
        execute: async () => {
          const [latest] = await knowledge.readEvalRuns(1);
          return latest
            ? {
                generatedAt: latest.generated_at,
                overall: latest.overall,
                passed: latest.passed,
                total: latest.total,
                categories: latest.categories,
              }
            : { error: 'No eval runs recorded yet.' };
        },
      }),
      dispatch_scout: tool({
        description:
          "Send Scout on a mission to report Ruslan's real, current GitHub activity (what shipped recently). The visitor watches it run live.",
        inputSchema: z.object({
          task: z
            .string()
            .max(200)
            .describe('Short mission brief, e.g. "report this week\'s pushes"'),
        }),
        execute: async function* ({ task }, { abortSignal }) {
          const missionId = await createMission(client, {
            title: task,
            brief: task,
            assignee: 'scout',
            visitorId,
          });
          await appendEvent(client, {
            actor: 'envoy',
            kind: 'mission',
            summary: `Mission #${missionId} dispatched to Scout: ${task}`,
            missionId,
          });
          yield { state: 'working', missionId, note: 'Scout has the mission.' } as DispatchProgress;

          try {
            const scout = buildScoutAgent({ username, githubToken, model: scoutModel });
            const run = await scout.stream({ prompt: `Mission: ${task}`, abortSignal });
            let final: UIMessage | undefined;
            for await (const message of readUIMessageStream({ stream: run.toUIMessageStream() })) {
              final = message as UIMessage;
              const note = lastText(final);
              if (note) {
                yield { state: 'working', missionId, note } as DispatchProgress;
              }
            }
            // Scout's loop absorbs tool failures (it keeps talking); the
            // mission ledger must not. Any errored tool part fails the mission.
            const toolErrored = final?.parts.some(
              (p) => 'state' in p && p.state === 'output-error',
            );
            const report = lastText(final) || 'Scout returned no report.';
            const status = toolErrored ? 'failed' : 'done';
            await completeMission(
              client,
              missionId,
              status,
              toolErrored ? `GitHub isn't responding. Scout's note: ${report}` : report,
            );
            await appendEvent(client, {
              actor: 'scout',
              kind: 'mission',
              summary: toolErrored
                ? `Mission #${missionId} failed: GitHub isn't responding.`
                : `Mission #${missionId} complete.`,
              detail: { report },
              missionId,
            });
            yield {
              state: status,
              missionId,
              report: toolErrored ? "GitHub isn't responding. Mission failed." : report,
            } as DispatchProgress;
          } catch (err) {
            console.error('[bridge] scout mission failed:', err);
            const report = "GitHub isn't responding. Mission failed; try again in a minute.";
            await completeMission(client, missionId, 'failed', report);
            await appendEvent(client, {
              actor: 'scout',
              kind: 'mission',
              summary: `Mission #${missionId} failed: GitHub isn't responding.`,
              missionId,
            });
            yield { state: 'failed', missionId, report } as DispatchProgress;
          }
        },
        // Envoy's model sees a compact outcome, not the full stream history.
        toModelOutput: ({ output }) => ({
          type: 'text',
          value:
            output.state === 'done'
              ? `Mission #${output.missionId} complete. Scout's report (already shown to the visitor): ${output.report}`
              : output.state === 'failed'
                ? `Mission #${output.missionId} failed: ${output.report}`
                : `Mission #${output.missionId} in progress.`,
        }),
      }),
    },
  });
}

export type EnvoyAgent = ReturnType<typeof buildEnvoyAgent>;
