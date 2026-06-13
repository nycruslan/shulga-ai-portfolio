import type { Client } from '@libsql/client';
import { ensureBridgeSchema } from './schema';

// Visitor-attributable units of work. A mission is created when Envoy
// dispatches a crew member, updated as it runs, and closed with an outcome.
// Missions that die mid-flight (function killed, deploy) are swept to
// 'failed' by the next tick — an honest "interrupted", never a stuck spinner.

export type MissionStatus = 'queued' | 'running' | 'awaiting_approval' | 'done' | 'failed';

export type Mission = {
  id: number;
  createdAt: string;
  updatedAt: string;
  status: MissionStatus;
  title: string;
  brief: string;
  assignee?: string;
  visitorId?: string;
  outcome?: string;
};

export async function createMission(
  client: Client,
  input: { title: string; brief: string; assignee?: string; visitorId?: string },
  nowIso = new Date().toISOString(),
): Promise<number> {
  await ensureBridgeSchema(client);
  const rs = await client.execute({
    sql: `INSERT INTO bridge_missions (created_at, updated_at, status, title, brief, assignee, visitor_id)
          VALUES (?, ?, 'running', ?, ?, ?, ?) RETURNING id`,
    args: [
      nowIso,
      nowIso,
      input.title,
      input.brief,
      input.assignee ?? null,
      input.visitorId ?? null,
    ],
  });
  return Number(rs.rows[0]?.id);
}

export async function setMissionStatus(
  client: Client,
  id: number,
  status: MissionStatus,
  nowIso = new Date().toISOString(),
): Promise<void> {
  await client.execute({
    sql: `UPDATE bridge_missions SET status = ?, updated_at = ? WHERE id = ?`,
    args: [status, nowIso, id],
  });
}

export async function completeMission(
  client: Client,
  id: number,
  status: 'done' | 'failed',
  outcome: string,
  nowIso = new Date().toISOString(),
): Promise<void> {
  await client.execute({
    sql: `UPDATE bridge_missions SET status = ?, outcome = ?, updated_at = ? WHERE id = ?`,
    args: [status, outcome.slice(0, 2000), nowIso, id],
  });
}

export async function listMissions(client: Client, limit = 8): Promise<Mission[]> {
  await ensureBridgeSchema(client);
  const rs = await client.execute({
    sql: `SELECT id, created_at, updated_at, status, title, brief, assignee, visitor_id, outcome
          FROM bridge_missions ORDER BY id DESC LIMIT ?`,
    args: [limit],
  });
  return rs.rows.map((row) => ({
    id: Number(row.id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    status: String(row.status) as MissionStatus,
    title: String(row.title),
    brief: String(row.brief),
    assignee: row.assignee == null ? undefined : String(row.assignee),
    visitorId: row.visitor_id == null ? undefined : String(row.visitor_id),
    outcome: row.outcome == null ? undefined : String(row.outcome),
  }));
}

export const STALE_MISSION_MS = 10 * 60_000;

/** Mark long-running missions as failed/interrupted. Returns affected ids. */
export async function failStaleMissions(
  client: Client,
  nowIso = new Date().toISOString(),
  staleMs = STALE_MISSION_MS,
): Promise<number[]> {
  await ensureBridgeSchema(client);
  const cutoff = new Date(Date.parse(nowIso) - staleMs).toISOString();
  const rs = await client.execute({
    sql: `UPDATE bridge_missions
          SET status = 'failed', outcome = 'Interrupted: the run did not finish.', updated_at = ?
          WHERE status IN ('queued','running') AND updated_at < ?
          RETURNING id`,
    args: [nowIso, cutoff],
  });
  return rs.rows.map((r) => Number(r.id));
}
