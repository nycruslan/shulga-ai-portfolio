import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { buildInitialBridgeWorld } from '../engine/tick';
import { createWorldStore } from '../engine/world-store';
import { listEvents } from './events';
import { commitBridgeTick } from './commit-tick';

const databases: Array<{ client: Client; path: string }> = [];

function setup() {
  const path = join(tmpdir(), `bridge-${randomUUID()}.db`);
  const client = createClient({ url: `file:${path}` });
  databases.push({ client, path });
  const store = createWorldStore({
    client,
    prefix: 'bridge_core',
    buildInitial: buildInitialBridgeWorld,
  });
  return { client, store };
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.client.close();
    rmSync(database.path, { force: true });
  }
});

describe('commitBridgeTick', () => {
  it('commits the world and its events together', async () => {
    const { client, store } = setup();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const row = await store.readState();
    expect(row).not.toBeNull();
    expect(await store.acquireLock(nowMs, 60_000)).toBe(true);

    const world = { ...row!.world, tick: 1, lastTickAt: nowIso };
    expect(
      await commitBridgeTick(client, {
        world,
        expectedVersion: row!.version,
        lockToken: nowMs + 60_000,
        tickedAtIso: nowIso,
        events: [{ actor: 'engine', kind: 'tick', summary: 'Tick 1 complete.' }],
      }),
    ).toBe(true);

    expect(await store.readState()).toMatchObject({ version: 1, world: { tick: 1 } });
    expect((await listEvents(client)).map((event) => event.summary)).toEqual(['Tick 1 complete.']);
  });

  it('rejects a stale or expired lease without writing events', async () => {
    const { client, store } = setup();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const row = await store.readState();
    const liveToken = nowMs + 60_000;
    expect(await store.acquireLock(nowMs, 60_000)).toBe(true);

    const input = {
      world: { ...row!.world, tick: 1, lastTickAt: nowIso },
      expectedVersion: row!.version,
      tickedAtIso: nowIso,
      events: [{ actor: 'engine' as const, kind: 'tick', summary: 'Must not persist.' }],
    };
    expect(await commitBridgeTick(client, { ...input, lockToken: liveToken + 1 })).toBe(false);
    await store.releaseLock(liveToken);

    const expiredAt = nowMs - 60_000;
    expect(await store.acquireLock(expiredAt - 60_000, 60_000)).toBe(true);
    expect(await commitBridgeTick(client, { ...input, lockToken: expiredAt })).toBe(false);
    expect((await store.readState())?.world.tick).toBe(0);
    expect(await listEvents(client)).toEqual([]);
  });

  it('rolls back every event when the expected version is stale', async () => {
    const { client, store } = setup();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const row = await store.readState();
    expect(await store.acquireLock(nowMs, 60_000)).toBe(true);
    expect(
      await commitBridgeTick(client, {
        world: { ...row!.world, tick: 1, lastTickAt: nowIso },
        expectedVersion: row!.version,
        lockToken: nowMs + 60_000,
        tickedAtIso: nowIso,
        events: [],
      }),
    ).toBe(true);

    const nextNowMs = nowMs + 1;
    expect(await store.acquireLock(nextNowMs, 60_000)).toBe(true);
    expect(
      await commitBridgeTick(client, {
        world: { ...row!.world, tick: 99, lastTickAt: nowIso },
        expectedVersion: row!.version,
        lockToken: nextNowMs + 60_000,
        tickedAtIso: nowIso,
        events: [{ actor: 'engine', kind: 'tick', summary: 'Must not persist.' }],
      }),
    ).toBe(false);

    expect((await store.readState())?.world.tick).toBe(1);
    expect(await listEvents(client)).toEqual([]);
    await store.releaseLock(nextNowMs + 60_000);
  });
});
