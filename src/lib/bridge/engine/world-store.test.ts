import { describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { createWorldStore } from './world-store';

type TestWorld = { tick: number; note: string };
type TestInteraction = { kind: string; value?: string };

function makeStore(overrides: { queueHardCap?: number } = {}) {
  const client = createClient({ url: ':memory:' });
  const store = createWorldStore<TestWorld, TestInteraction>({
    client,
    prefix: 'test',
    buildInitial: () => ({ tick: 0, note: 'seed' }),
    ...overrides,
  });
  return { client, store };
}

describe('createWorldStore', () => {
  it('rejects unsafe table prefixes', () => {
    expect(() =>
      createWorldStore({ client: null, prefix: 'bad-prefix;drop', buildInitial: () => ({}) }),
    ).toThrow(/Invalid table prefix/);
  });

  it('no-ops cleanly when no client is configured', async () => {
    const store = createWorldStore<TestWorld, TestInteraction>({
      client: null,
      prefix: 'test',
      buildInitial: () => ({ tick: 0, note: 'seed' }),
    });
    expect(store.isConfigured()).toBe(false);
    expect(await store.readState()).toBeNull();
    expect(await store.acquireLock(Date.now(), 1000)).toBe(false);
    expect(await store.enqueueInteraction({ kind: 'x' })).toBe(false);
    expect(await store.drainQueue()).toEqual([]);
    expect(await store.llmCallsToday()).toBe(0);
  });

  it('seeds the initial world and reads it back', async () => {
    const { store } = makeStore();
    const row = await store.readState();
    expect(row).not.toBeNull();
    expect(row?.version).toBe(0);
    expect(row?.world).toEqual({ tick: 0, note: 'seed' });
  });

  it('self-heals when the state row is deleted', async () => {
    const { client, store } = makeStore();
    await store.readState();
    await client.execute('DELETE FROM test_state');
    const row = await store.readState();
    expect(row?.world).toEqual({ tick: 0, note: 'seed' });
  });

  it('increments the version on every write and clears the lock', async () => {
    const { store } = makeStore();
    const now = Date.now();
    expect(await store.acquireLock(now, 60_000)).toBe(true);
    await store.writeState({ tick: 1, note: 'first' }, new Date().toISOString());
    const row = await store.readState();
    expect(row?.version).toBe(1);
    expect(row?.world.tick).toBe(1);
    // writeState released the lock, so it can be re-acquired immediately.
    expect(await store.acquireLock(now + 1, 60_000)).toBe(true);
  });

  it('grants the lock to exactly one of two racing callers', async () => {
    const { store } = makeStore();
    const now = Date.now();
    const [a, b] = await Promise.all([
      store.acquireLock(now, 60_000),
      store.acquireLock(now, 60_000),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('lets an expired lock be re-acquired', async () => {
    const { store } = makeStore();
    const now = Date.now();
    expect(await store.acquireLock(now, 1000)).toBe(true);
    expect(await store.acquireLock(now + 500, 1000)).toBe(false);
    expect(await store.acquireLock(now + 1001, 1000)).toBe(true);
  });

  it('releases the lock explicitly', async () => {
    const { store } = makeStore();
    const now = Date.now();
    expect(await store.acquireLock(now, 60_000)).toBe(true);
    await store.releaseLock();
    expect(await store.acquireLock(now + 1, 60_000)).toBe(true);
  });

  it('an owner-checked write is a no-op once the lease has been taken over', async () => {
    const { store } = makeStore();
    const now = Date.now();
    // Holder A takes a short lease, then it expires and successor B takes over.
    expect(await store.acquireLock(now, 1000)).toBe(true);
    const tokenA = now + 1000;
    expect(await store.acquireLock(now + 2000, 60_000)).toBe(true);
    const tokenB = now + 2000 + 60_000;

    // A finishes late and tries to write with its stale token: rejected, so it
    // can neither overwrite B's world nor clear B's lock.
    await store.writeState({ tick: 99, note: 'late-A' }, new Date().toISOString(), tokenA);
    expect((await store.readState())?.world.note).not.toBe('late-A');
    await store.releaseLock(tokenA);
    expect(await store.acquireLock(now + 3000, 60_000)).toBe(false); // B still holds it

    // B writes with its own token: accepted, and the lock clears.
    await store.writeState({ tick: 1, note: 'B' }, new Date().toISOString(), tokenB);
    expect((await store.readState())?.world.note).toBe('B');
  });

  it('queues and drains interactions in FIFO order', async () => {
    const { store } = makeStore();
    await store.enqueueInteraction({ kind: 'wave', value: 'a' });
    await store.enqueueInteraction({ kind: 'wave', value: 'b' });
    await store.enqueueInteraction({ kind: 'poke', value: 'c' });
    const drained = await store.drainQueue(2);
    expect(drained.map((d) => d.value)).toEqual(['a', 'b']);
    const rest = await store.drainQueue();
    expect(rest.map((d) => d.value)).toEqual(['c']);
    expect(await store.drainQueue()).toEqual([]);
  });

  it('enforces the queue hard cap', async () => {
    const { store } = makeStore({ queueHardCap: 2 });
    expect(await store.enqueueInteraction({ kind: 'a' })).toBe(true);
    expect(await store.enqueueInteraction({ kind: 'b' })).toBe(true);
    expect(await store.enqueueInteraction({ kind: 'c' })).toBe(false);
  });

  it('counts LLM calls per day', async () => {
    const { store } = makeStore();
    expect(await store.llmCallsToday()).toBe(0);
    await store.recordLlmCall();
    await store.recordLlmCall();
    expect(await store.llmCallsToday()).toBe(2);
  });

  it('keeps stores with different prefixes isolated on one database', async () => {
    const client = createClient({ url: ':memory:' });
    const a = createWorldStore<TestWorld, TestInteraction>({
      client,
      prefix: 'alpha',
      buildInitial: () => ({ tick: 0, note: 'alpha' }),
    });
    const b = createWorldStore<TestWorld, TestInteraction>({
      client,
      prefix: 'beta',
      buildInitial: () => ({ tick: 0, note: 'beta' }),
    });
    await a.writeState({ tick: 9, note: 'alpha' }, new Date().toISOString());
    expect((await a.readState())?.world.note).toBe('alpha');
    expect((await b.readState())?.world.note).toBe('beta');
  });
});
