import { describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { acquireLease, releaseLease, renewLease } from './leases';
import { appendEvent, listEvents } from './events';
import { daySpend, isOverBudget, recordSpend } from './budget';

const db = () => createClient({ url: ':memory:' });

describe('leases', () => {
  it('grants a free lease and refuses a held one', async () => {
    const client = db();
    const now = Date.now();
    expect(await acquireLease(client, 'tick', 'a', 60_000, now)).toBe(true);
    expect(await acquireLease(client, 'tick', 'b', 60_000, now + 1)).toBe(false);
  });

  it('grants exactly one of two racing callers', async () => {
    const client = db();
    const now = Date.now();
    const [a, b] = await Promise.all([
      acquireLease(client, 'tick', 'a', 60_000, now),
      acquireLease(client, 'tick', 'b', 60_000, now),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('lets an expired lease be taken over', async () => {
    const client = db();
    const now = Date.now();
    expect(await acquireLease(client, 'tick', 'a', 1000, now)).toBe(true);
    expect(await acquireLease(client, 'tick', 'b', 1000, now + 1001)).toBe(true);
  });

  it('keeps independent named leases independent', async () => {
    const client = db();
    const now = Date.now();
    expect(await acquireLease(client, 'tick', 'a', 60_000, now)).toBe(true);
    expect(await acquireLease(client, 'audit', 'a', 60_000, now)).toBe(true);
  });

  it('renews only for the current holder', async () => {
    const client = db();
    const now = Date.now();
    await acquireLease(client, 'tick', 'a', 1000, now);
    expect(await renewLease(client, 'tick', 'a', 60_000, now + 500)).toBe(true);
    expect(await renewLease(client, 'tick', 'b', 60_000, now + 500)).toBe(false);
    // Renewal extended the lease well past the original TTL.
    expect(await acquireLease(client, 'tick', 'b', 1000, now + 2000)).toBe(false);
  });

  it('release is a no-op for a stale holder, so a slow holder cannot stomp a successor', async () => {
    const client = db();
    const now = Date.now();
    await acquireLease(client, 'tick', 'a', 1000, now);
    await acquireLease(client, 'tick', 'b', 60_000, now + 1001); // a expired, b took over
    await releaseLease(client, 'tick', 'a'); // stale release
    expect(await acquireLease(client, 'tick', 'c', 1000, now + 1002)).toBe(false);
    await releaseLease(client, 'tick', 'b');
    expect(await acquireLease(client, 'tick', 'c', 1000, now + 1003)).toBe(true);
  });
});

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
