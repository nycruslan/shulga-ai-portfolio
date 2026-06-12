import { createClient, type Client } from '@libsql/client';
import { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN } from 'astro:env/server';
import type { GardenInteraction, GardenState } from './types';
import { buildInitialGarden } from './seed';

// Single source of truth for the garden: one Turso row holds the whole world as
// JSON, with a version and a lease-based lock so exactly one tick advances at a
// time. A small queue holds visitor interactions; a per-day counter caps Haiku
// spend. Same shape as the Substrate store, proven and atomic.

const client: Client | null =
  TURSO_DATABASE_URL && TURSO_AUTH_TOKEN
    ? createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN })
    : null;

export const isConfigured = () => client !== null;

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!client) return Promise.resolve();
  schemaReady ??= (async () => {
    await client.batch(
      [
        `CREATE TABLE IF NOT EXISTS garden_state (
           id INTEGER PRIMARY KEY,
           version INTEGER NOT NULL DEFAULT 0,
           world TEXT NOT NULL,
           ticked_at TEXT NOT NULL,
           lock_until INTEGER NOT NULL DEFAULT 0,
           updated_at TEXT NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS garden_queue (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           created_at TEXT NOT NULL,
           kind TEXT NOT NULL,
           payload TEXT NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS garden_budget (
           day TEXT PRIMARY KEY,
           llm_calls INTEGER NOT NULL DEFAULT 0
         )`,
      ],
      'write'
    );
    const now = new Date().toISOString();
    await client.execute({
      sql: 'INSERT OR IGNORE INTO garden_state (id, version, world, ticked_at, lock_until, updated_at) VALUES (1, 0, ?, ?, 0, ?)',
      args: [JSON.stringify(buildInitialGarden(now)), now, now],
    });
  })();
  return schemaReady;
}

export type StateRow = { version: number; state: GardenState; tickedAt: string };

export async function readState(): Promise<StateRow | null> {
  if (!client) return null;
  await ensureSchema();
  let rs = await client.execute('SELECT version, world, ticked_at FROM garden_state WHERE id = 1');
  if (!rs.rows[0]) {
    const now = new Date().toISOString();
    await client.execute({
      sql: 'INSERT OR IGNORE INTO garden_state (id, version, world, ticked_at, lock_until, updated_at) VALUES (1, 0, ?, ?, 0, ?)',
      args: [JSON.stringify(buildInitialGarden(now)), now, now],
    });
    rs = await client.execute('SELECT version, world, ticked_at FROM garden_state WHERE id = 1');
  }
  const row = rs.rows[0];
  if (!row) return null;
  try {
    return { version: Number(row.version), state: JSON.parse(String(row.world)) as GardenState, tickedAt: String(row.ticked_at) };
  } catch {
    return null;
  }
}

// Atomic lease: succeeds for exactly one caller while the lock is free/expired.
export async function acquireLock(nowMs: number, ttlMs: number): Promise<boolean> {
  if (!client) return false;
  await ensureSchema();
  const rs = await client.execute({
    sql: 'UPDATE garden_state SET lock_until = ? WHERE id = 1 AND lock_until < ?',
    args: [nowMs + ttlMs, nowMs],
  });
  return rs.rowsAffected === 1;
}

export async function writeState(state: GardenState, tickedAtIso: string): Promise<void> {
  if (!client) return;
  await client.execute({
    sql: 'UPDATE garden_state SET version = version + 1, world = ?, ticked_at = ?, lock_until = 0, updated_at = ? WHERE id = 1',
    args: [JSON.stringify(state), tickedAtIso, new Date().toISOString()],
  });
}

export async function releaseLock(): Promise<void> {
  if (!client) return;
  await client.execute('UPDATE garden_state SET lock_until = 0 WHERE id = 1');
}

const QUEUE_HARD_CAP = 60;

export async function enqueueInteraction(it: GardenInteraction): Promise<boolean> {
  if (!client) return false;
  await ensureSchema();
  const count = await client.execute('SELECT COUNT(*) AS n FROM garden_queue');
  if (Number(count.rows[0]?.n ?? 0) >= QUEUE_HARD_CAP) return false;
  await client.execute({
    sql: 'INSERT INTO garden_queue (created_at, kind, payload) VALUES (?, ?, ?)',
    args: [new Date().toISOString(), it.kind, JSON.stringify(it)],
  });
  return true;
}

export async function drainQueue(limit = 6): Promise<GardenInteraction[]> {
  if (!client) return [];
  const rs = await client.execute({ sql: 'SELECT id, payload FROM garden_queue ORDER BY id LIMIT ?', args: [limit] });
  if (!rs.rows.length) return [];
  const ids = rs.rows.map((r) => Number(r.id));
  const items = rs.rows
    .map((r) => {
      try {
        return JSON.parse(String(r.payload)) as GardenInteraction;
      } catch {
        return null;
      }
    })
    .filter((x): x is GardenInteraction => x !== null);
  await client.execute({ sql: `DELETE FROM garden_queue WHERE id IN (${ids.map(() => '?').join(',')})`, args: ids });
  return items;
}

const today = () => new Date().toISOString().slice(0, 10);

export async function llmCallsToday(): Promise<number> {
  if (!client) return 0;
  const rs = await client.execute({ sql: 'SELECT llm_calls FROM garden_budget WHERE day = ?', args: [today()] });
  return rs.rows[0] ? Number(rs.rows[0].llm_calls) : 0;
}

export async function recordLlmCall(): Promise<void> {
  if (!client) return;
  await client.execute({
    sql: 'INSERT INTO garden_budget (day, llm_calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET llm_calls = llm_calls + 1',
    args: [today()],
  });
}
