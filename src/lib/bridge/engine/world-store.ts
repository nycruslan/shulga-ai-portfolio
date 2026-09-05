import type { Client } from '@libsql/client';

// Generic single-row world store: one Turso row holds a world as JSON with a
// version and a lease-based lock so exactly one tick advances at a time. A
// small queue holds visitor interactions; a per-day counter caps LLM spend.
// This is the shared engine behind the Substrate and Garden stores (previously
// duplicated line-for-line) and the foundation the Bridge builds on.
//
// The client is injected so the engine has no Astro dependency and tests run
// against an in-memory libsql database.

export type WorldStoreOptions<TWorld> = {
  client: Client | null;
  /** Table prefix, e.g. 'substrate' -> substrate_state / substrate_queue / substrate_budget. */
  prefix: string;
  buildInitial: (nowIso: string) => TWorld;
  queueHardCap?: number;
};

export type WorldStateRow<TWorld> = {
  version: number;
  world: TWorld;
  tickedAt: string;
};

export type WorldStore<TWorld, TInteraction> = {
  isConfigured: () => boolean;
  readState: () => Promise<WorldStateRow<TWorld> | null>;
  acquireLock: (nowMs: number, ttlMs: number) => Promise<boolean>;
  // A lease token is just the lock_until value the holder set (nowMs + ttlMs).
  // When passed, writeState/releaseLock only clear a lease this caller still
  // owns, so a slow tick whose lease already expired can't wipe a successor's
  // lock or overwrite its world. Omit it (Substrate/Garden, tests) to clear
  // unconditionally as before.
  writeState: (world: TWorld, tickedAtIso: string, lockToken?: number) => Promise<boolean>;
  renewLock: (lockToken: number, nowMs: number, ttlMs: number) => Promise<number | null>;
  releaseLock: (lockToken?: number) => Promise<void>;
  enqueueInteraction: (it: TInteraction & { kind: string }) => Promise<boolean>;
  drainQueue: (limit?: number) => Promise<TInteraction[]>;
  llmCallsToday: () => Promise<number>;
  recordLlmCall: () => Promise<void>;
};

const PREFIX_RE = /^[a-z][a-z0-9_]*$/;

export function createWorldStore<TWorld, TInteraction>(
  opts: WorldStoreOptions<TWorld>,
): WorldStore<TWorld, TInteraction> {
  const { client, prefix, buildInitial, queueHardCap = 60 } = opts;
  if (!PREFIX_RE.test(prefix)) {
    throw new Error(`Invalid table prefix: ${prefix}`);
  }
  const stateTable = `${prefix}_state`;
  const queueTable = `${prefix}_queue`;
  const budgetTable = `${prefix}_budget`;

  let schemaReady: Promise<void> | null = null;

  function ensureSchema(): Promise<void> {
    if (!client) return Promise.resolve();
    schemaReady ??= (async () => {
      await client.batch(
        [
          `CREATE TABLE IF NOT EXISTS ${stateTable} (
             id INTEGER PRIMARY KEY,
             version INTEGER NOT NULL DEFAULT 0,
             world TEXT NOT NULL,
             ticked_at TEXT NOT NULL,
             lock_until INTEGER NOT NULL DEFAULT 0,
             updated_at TEXT NOT NULL
           )`,
          `CREATE TABLE IF NOT EXISTS ${queueTable} (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             created_at TEXT NOT NULL,
             kind TEXT NOT NULL,
             payload TEXT NOT NULL
           )`,
          `CREATE TABLE IF NOT EXISTS ${budgetTable} (
             day TEXT PRIMARY KEY,
             llm_calls INTEGER NOT NULL DEFAULT 0
           )`,
        ],
        'write',
      );
      await seedState();
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
    return schemaReady;
  }

  async function seedState(): Promise<void> {
    if (!client) return;
    const now = new Date().toISOString();
    // INSERT OR IGNORE is safe if two instances race here.
    await client.execute({
      sql: `INSERT OR IGNORE INTO ${stateTable} (id, version, world, ticked_at, lock_until, updated_at) VALUES (1, 0, ?, ?, 0, ?)`,
      args: [JSON.stringify(buildInitial(now)), now, now],
    });
  }

  async function readState(): Promise<WorldStateRow<TWorld> | null> {
    if (!client) return null;
    await ensureSchema();
    let rs = await client.execute(
      `SELECT version, world, ticked_at FROM ${stateTable} WHERE id = 1`,
    );
    if (!rs.rows[0]) {
      // Row missing (e.g. a manual reset on a warm instance). Self-heal: re-seed and re-read.
      await seedState();
      rs = await client.execute(`SELECT version, world, ticked_at FROM ${stateTable} WHERE id = 1`);
    }
    const row = rs.rows[0];
    if (!row) return null;
    try {
      return {
        version: Number(row.version),
        world: JSON.parse(String(row.world)) as TWorld,
        tickedAt: String(row.ticked_at),
      };
    } catch {
      return null;
    }
  }

  // Atomic lease: succeeds for exactly one caller while the lock is free/expired.
  async function acquireLock(nowMs: number, ttlMs: number): Promise<boolean> {
    if (!client) return false;
    await ensureSchema();
    const rs = await client.execute({
      sql: `UPDATE ${stateTable} SET lock_until = ? WHERE id = 1 AND lock_until <= ?`,
      args: [nowMs + ttlMs, nowMs],
    });
    return rs.rowsAffected === 1;
  }

  async function writeState(
    world: TWorld,
    tickedAtIso: string,
    lockToken?: number,
  ): Promise<boolean> {
    if (!client) return false;
    await ensureSchema();
    const ownerClause = lockToken === undefined ? '' : ' AND lock_until = ? AND lock_until >= ?';
    const nowMs = Date.now();
    const args: (string | number)[] = [
      JSON.stringify(world),
      tickedAtIso,
      new Date().toISOString(),
    ];
    if (lockToken !== undefined) args.push(lockToken, nowMs);
    const rs = await client.execute({
      sql: `UPDATE ${stateTable} SET version = version + 1, world = ?, ticked_at = ?, lock_until = 0, updated_at = ? WHERE id = 1${ownerClause}`,
      args,
    });
    return rs.rowsAffected === 1;
  }

  async function renewLock(
    lockToken: number,
    nowMs: number,
    ttlMs: number,
  ): Promise<number | null> {
    if (!client) return null;
    await ensureSchema();
    const nextToken = nowMs + ttlMs;
    const rs = await client.execute({
      sql: `UPDATE ${stateTable} SET lock_until = ? WHERE id = 1 AND lock_until = ? AND lock_until >= ?`,
      args: [nextToken, lockToken, nowMs],
    });
    return rs.rowsAffected === 1 ? nextToken : null;
  }

  async function releaseLock(lockToken?: number): Promise<void> {
    if (!client) return;
    await ensureSchema();
    const ownerClause = lockToken === undefined ? '' : ' AND lock_until = ?';
    await client.execute({
      sql: `UPDATE ${stateTable} SET lock_until = 0 WHERE id = 1${ownerClause}`,
      args: lockToken === undefined ? [] : [lockToken],
    });
  }

  async function enqueueInteraction(it: TInteraction & { kind: string }): Promise<boolean> {
    if (!client) return false;
    await ensureSchema();
    // Hard cap bounds the queue even if the per-IP limiter is absent. A single
    // conditional insert avoids the count-then-insert race that let two
    // concurrent enqueues both pass the check.
    const rs = await client.execute({
      sql: `INSERT INTO ${queueTable} (created_at, kind, payload)
            SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM ${queueTable}) < ?`,
      args: [new Date().toISOString(), it.kind, JSON.stringify(it), queueHardCap],
    });
    return rs.rowsAffected === 1;
  }

  // Drained inside the tick lock, so no race: read then delete.
  async function drainQueue(limit = 6): Promise<TInteraction[]> {
    if (!client) return [];
    await ensureSchema();
    const rs = await client.execute({
      sql: `SELECT id, payload FROM ${queueTable} ORDER BY id LIMIT ?`,
      args: [limit],
    });
    if (!rs.rows.length) return [];
    const ids = rs.rows.map((r) => Number(r.id));
    const items = rs.rows
      .map((r) => {
        try {
          return JSON.parse(String(r.payload)) as TInteraction;
        } catch {
          return null;
        }
      })
      .filter((x): x is TInteraction => x !== null);
    await client.execute({
      sql: `DELETE FROM ${queueTable} WHERE id IN (${ids.map(() => '?').join(',')})`,
      args: ids,
    });
    return items;
  }

  const today = () => new Date().toISOString().slice(0, 10);

  async function llmCallsToday(): Promise<number> {
    if (!client) return 0;
    await ensureSchema();
    const rs = await client.execute({
      sql: `SELECT llm_calls FROM ${budgetTable} WHERE day = ?`,
      args: [today()],
    });
    return rs.rows[0] ? Number(rs.rows[0].llm_calls) : 0;
  }

  async function recordLlmCall(): Promise<void> {
    if (!client) return;
    await ensureSchema();
    await client.execute({
      sql: `INSERT INTO ${budgetTable} (day, llm_calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET llm_calls = llm_calls + 1`,
      args: [today()],
    });
  }

  return {
    isConfigured: () => client !== null,
    readState,
    acquireLock,
    writeState,
    renewLock,
    releaseLock,
    enqueueInteraction,
    drainQueue,
    llmCallsToday,
    recordLlmCall,
  };
}
