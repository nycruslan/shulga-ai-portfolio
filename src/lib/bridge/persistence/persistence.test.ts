import { describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { appendEvent, countEventsSince, listEvents } from './events';
import { daySpend, isOverBudget, recordSpend } from './budget';

const db = () => createClient({ url: ':memory:' });

describe('events', () => {
  it('appends and lists events with full payload round-trip', async () => {
    const client = db();
    const id = await appendEvent(client, {
      actor: 'scout',
      kind: 'tool_call',
      summary: 'Scout is reading 14 commits from this week.',
      detail: { tool: 'listCommits', count: 14 },
      link: 'https://github.com/x/y/commit/abc',
      missionId: 7,
      generationId: 'gen_123',
    });
    expect(id).toBeGreaterThan(0);
    const [event] = await listEvents(client);
    expect(event).toMatchObject({
      id,
      actor: 'scout',
      kind: 'tool_call',
      summary: 'Scout is reading 14 commits from this week.',
      detail: { tool: 'listCommits', count: 14 },
      link: 'https://github.com/x/y/commit/abc',
      missionId: 7,
      generationId: 'gen_123',
    });
    expect(event.createdAt).toBeTruthy();
  });

  it('treats optional fields as absent, not null', async () => {
    const client = db();
    await appendEvent(client, { actor: 'engine', kind: 'tick', summary: 'Tick 1 complete.' });
    const [event] = await listEvents(client);
    expect(event.detail).toBeUndefined();
    expect(event.link).toBeUndefined();
    expect(event.missionId).toBeUndefined();
  });

  it('pages forward with the afterId cursor', async () => {
    const client = db();
    for (let i = 1; i <= 5; i++) {
      await appendEvent(client, { actor: 'engine', kind: 'tick', summary: `Tick ${i}.` });
    }
    const first = await listEvents(client, { limit: 2 });
    // Without a cursor we get the NEWEST window, in chronological order.
    expect(first.map((e) => e.summary)).toEqual(['Tick 4.', 'Tick 5.']);
    const fromCursor = await listEvents(client, { afterId: 2 });
    expect(fromCursor.map((e) => e.summary)).toEqual(['Tick 3.', 'Tick 4.', 'Tick 5.']);
  });

  it('a polling cursor advances contiguously through a burst larger than the limit', async () => {
    const client = db();
    // Poller establishes a cursor on a quiet feed (newest window).
    await appendEvent(client, { actor: 'engine', kind: 'tick', summary: 'Tick 1.' });
    const fresh = await listEvents(client, { afterId: 0, limit: 2 });
    expect(fresh.map((e) => e.id)).toEqual([1]);
    // A burst arrives, larger than the poll limit. Paging from the cursor must
    // hand back the OLDEST unseen first, so nothing in the gap is ever skipped.
    for (let i = 2; i <= 6; i++) {
      await appendEvent(client, { actor: 'engine', kind: 'tick', summary: `Tick ${i}.` });
    }
    let cursor = fresh.at(-1)!.id;
    const seen: number[] = [];
    for (let p = 0; p < 6; p++) {
      const page = await listEvents(client, { afterId: cursor, limit: 2 });
      if (!page.length) break;
      seen.push(...page.map((e) => e.id));
      cursor = page.at(-1)!.id;
    }
    expect(seen).toEqual([2, 3, 4, 5, 6]);
  });

  it('countEventsSince counts exactly, past any list limit', async () => {
    const client = db();
    for (let i = 0; i < 7; i++) {
      await appendEvent(
        client,
        { actor: 'engine', kind: 'tick', summary: `e${i}` },
        i < 3 ? '2026-06-26T23:00:00.000Z' : '2026-06-27T08:00:00.000Z',
      );
    }
    expect(await countEventsSince(client, '2026-06-27T00:00:00.000Z')).toBe(4);
    expect(await countEventsSince(client, '2026-06-26T00:00:00.000Z')).toBe(7);
  });
});

describe('budget', () => {
  it('accumulates calls, tokens, and cost per agent per day', async () => {
    const client = db();
    const day = '2026-06-12T10:00:00.000Z';
    await recordSpend(
      client,
      { agent: 'scout', inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
      day,
    );
    await recordSpend(
      client,
      { agent: 'scout', inputTokens: 200, outputTokens: 80, costUsd: 0.02 },
      day,
    );
    await recordSpend(
      client,
      { agent: 'critic', inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      day,
    );
    const scout = await daySpend(client, day, 'scout');
    expect(scout).toEqual({ llmCalls: 2, inputTokens: 300, outputTokens: 130, costUsd: 0.03 });
    const total = await daySpend(client, day);
    expect(total.llmCalls).toBe(3);
    expect(total.costUsd).toBeCloseTo(0.031);
  });

  it('separates days and reports zero for empty days', async () => {
    const client = db();
    await recordSpend(client, { agent: 'scout' }, '2026-06-11T23:59:00.000Z');
    expect((await daySpend(client, '2026-06-12T00:01:00.000Z')).llmCalls).toBe(0);
  });

  it('enforces caps via isOverBudget', async () => {
    const client = db();
    const day = '2026-06-12T10:00:00.000Z';
    expect(await isOverBudget(client, 2, day)).toBe(false);
    await recordSpend(client, { agent: 'scout' }, day);
    await recordSpend(client, { agent: 'scout' }, day);
    expect(await isOverBudget(client, 2, day)).toBe(true);
    expect(await isOverBudget(client, 2, day, 'critic')).toBe(false);
  });
});
