import type { Client } from '@libsql/client';
import { ensureBridgeSchema } from './schema';

// Copy-change proposals. Lifecycle: pending -> shipped (approved, committed)
// | rejected (by Ruslan; the rejection stays public, corrections are content)
// | failed (apply error). One pending proposal per key at a time.

export type ProposalStatus = 'pending' | 'shipped' | 'rejected' | 'failed';

export type Proposal = {
  id: number;
  createdAt: string;
  updatedAt: string;
  status: ProposalStatus;
  key: string;
  oldText: string;
  newText: string;
  finding: string;
  attempts: number;
  missionId?: number;
  commitUrl?: string;
  decidedBy?: string;
};

export async function createProposal(
  client: Client,
  input: {
    key: string;
    oldText: string;
    newText: string;
    finding: string;
    attempts: number;
    missionId?: number;
  },
  nowIso = new Date().toISOString(),
): Promise<number> {
  await ensureBridgeSchema(client);
  const rs = await client.execute({
    sql: `INSERT INTO bridge_proposals (created_at, updated_at, status, key, old_text, new_text, finding, attempts, mission_id)
          VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [
      nowIso,
      nowIso,
      input.key,
      input.oldText,
      input.newText,
      input.finding,
      input.attempts,
      input.missionId ?? null,
    ],
  });
  return Number(rs.rows[0]?.id);
}

function rowToProposal(row: Record<string, unknown>): Proposal {
  return {
    id: Number(row.id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    status: String(row.status) as ProposalStatus,
    key: String(row.key),
    oldText: String(row.old_text),
    newText: String(row.new_text),
    finding: String(row.finding),
    attempts: Number(row.attempts),
    missionId: row.mission_id == null ? undefined : Number(row.mission_id),
    commitUrl: row.commit_url == null ? undefined : String(row.commit_url),
    decidedBy: row.decided_by == null ? undefined : String(row.decided_by),
  };
}

export async function getProposal(client: Client, id: number): Promise<Proposal | null> {
  await ensureBridgeSchema(client);
  const rs = await client.execute({
    sql: `SELECT * FROM bridge_proposals WHERE id = ?`,
    args: [id],
  });
  return rs.rows[0] ? rowToProposal(rs.rows[0] as Record<string, unknown>) : null;
}

export async function listProposals(
  client: Client,
  status?: ProposalStatus,
  limit = 20,
): Promise<Proposal[]> {
  await ensureBridgeSchema(client);
  const rs = await client.execute({
    sql: status
      ? `SELECT * FROM bridge_proposals WHERE status = ? ORDER BY id DESC LIMIT ?`
      : `SELECT * FROM bridge_proposals ORDER BY id DESC LIMIT ?`,
    args: status ? [status, limit] : [limit],
  });
  return rs.rows.map((r) => rowToProposal(r as Record<string, unknown>));
}

/** True when a key already has a pending proposal, or a decision newer than coolOffMs. */
export async function keyIsBlocked(
  client: Client,
  key: string,
  nowIso = new Date().toISOString(),
  coolOffMs = 7 * 24 * 3600_000,
): Promise<boolean> {
  await ensureBridgeSchema(client);
  const cutoff = new Date(Date.parse(nowIso) - coolOffMs).toISOString();
  const rs = await client.execute({
    sql: `SELECT 1 FROM bridge_proposals
          WHERE key = ? AND (status = 'pending' OR updated_at >= ?) LIMIT 1`,
    args: [key, cutoff],
  });
  return rs.rows.length > 0;
}

export async function decideProposal(
  client: Client,
  id: number,
  decision: { status: 'shipped' | 'rejected' | 'failed'; decidedBy: string; commitUrl?: string },
  nowIso = new Date().toISOString(),
): Promise<void> {
  await client.execute({
    sql: `UPDATE bridge_proposals SET status = ?, decided_by = ?, commit_url = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
    args: [decision.status, decision.decidedBy, decision.commitUrl ?? null, nowIso, id],
  });
}
