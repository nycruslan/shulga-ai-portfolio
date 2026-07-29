import { z } from 'zod';

/**
 * Twin config shape and the pure logic over it.
 *
 * Kept free of any Turso import so it stays unit-testable and usable from the
 * browser island, same split as playground-schema.ts vs turso.ts.
 */

export const factsSchema = z.object({
  /** Shown to the model as the twin's own name. */
  name: z.string().trim().max(80).default(''),
  /** One or two sentences: who you are. */
  bio: z.string().trim().max(1500).default(''),
  /** Concrete verbal habits. Free text, one per line. */
  speech: z.string().trim().max(1500).default(''),
  /** Real opinions, one per line. Vague values make a twin sound generic. */
  opinions: z.string().trim().max(1500).default(''),
  /** Things that would be out of character. */
  avoid: z.string().trim().max(1000).default(''),
  /** Timeline, jobs, projects. One per line. */
  history: z.string().trim().max(2000).default(''),
});

export type TwinFacts = z.infer<typeof factsSchema>;

export interface TwinConfig {
  avatarId: string | null;
  avatarProvider: 'anam' | 'liveavatar' | null;
  avatarPreviewUrl: string | null;
  voiceId: string | null;
  voiceName: string | null;
  facts: TwinFacts;
  updatedAt: string | null;
}

export const EMPTY_FACTS: TwinFacts = factsSchema.parse({});

export const EMPTY_CONFIG: TwinConfig = {
  avatarId: null,
  avatarProvider: null,
  avatarPreviewUrl: null,
  voiceId: null,
  voiceName: null,
  facts: EMPTY_FACTS,
  updatedAt: null,
};

/**
 * Completeness, 0-100.
 *
 * Borrowed from Delphi's "Mind Score": a progress number makes "how much is
 * enough?" answerable, which is the hardest part of persona setup. Face and
 * voice are weighted heavily because they are what people react to first;
 * the fact fields split the rest so a half-filled brief reads as half-done.
 */
export function completeness(c: TwinConfig): number {
  const filled = (s: string | undefined) => (s ?? '').trim().length > 0;
  const checks: Array<[boolean, number]> = [
    [!!c.avatarId, 25],
    [!!c.voiceId, 25],
    [filled(c.facts.name), 5],
    [filled(c.facts.bio), 15],
    [filled(c.facts.speech), 10],
    [filled(c.facts.opinions), 10],
    [filled(c.facts.history), 7],
    [filled(c.facts.avoid), 3],
  ];
  return checks.reduce((sum, [ok, weight]) => sum + (ok ? weight : 0), 0);
}

/**
 * The persona brief handed to the model, assembled from the fact fields.
 * Returns null when there's nothing worth sending, so the worker falls back
 * to its own persona.md rather than being handed an empty shell.
 *
 * `name` is deliberately excluded: it is passed to the avatar provider
 * separately and would only add noise to the prompt.
 */
export function buildPersona(c: TwinConfig): string | null {
  const f = c.facts;
  const parts: string[] = [];
  const add = (heading: string, body: string | undefined) => {
    if ((body ?? '').trim()) parts.push(`## ${heading}\n\n${body!.trim()}`);
  };

  add('Who I am', f.bio);
  add('How I talk', f.speech);
  add('What I care about', f.opinions);
  add("What I don't do", f.avoid);
  add('Facts about my life', f.history);

  if (!parts.length) return null;
  return parts.join('\n\n');
}
