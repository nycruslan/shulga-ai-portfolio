import { describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import {
  buildDossier,
  runBriefing,
  sanitizeRole,
  type BriefingSectionData,
  type BriefingStatusData,
  type BriefingWriter,
} from './briefing';
import type { EnvoyKnowledge } from './agents/envoy';
import { listMissions } from './persistence/missions';
import { listEvents } from './persistence/events';
import { daySpend } from './persistence/budget';

const NOW = '2026-06-12T12:00:00.000Z';
const db = () => createClient({ url: ':memory:' });

const knowledge: EnvoyKnowledge = {
  searchPortfolio: async () => [{ text: 'cut eval latency ~55%', score: 0.9 }],
  getProject: async () => null,
  listProjects: async () => [
    { slug: 'multi-agent-platform', title: 'Multi-agent platform' } as { slug: string },
    { slug: 'hybrid-rag', title: 'Hybrid RAG' } as { slug: string },
  ],
  readEvalRuns: async () => [],
};

const lastShipped = {
  repo: 'nycruslan/shulga-ai-portfolio',
  title: 'feat: bridge',
  at: '2026-06-12T11:00:00Z',
  url: 'https://github.com/nycruslan/shulga-ai-portfolio/commit/abc',
};

type Chunk = Parameters<BriefingWriter['write']>[0];
const collect = () => {
  const chunks: Chunk[] = [];
  return { chunks, writer: { write: (c: Chunk) => chunks.push(c) } as BriefingWriter };
};

// Mock Curator: emits the {"elements":[...]} JSON Output.array expects,
// including one hallucinated projectSlug that must NOT become a link.
function mockCurator() {
  const json = JSON.stringify({
    elements: [
      { title: 'Why this fits', body: 'You asked for X. He built X twice.' },
      {
        title: 'Multi-agent platform',
        body: 'Built and ran it.',
        projectSlug: 'multi-agent-platform',
      },
      { title: 'Made up', body: 'This slug does not exist.', projectSlug: 'not-a-real-project' },
    ],
  });
  const deltas: LanguageModelV3StreamPart[] = [];
  for (let i = 0; i < json.length; i += 32) {
    deltas.push({ type: 'text-delta', id: 't0', delta: json.slice(i, i + 32) });
  }
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't0' },
        ...deltas,
        { type: 'text-end', id: 't0' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 300, text: 300, reasoning: undefined },
            totalTokens: 1200,
          },
        },
      ]),
    }),
  });
}

describe('sanitizeRole', () => {
  it('strips newlines, collapses whitespace, and caps length', () => {
    expect(sanitizeRole('  senior\n\nfrontend\t engineer  ')).toBe('senior frontend engineer');
    expect(sanitizeRole('x'.repeat(300))).toHaveLength(140);
  });
});

describe('buildDossier', () => {
  it('assembles real facts, projects, passages, and the last commit', async () => {
    const dossier = await buildDossier({ role: 'frontend role', knowledge, lastShipped });
    expect(dossier.facts.name).toBeTruthy();
    expect(dossier.projects.map((p) => p.slug)).toContain('multi-agent-platform');
    expect(dossier.lastShipped?.url).toContain('github.com');
  });
});

describe('runBriefing (mock Curator, real Output.array path)', () => {
  it('streams sections as same-id data parts, validates links, logs the mission, records spend', async () => {
    const client = db();
    const { chunks, writer } = collect();

    await runBriefing({
      client,
      writer,
      role: 'Senior frontend engineer, AI fintech',
      visitorId: 'vis-recruiter',
      knowledge,
      lastShipped,
      model: mockCurator(),
      nowIso: NOW,
    });

    const sections = chunks.filter((c) => c.type === 'data-briefingSection');
    expect(sections).toHaveLength(3);
    expect(sections.map((s) => s.id)).toEqual(['sec-0', 'sec-1', 'sec-2']);

    // Real slug -> real link; hallucinated slug -> prose survives, link dropped.
    const linked = sections[1].data as BriefingSectionData;
    expect(linked.href).toBe('/work/multi-agent-platform');
    const hallucinated = sections[2].data as BriefingSectionData;
    expect(hallucinated.href).toBeUndefined();
    expect(hallucinated.body).toContain('slug does not exist');

    // Status parts are transient and end on 'done'.
    const statuses = chunks.filter((c) => c.type === 'data-briefingStatus');
    expect(statuses.every((s) => s.transient)).toBe(true);
    expect((statuses.at(-1)?.data as BriefingStatusData).stage).toBe('done');

    // Mission ledger: created with visitor attribution, completed 'done'.
    const [mission] = await listMissions(client);
    expect(mission).toMatchObject({
      status: 'done',
      assignee: 'curator',
      visitorId: 'vis-recruiter',
    });
    const events = await listEvents(client);
    expect(events.filter((e) => e.kind === 'mission')).toHaveLength(2);

    // Spend on the meter, with real token counts from the run.
    const spend = await daySpend(client, NOW, 'curator');
    expect(spend.llmCalls).toBe(1);
    expect(spend.inputTokens).toBe(900);
    expect(spend.costUsd).toBeGreaterThan(0);
  });

  it('scripted path assembles without any model call', async () => {
    const client = db();
    const { chunks, writer } = collect();
    await runBriefing({
      client,
      writer,
      role: 'Any role at all here',
      visitorId: 'vis-dev',
      knowledge,
      lastShipped: null,
      model: 'unused-model-string',
      nowIso: NOW,
      scripted: [{ title: 'A', body: 'b', projectSlug: 'hybrid-rag' }],
      scriptedDelayMs: 1,
    });
    const sections = chunks.filter((c) => c.type === 'data-briefingSection');
    expect(sections).toHaveLength(1);
    expect((sections[0].data as BriefingSectionData).href).toBe('/work/hybrid-rag');
    expect((await daySpend(client, NOW, 'curator')).llmCalls).toBe(0);
    expect((await listMissions(client))[0].status).toBe('done');
  });

  it('fails the mission honestly when composition dies', async () => {
    const client = db();
    const { chunks, writer } = collect();
    const broken = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error('model exploded');
      },
    });
    await expect(
      runBriefing({
        client,
        writer,
        role: 'Some role description',
        visitorId: 'vis-x',
        knowledge,
        lastShipped: null,
        model: broken,
        nowIso: NOW,
      }),
    ).rejects.toThrow();

    const [mission] = await listMissions(client);
    expect(mission.status).toBe('failed');
    expect((chunks.at(-1)?.data as BriefingStatusData).stage).toBe('failed');
    const events = await listEvents(client);
    expect(events.some((e) => e.summary.includes('failed'))).toBe(true);
  });
});
