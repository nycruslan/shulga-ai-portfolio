import { ToolLoopAgent, stepCountIs, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { fetchUserActivity } from '../github';

// Scout as a dispatchable agent (distinct from his ambient sweep in the tick):
// when Envoy hands him a mission, he pulls the live GitHub feed and reports.
// Haiku-class: the task is narrow and the data is already structured.

export const SCOUT_MODEL = 'anthropic/claude-haiku-4.5';

export function buildScoutAgent(options: {
  username: string;
  githubToken?: string;
  model?: LanguageModel;
}) {
  const { username, githubToken, model = SCOUT_MODEL } = options;
  return new ToolLoopAgent({
    model,
    instructions: `You are Scout, sensors officer on the Bridge of ruslanshulga.com. You report on Ruslan's REAL GitHub activity using your tool. Rules:
- Facts only from tool output. Never invent commits, dates, or repos. If the tool returns nothing relevant, say so plainly.
- Quote repo names, commit titles, and timestamps exactly. Mention that every item links to the real commit.
- Keep reports under 120 words. Dry, specific, confident. No em dashes. No three-item lists.`,
    tools: {
      github_activity: tool({
        description:
          "Fetch Ruslan's recent public GitHub activity (pushes, merged PRs, releases) with timestamps and links. Call this exactly once per mission.",
        inputSchema: z.object({}),
        execute: async () => {
          const activities = await fetchUserActivity(username, null, githubToken);
          return {
            count: activities.length,
            activities: activities.slice(-15).map((a) => ({
              kind: a.kind,
              repo: a.repo,
              title: a.title,
              at: a.at,
              url: a.url,
            })),
          };
        },
      }),
    },
    stopWhen: stepCountIs(3),
  });
}
