import type { Client } from '@libsql/client';
import { ensureBridgeSchema } from './schema';

// Append-only activity stream. One table feeds the live feed, the ship's log,
// and the replay scrubber. Events must be REAL: every shortcut that fabricates
// an event poisons the premise of the whole system.

export type BridgeEventInput = {
  /** Crew member id ('scout', 'envoy', ...) or 'engine' for system events. */
  actor: string;
  /** Machine-readable kind, e.g. 'tick', 'tool_call', 'mission_update'. */
  kind: string;
  /** Plain-language, layer-1 line: named agent + active verb + specific object. */
  summary: string;
  /** Optional JSON payload for layer-2/3 disclosure. */
  detail?: unknown;
  /** Deep link to the real artifact (commit, diff, deploy) when one exists. */
  link?: string;
  missionId?: number;
  /** AI Gateway generation id, linking the event to its real cost. */
  generationId?: string;
};

export type BridgeEvent = BridgeEventInput & {
  id: number;
  createdAt: string;
};

export function eventInsert(event: BridgeEventInput, nowIso: string) {
  return {
    sql: `INSERT INTO bridge_events (created_at, actor, kind, summary, detail, link, mission_id, generation_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      nowIso,
      event.actor,
      event.kind,
      event.summary,
      event.detail === undefined ? null : JSON.stringify(event.detail),
      event.link ?? null,
      event.missionId ?? null,
      event.generationId ?? null,
    ],
  };
}

export async function appendEvent(
  client: Client,
  event: BridgeEventInput,
  nowIso = new Date().toISOString(),
): Promise<number> {
  await ensureBridgeSchema(client);
  const statement = eventInsert(event, nowIso);
  const rs = await client.execute({ ...statement, sql: `${statement.sql} RETURNING id` });
  return Number(rs.rows[0]?.id);
}

export type ListEventsOptions = {
  /** Return only events with id greater than this (feed polling cursor). */
  afterId?: number;
  limit?: number;
};

export async function listEvents(
  client: Client,
  { afterId = 0, limit = 50 }: ListEventsOptions = {},
): Promise<BridgeEvent[]> {
  await ensureBridgeSchema(client);
  // A polling client (afterId > 0) needs the OLDEST unseen events first so the
  // cursor advances contiguously: paging newest-first would skip everything
  // beyond `limit` in a burst. A fresh feed (afterId 0) wants the newest window.
  const rs = await client.execute(
    afterId > 0
      ? {
          sql: `SELECT id, created_at, actor, kind, summary, detail, link, mission_id, generation_id
                FROM bridge_events WHERE id > ? ORDER BY id ASC LIMIT ?`,
          args: [afterId, limit],
        }
      : {
          sql: `SELECT * FROM (
                  SELECT id, created_at, actor, kind, summary, detail, link, mission_id, generation_id
                  FROM bridge_events ORDER BY id DESC LIMIT ?
                ) ORDER BY id ASC`,
          args: [limit],
        },
  );
  return rs.rows.map((row) => ({
    id: Number(row.id),
    createdAt: String(row.created_at),
    actor: String(row.actor),
    kind: String(row.kind),
    summary: String(row.summary),
    detail: row.detail == null ? undefined : safeParse(String(row.detail)),
    link: row.link == null ? undefined : String(row.link),
    missionId: row.mission_id == null ? undefined : Number(row.mission_id),
    generationId: row.generation_id == null ? undefined : String(row.generation_id),
  }));
}

export async function latestEventTimestamp(client: Client): Promise<string | null> {
  await ensureBridgeSchema(client);
  const rs = await client.execute('SELECT created_at FROM bridge_events ORDER BY id DESC LIMIT 1');
  return rs.rows[0]?.created_at == null ? null : String(rs.rows[0].created_at);
}

/** Exact count of events filed at or after an ISO timestamp (e.g. today). */
export async function countEventsSince(client: Client, sinceIso: string): Promise<number> {
  await ensureBridgeSchema(client);
  const rs = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM bridge_events WHERE created_at >= ?`,
    args: [sinceIso],
  });
  return Number(rs.rows[0]?.n ?? 0);
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
