import { Output, generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { auditReadOnlyCopy, repairEmDashes } from './engine/audit';

// Curator's ship notes: when Scout files fresh pushes, Curator turns the
// commit subjects into one plain sentence a visitor can actually read. Same
// honesty contract as the narrator: the model only rewords real input, and a
// deterministic review gate (Critic's own linter, plus no-invented-numbers
// and name-the-repo checks) decides whether the note ships. On any failure
// the note is simply skipped — Scout's factual event already told the story.

export const SHIP_NOTE_MODEL = 'anthropic/claude-haiku-4.5';
/** Curator's own daily call budget across ship notes and proposal drafts. */
export const SHIP_NOTE_DAILY_CAP = 20;

const SYSTEM = `You are Curator, the writer on the AI crew that runs Ruslan Shulga's portfolio site. Scout just spotted fresh commits. Write ONE sentence (max 180 characters) telling a site visitor, in plain language, what shipped.

Rules:
- Ground every claim in the commit subjects you are given. Never invent features, numbers, or outcomes.
- Name the repository the work landed in.
- No hype, no buzzwords, no em dashes, no emoji. Dry and specific.`;

const noteSchema = z.object({ note: z.string().max(220) });

export type ShipNoteResult = {
  note: string;
  usage: { inputTokens: number; outputTokens: number };
  generationId?: string;
};

/**
 * The review gate. Deterministic and strict: a note that fails any check is
 * dropped, never patched into shape (beyond the mechanical dash repair the
 * caller already ran).
 */
export function shipNoteSurvivesReview(note: string, repo: string, titles: string[]): boolean {
  const short = repo.split('/')[1] ?? repo;
  if (!note.toLowerCase().includes(short.toLowerCase())) return false;
  // Every number in the note must exist in a commit subject; the model gets
  // no license to mint metrics.
  const source = titles.join(' ');
  const numbers = note.match(/\d+(?:\.\d+)?/g) ?? [];
  if (!numbers.every((n) => source.includes(n))) return false;
  // Critic's house-style rules apply to the crew's own prose too.
  return auditReadOnlyCopy({ note }).length === 0;
}

export async function writeShipNote(
  input: { repo: string; titles: string[] },
  model: LanguageModel = SHIP_NOTE_MODEL,
): Promise<ShipNoteResult | null> {
  if (!input.titles.length) return null;
  try {
    const { output, usage, providerMetadata } = await generateText({
      model,
      system: SYSTEM,
      prompt:
        `Repository: ${input.repo}\nCommit subjects:\n` +
        input.titles.map((t) => `- ${t}`).join('\n'),
      output: Output.object({ schema: noteSchema }),
      maxOutputTokens: 200,
      maxRetries: 0, // additive color; the pushes are already on the log
    });

    const note = repairEmDashes(output.note.trim()).slice(0, 200);
    if (!shipNoteSurvivesReview(note, input.repo, input.titles)) return null;

    const gateway = providerMetadata?.gateway as { generationId?: string } | undefined;
    return {
      note,
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      },
      generationId: gateway?.generationId,
    };
  } catch (err) {
    console.error('[bridge] ship note failed:', err);
    return null;
  }
}
