import { Output, streamText, type LanguageModel, type UIMessage } from 'ai';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import { about } from '../../data/about';
import type { EnvoyKnowledge } from './agents/envoy';
import { appendEvent } from './persistence/events';
import { completeMission, createMission } from './persistence/missions';
import { recordSpend } from './persistence/budget';
import { estimateCostUsd } from './pricing';

// The Briefing Room: a recruiter types one line about their role and watches
// a bespoke one-pager assemble itself. Scout compiles a dossier (portfolio
// search + project list + the real latest commit), Curator writes sections
// that stream in one by one as validated elements, and the whole run is a
// mission on the board with spend on the meter. Grounding rule: Curator may
// only use facts from the dossier; project links are validated against real
// slugs so a hallucinated slug can never become a dead link.

export const CURATOR_MODEL = 'anthropic/claude-sonnet-4-6';

export type BriefingSectionData = {
  index: number;
  title: string;
  body: string;
  /** Validated link to a real case study or commit; never model-invented. */
  href?: string;
  linkLabel?: string;
  status: 'ready';
};

export type BriefingStatusData = {
  stage: 'dossier' | 'composing' | 'done' | 'failed';
  note: string;
};

export type BriefingUIMessage = UIMessage<
  never,
  { briefingSection: BriefingSectionData; briefingStatus: BriefingStatusData }
>;

/** Minimal writer surface (a subset of UIMessageStreamWriter.write). */
export type BriefingChunk =
  | { type: 'data-briefingSection'; id?: string; data: BriefingSectionData; transient?: boolean }
  | { type: 'data-briefingStatus'; id?: string; data: BriefingStatusData; transient?: boolean };

export type BriefingWriter = {
  write: (chunk: BriefingChunk) => void;
};

const sectionSchema = z.object({
  title: z.string().max(70),
  body: z.string().max(800),
  projectSlug: z
    .string()
    .optional()
    .describe('Slug of ONE relevant case study from the dossier, if this section is about it'),
});

export type BriefingDossier = {
  role: string;
  facts: { name: string; title: string; company: string; location: string };
  projects: Array<{ slug: string; title: string }>;
  passages: unknown;
  lastShipped: { repo: string; title: string; at: string; url: string } | null;
};

/** Visitor input lands in the public log and missions board; keep it tame. */
export function sanitizeRole(input: string): string {
  return input
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 140);
}

export async function buildDossier(options: {
  role: string;
  knowledge: EnvoyKnowledge;
  lastShipped: BriefingDossier['lastShipped'];
}): Promise<BriefingDossier> {
  const { role, knowledge, lastShipped } = options;
  const [passages, projects] = await Promise.all([
    knowledge.searchPortfolio(role, 6),
    knowledge.listProjects(),
  ]);
  return {
    role,
    facts: {
      name: about.name,
      title: about.role,
      company: about.company,
      location: about.location,
    },
    projects: projects.map((p) => ({
      slug: p.slug,
      title: (p as { title?: string }).title ?? p.slug,
    })),
    passages,
    lastShipped,
  };
}

const COMPOSE_SYSTEM = `You are Curator, operations officer on the Bridge of ruslanshulga.com. You write a short, specific briefing that pitches Ruslan Shulga to a recruiter for the role they described.

Hard rules:
- Use ONLY facts present in the dossier. Never invent numbers, employers, technologies, or outcomes. If the dossier is thin on something, say less.
- Write 4 to 6 sections. First: why Ruslan fits this specific role (reference their wording). Middle: 2-3 sections each anchored on ONE relevant case study (set projectSlug). One section may cover how he works. Last: a short, direct closing with a clear ask (email is in the dossier facts via the site).
- Each body is 2-4 sentences. Specific numbers over adjectives. No em dashes. No three-item lists. No buzzwords (robust, seamless, comprehensive, cutting-edge). Plain verbs: built, ran, shipped, cut.
- Address the recruiter as "you". Confident, direct, zero grovel.`;

export type RunBriefingDeps = {
  client: Client;
  writer: BriefingWriter;
  role: string;
  visitorId: string;
  knowledge: EnvoyKnowledge;
  lastShipped: BriefingDossier['lastShipped'];
  model: LanguageModel | string;
  nowIso?: string;
  /** Dev/no-key path: skip the LLM and assemble these instead. */
  scripted?: Array<{ title: string; body: string; projectSlug?: string }>;
  scriptedDelayMs?: number;
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sectionHref(
  dossier: BriefingDossier,
  projectSlug: string | undefined,
): Pick<BriefingSectionData, 'href' | 'linkLabel'> {
  if (!projectSlug) return {};
  const known = dossier.projects.find((p) => p.slug === projectSlug);
  if (!known) return {}; // hallucinated slug: drop the link, keep the prose
  return { href: `/work/${known.slug}`, linkLabel: `${known.title} case study` };
}

export async function runBriefing(deps: RunBriefingDeps): Promise<void> {
  const { client, writer, role, visitorId, knowledge, lastShipped, model } = deps;
  const nowIso = deps.nowIso ?? new Date().toISOString();

  const status = (data: BriefingStatusData) =>
    writer.write({ type: 'data-briefingStatus', data, transient: true });
  const section = (index: number, data: Omit<BriefingSectionData, 'index' | 'status'>) =>
    writer.write({
      type: 'data-briefingSection',
      id: `sec-${index}`,
      data: { ...data, index, status: 'ready' },
    });

  status({
    stage: 'dossier',
    note: 'Scout is compiling the dossier: portfolio, case studies, latest commits.',
  });
  const dossier = await buildDossier({ role, knowledge, lastShipped });

  const missionId = await createMission(
    client,
    { title: `Briefing: ${role}`, brief: role, assignee: 'curator', visitorId },
    nowIso,
  );
  await appendEvent(
    client,
    {
      actor: 'curator',
      kind: 'mission',
      summary: `Mission #${missionId}: composing a briefing for "${role}".`,
      missionId,
    },
    nowIso,
  );

  try {
    let count = 0;

    if (deps.scripted) {
      status({ stage: 'composing', note: 'Curator is writing (scripted dev mode, no model).' });
      for (const s of deps.scripted) {
        await delay(deps.scriptedDelayMs ?? 250);
        section(count, { title: s.title, body: s.body, ...sectionHref(dossier, s.projectSlug) });
        count += 1;
        status({ stage: 'composing', note: `Curator wrote section ${count}.` });
      }
    } else {
      status({
        stage: 'composing',
        note: 'Curator is writing. Sections land as they are finished.',
      });
      const result = streamText({
        model,
        system: COMPOSE_SYSTEM,
        prompt: `Recruiter's role line: "${dossier.role}"\n\nDossier (the only source of truth):\n${JSON.stringify(
          {
            facts: dossier.facts,
            projects: dossier.projects,
            passages: dossier.passages,
            lastShipped: dossier.lastShipped,
          },
          null,
          1,
        )}`,
        output: Output.array({ element: sectionSchema }),
        maxOutputTokens: 1500,
        maxRetries: 1,
      });

      // partialOutputStream emits the validated array as it grows; each new
      // complete element becomes a section card (same-id writes reconcile).
      for await (const partial of result.partialOutputStream) {
        for (let i = count; i < partial.length; i++) {
          const s = partial[i];
          section(i, { title: s.title, body: s.body, ...sectionHref(dossier, s.projectSlug) });
          status({ stage: 'composing', note: `Curator wrote section ${i + 1}.` });
        }
        count = partial.length;
      }

      const usage = await result.usage;
      const tokens = {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      };
      await recordSpend(
        client,
        { agent: 'curator', ...tokens, costUsd: estimateCostUsd(CURATOR_MODEL, tokens) },
        nowIso,
      );
    }

    if (count === 0) throw new Error('no sections produced');

    await completeMission(
      client,
      missionId,
      'done',
      `Briefing assembled: ${count} sections.`,
      nowIso,
    );
    await appendEvent(
      client,
      {
        actor: 'curator',
        kind: 'mission',
        summary: `Mission #${missionId} complete: briefing assembled, ${count} sections.`,
        missionId,
      },
      nowIso,
    );
    status({ stage: 'done', note: `Briefing assembled: ${count} sections, links verified.` });
  } catch (err) {
    console.error('[bridge] briefing failed:', err);
    await completeMission(client, missionId, 'failed', 'Composition failed mid-run.', nowIso);
    await appendEvent(
      client,
      {
        actor: 'curator',
        kind: 'mission',
        summary: `Mission #${missionId} failed: the composition did not finish.`,
        missionId,
      },
      nowIso,
    );
    status({ stage: 'failed', note: 'Composition failed. Send the role line again.' });
    throw err;
  }
}
