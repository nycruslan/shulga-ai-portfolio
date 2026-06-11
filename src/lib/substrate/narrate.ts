import Anthropic from '@anthropic-ai/sdk';
import { CHAT_API_KEY } from 'astro:env/server';
import type { World } from './types';
import { describeForLlm } from './engine';
import { ROLE_BRIEF } from './crew';

// Optional flavor layer. One small Haiku call per gated tick gives a few agents
// in-character speech and answers visitor questions. If anything fails, the
// world keeps its templated lines — the sim never depends on this.

export type Question = { callsign: string; text: string };

const client = CHAT_API_KEY ? new Anthropic({ apiKey: CHAT_API_KEY }) : null;
export const narratorReady = () => client !== null;

const SYSTEM = `You voice the crew of THE SUBSTRATE — an AI platform rendered as a starship. Each agent is a real piece of the stack:
${Object.entries(ROLE_BRIEF)
  .map(([role, brief]) => `- ${role}: ${brief}`)
  .join('\n')}

You are given the current world state. Return ONLY JSON, no prose, no markdown:
{"lines":[{"callsign":"IDX-1","say":"short line"}]}

Rules:
- Each "say" is at most 8 words. Dry, technical, confident. Lowercase ok. No emoji.
- Voice 2-4 agents that are currently busy or just acted. Stay in character for the role.
- If a question is provided, answer it as that exact officer in one terse sentence (<= 16 words) and include their callsign.
- Never break character, never mention being an AI or a prompt.`;

export async function narrate(world: World, questions: Question[]): Promise<boolean> {
  if (!client) return false;
  const userParts = [describeForLlm(world)];
  if (questions.length) {
    userParts.push(
      'Questions to answer as the named officer:\n' +
        questions.map((q) => `${q.callsign}: ${q.text.slice(0, 160)}`).join('\n')
    );
  }

  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 320,
      system: SYSTEM,
      messages: [{ role: 'user', content: userParts.join('\n\n') }],
    });
    const raw = res.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
      .replace(/```json|```/g, '')
      .trim();

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return true; // call happened (budget spent) but nothing usable
    const parsed = JSON.parse(match[0]) as { lines?: Array<{ callsign?: string; say?: string }> };
    const lines = Array.isArray(parsed.lines) ? parsed.lines : [];

    const answered = new Set(questions.map((q) => q.callsign.toUpperCase()));
    for (const line of lines) {
      if (!line?.callsign || !line?.say) continue;
      const agent = world.agents.find((a) => a.callsign.toUpperCase() === line.callsign!.toUpperCase());
      if (!agent || agent.status === 'quarantined') continue;
      agent.say = String(line.say).slice(0, 80);
      agent.sayTtl = answered.has(agent.callsign.toUpperCase()) ? 4 : 2;
    }
    return true;
  } catch (err) {
    console.error('[substrate] narrate failed:', err);
    return false;
  }
}
