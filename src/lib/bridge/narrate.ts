import { Output, generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { CREW } from './crew';
import type { CrewId } from './crew';

// Optional flavor layer, ported from the Substrate narrator but on AI SDK v6
// through the AI Gateway. One small Haiku call per tick repaints the WORDING
// of the deterministic channel lines in each agent's voice. Facts (numbers,
// timestamps, phase claims) must survive verbatim; if the model drops or
// mangles them, we keep the template line. The bridge never depends on this.

const SYSTEM = `You voice the maintenance crew of AI agents that keeps Ruslan Shulga's portfolio site. The crew:
${CREW.map((m) => `- ${m.name} (${m.station}): ${m.brief}`).join('\n')}

You are given channel lines the engine already decided. Rephrase each in that agent's voice.

Rules:
- Keep every number, dollar amount, and phase reference EXACTLY as given.
- At most 14 words per line. Dry, specific, confident. Lowercase is fine. No emoji, no em dashes.
- Never invent work that did not happen. Never mention being an AI model or a prompt.`;

const lineSchema = z.object({
  lines: z.array(
    z.object({
      actor: z.enum(['scout', 'curator', 'critic', 'envoy', 'archivist']),
      say: z.string().max(120),
    }),
  ),
});

export type NarrationResult = {
  /** Rephrased lines keyed by actor; empty when narration was skipped/failed. */
  lines: Partial<Record<CrewId, string>>;
  usage: { inputTokens: number; outputTokens: number } | null;
  generationId?: string;
};

export const NARRATOR_MODEL = 'anthropic/claude-haiku-4.5';

/** Every fact-bearing token (numbers, $, phase ids) must survive rephrasing. */
export function factsSurvive(original: string, rephrased: string): boolean {
  const facts = original.match(/\$?\d+(?:\.\d+)?/g) ?? [];
  return facts.every((f) => rephrased.includes(f));
}

export async function narrate(
  requests: Array<{ actor: CrewId; line: string }>,
  model: LanguageModel = NARRATOR_MODEL,
): Promise<NarrationResult> {
  if (!requests.length) return { lines: {}, usage: null };

  try {
    const { output, usage, providerMetadata } = await generateText({
      model,
      system: SYSTEM,
      prompt:
        'Rephrase these channel lines in-voice:\n' +
        requests.map((r) => `${r.actor}: ${r.line}`).join('\n'),
      output: Output.object({ schema: lineSchema }),
      maxOutputTokens: 300,
      maxRetries: 0, // ambient tick; the next tick is the retry
    });

    const lines: Partial<Record<CrewId, string>> = {};
    for (const item of output.lines) {
      const original = requests.find((r) => r.actor === item.actor);
      if (!original || !factsSurvive(original.line, item.say)) continue;
      lines[item.actor] = item.say.slice(0, 120);
    }
    const gateway = providerMetadata?.gateway as { generationId?: string } | undefined;
    return {
      lines,
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      },
      generationId: gateway?.generationId,
    };
  } catch (err) {
    console.error('[bridge] narrate failed:', err);
    return { lines: {}, usage: null };
  }
}
