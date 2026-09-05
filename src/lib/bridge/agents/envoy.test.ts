import { describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { readUIMessageStream } from 'ai';
import { buildEnvoyAgent, type DispatchProgress } from './envoy';
import { mockEnvoyModel, mockScoutModel } from './mock-models';
import { listMissions, createMission, failStaleMissions } from '../persistence/missions';
import { saveConversation, loadConversation } from '../persistence/messages';
import { listEvents } from '../persistence/events';

const db = () => createClient({ url: ':memory:' });
const NOW = '2026-06-12T12:00:00.000Z';

// GitHub fetch inside Scout's tool is real; stub fetch so tests are hermetic.
const fakeGithubFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify([
      {
        id: '42',
        type: 'PushEvent',
        repo: { name: 'nycruslan/shulga-ai-portfolio' },
        created_at: '2026-06-12T11:00:00Z',
        payload: {
          ref: 'refs/heads/master',
          commits: [{ sha: 'abc1234def0', message: 'feat: real thing' }],
        },
      },
    ]),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

describe('mission persistence', () => {
  it('creates, completes, and lists missions with visitor attribution', async () => {
    const client = db();
    const id = await createMission(
      client,
      { title: 'check the feed', brief: 'check', assignee: 'scout', visitorId: 'vis-abc' },
      NOW,
    );
    const [m] = await listMissions(client);
    expect(m).toMatchObject({ id, status: 'running', assignee: 'scout', visitorId: 'vis-abc' });
  });

  it('sweeps stale running missions to failed, leaving fresh ones alone', async () => {
    const client = db();
    const stale = await createMission(client, { title: 'old', brief: 'old' }, NOW);
    const fresh = await createMission(
      client,
      { title: 'new', brief: 'new' },
      '2026-06-12T12:09:30.000Z',
    );
    const failed = await failStaleMissions(client, '2026-06-12T12:11:00.000Z');
    expect(failed).toEqual([stale]);
    const missions = await listMissions(client);
    expect(missions.find((m) => m.id === stale)?.status).toBe('failed');
    expect(missions.find((m) => m.id === fresh)?.status).toBe('running');
  });
});

describe('conversation persistence', () => {
  it('round-trips UIMessages and overwrites atomically', async () => {
    const client = db();
    const m1 = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
    const m2 = [...m1, { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }];
    // @ts-expect-error minimal UIMessage shapes are fine for storage
    await saveConversation(client, 'con-1', 'owner-1', 'vis-1', m1, NOW);
    // @ts-expect-error minimal UIMessage shapes are fine for storage
    await saveConversation(client, 'con-1', 'owner-1', 'vis-1', m2, NOW);
    expect(
      // @ts-expect-error minimal UIMessage shapes are fine for storage
      await saveConversation(client, 'con-1', 'owner-2', 'vis-2', m1, NOW),
    ).toBe(false);
    const loaded = await loadConversation(client, 'con-1', 'owner-1');
    expect(loaded).toHaveLength(2);
    expect(loaded?.[1].id).toBe('a1');
    expect(await loadConversation(client, 'con-1', 'owner-2')).toBeNull();
  });

  it('returns [] for unknown conversations and corrupt rows', async () => {
    const client = db();
    expect(await loadConversation(client, 'nope', 'owner-1')).toEqual([]);
  });
});

describe('envoy dispatch flow (mock models, real persistence)', () => {
  it('runs a full mission: row created, scout streams, outcome and events filed', async () => {
    const client = db();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeGithubFetch;
    try {
      const agent = buildEnvoyAgent({
        client,
        visitorId: 'vis-test',
        username: 'nycruslan',
        model: mockEnvoyModel(),
        scoutModel: mockScoutModel(),
      });

      const run = await agent.stream({
        messages: [{ role: 'user', content: 'What shipped this week?' }],
      });
      let final;
      for await (const message of readUIMessageStream({ stream: run.toUIMessageStream() })) {
        final = message;
      }

      // Mission row: created by the dispatch tool, completed with Scout's report.
      const [mission] = await listMissions(client);
      expect(mission).toMatchObject({ status: 'done', assignee: 'scout', visitorId: 'vis-test' });
      expect(mission.outcome).toContain('[mock] Sweep done.');

      // Ship's log: dispatch + completion events with the mission id attached.
      const events = await listEvents(client);
      const missionEvents = events.filter((e) => e.kind === 'mission');
      expect(missionEvents).toHaveLength(2);
      expect(missionEvents[0].summary).toContain(`Mission #${mission.id} dispatched to Scout`);
      expect(missionEvents[1].summary).toContain(`Mission #${mission.id} complete`);

      // The visitor-facing stream carried the dispatch tool part to 'done'.
      const toolPart = final?.parts.find((p) => p.type === 'tool-dispatch_scout');
      expect(toolPart).toBeDefined();
      if (toolPart && 'output' in toolPart) {
        expect((toolPart.output as DispatchProgress).state).toBe('done');
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('fails the mission honestly when GitHub is down', async () => {
    const client = db();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('boom', { status: 500 });
    try {
      const agent = buildEnvoyAgent({
        client,
        visitorId: 'vis-test',
        username: 'nycruslan',
        model: mockEnvoyModel(),
        scoutModel: mockScoutModel(),
      });
      const run = await agent.stream({
        messages: [{ role: 'user', content: 'What shipped this week?' }],
      });
      for await (const _ of readUIMessageStream({ stream: run.toUIMessageStream() })) {
        /* drain */
      }
      const [mission] = await listMissions(client);
      expect(mission.status).toBe('failed');
      expect(mission.outcome).toContain("GitHub isn't responding");
      const events = await listEvents(client);
      expect(events.some((e) => e.summary.includes('failed'))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
