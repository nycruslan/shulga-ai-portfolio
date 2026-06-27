import { Output, generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { auditCopyEntry, repairEmDashes, type CopyFinding } from './engine/audit';

// Curator drafts a revision for a flagged copy entry; Critic (the same
// deterministic auditor that found the problem) reviews the draft. Each draft
// is first run through a mechanical em-dash repair (Sonnet keeps adding them),
// then Critic re-audits. If the draft still violates, Curator retries with
// Critic's notes, up to three attempts. If they all fail, the disagreement
// goes in the log and no proposal is filed. The argument is the feature:
// scripted demos don't show rejection.

const MAX_ATTEMPTS = 3;

export const DRAFT_MODEL = 'anthropic/claude-sonnet-4.6';

const draftSchema = z.object({
  newText: z.string().max(450),
});

const DRAFT_SYSTEM = `You are Curator, operations officer of ruslanshulga.com. Rewrite ONE piece of site copy to fix the style findings while preserving its meaning, facts, and voice (confident, direct, dry).

Hard rules:
- Fix every finding listed. Do not introduce new violations: NO em dashes or en dashes (— –) anywhere, ever; split into two sentences or use a comma instead. No "A, B, and C" triplets. No buzzwords (robust, comprehensive, seamless, cutting-edge, innovative, leverage). Under 400 characters.
- Keep every factual claim exactly as it was. Change structure and wording only.
- Return only the rewritten text.`;

export type DraftOutcome =
  | {
      ok: true;
      newText: string;
      attempts: number;
      usage: { inputTokens: number; outputTokens: number };
    }
  | {
      ok: false;
      reason: string;
      attempts: number;
      usage: { inputTokens: number; outputTokens: number };
    };

export async function draftRevision(options: {
  key: string;
  text: string;
  findings: CopyFinding[];
  model?: LanguageModel;
}): Promise<DraftOutcome> {
  const { key, text, findings, model = DRAFT_MODEL } = options;
  const usage = { inputTokens: 0, outputTokens: 0 };

  let criticNotes = findings.map((f) => `- [${f.rule}] ${f.note}`).join('\n');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await generateText({
        model,
        system: DRAFT_SYSTEM,
        prompt: `Copy key: ${key}\nCurrent text:\n"""${text}"""\n\nCritic's findings:\n${criticNotes}`,
        output: Output.object({ schema: draftSchema }),
        maxOutputTokens: 400,
        maxRetries: 1,
      });
      usage.inputTokens += result.usage.inputTokens ?? 0;
      usage.outputTokens += result.usage.outputTokens ?? 0;

      // Mechanical em-dash repair before Critic re-audits: the model's most
      // common reintroduced violation is fixed deterministically, not by luck.
      const draft = repairEmDashes(result.output.newText.trim());
      const violations = auditCopyEntry(key, draft);
      if (violations.length === 0 && draft.length > 0) {
        return { ok: true, newText: draft, attempts: attempt, usage };
      }
      criticNotes = violations.map((f) => `- [${f.rule}] ${f.note}`).join('\n');
    } catch (err) {
      console.error('[bridge] curator draft failed:', err);
      return { ok: false, reason: 'The draft call failed.', attempts: attempt, usage };
    }
  }
  return {
    ok: false,
    reason: `Critic rejected the draft ${MAX_ATTEMPTS} times.`,
    attempts: MAX_ATTEMPTS,
    usage,
  };
}
