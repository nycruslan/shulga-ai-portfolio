import type { Client } from '@libsql/client';
import { ensureBridgeSchema } from './schema';

// Per-day, per-agent spend accounting. A call is reserved atomically before it
// starts, so concurrent serverless requests cannot race past the hard limits.
// Platform caps remain a second line of defense, not our primary enforcement.

export const DAILY_BRIDGE_CALL_CAP = 350;

export type SpendRecord = {
  agent: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

export type DaySpend = {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

const dayOf = (nowIso: string) => nowIso.slice(0, 10);

export async function reserveCall(
  client: Client,
  agent: string,
  agentCap: number,
  nowIso = new Date().toISOString(),
  totalCap = DAILY_BRIDGE_CALL_CAP,
): Promise<boolean> {
  if (!Number.isSafeInteger(agentCap) || agentCap < 1) return false;
  if (!Number.isSafeInteger(totalCap) || totalCap < 1) return false;

  await ensureBridgeSchema(client);
  const day = dayOf(nowIso);
  const rs = await client.execute({
    sql: `INSERT INTO bridge_budget (day, agent, llm_calls, input_tokens, output_tokens, cost_usd)
          SELECT ?, ?, 1, 0, 0, 0
          WHERE (SELECT COALESCE(SUM(llm_calls), 0) FROM bridge_budget WHERE day = ?) < ?
          ON CONFLICT(day, agent) DO UPDATE SET llm_calls = bridge_budget.llm_calls + 1
          WHERE bridge_budget.llm_calls < ?
            AND (SELECT COALESCE(SUM(llm_calls), 0) FROM bridge_budget WHERE day = excluded.day) < ?
          RETURNING llm_calls`,
    args: [day, agent, day, totalCap, agentCap, totalCap],
  });
  return rs.rows.length === 1;
}

/** Add actual usage to a call that was already reserved. */
export async function finalizeSpend(
  client: Client,
  spend: SpendRecord,
  nowIso = new Date().toISOString(),
): Promise<void> {
  await ensureBridgeSchema(client);
  const rs = await client.execute({
    sql: `UPDATE bridge_budget SET
            input_tokens = input_tokens + ?,
            output_tokens = output_tokens + ?,
            cost_usd = cost_usd + ?
          WHERE day = ? AND agent = ?`,
    args: [
      spend.inputTokens ?? 0,
      spend.outputTokens ?? 0,
      spend.costUsd ?? 0,
      dayOf(nowIso),
      spend.agent,
    ],
  });
  if (rs.rowsAffected !== 1) {
    throw new Error(`No reserved model call found for ${spend.agent}.`);
  }
}

/** Convenience for trusted, uncapped maintenance callers and persistence tests. */
export async function recordSpend(
  client: Client,
  spend: SpendRecord,
  nowIso = new Date().toISOString(),
): Promise<void> {
  const reserved = await reserveCall(
    client,
    spend.agent,
    Number.MAX_SAFE_INTEGER,
    nowIso,
    Number.MAX_SAFE_INTEGER,
  );
  if (!reserved) throw new Error('Could not reserve spend row.');
  await finalizeSpend(client, spend, nowIso);
}

/** Spend for one day, totalled across the crew or for a single agent. */
export async function daySpend(
  client: Client,
  nowIso = new Date().toISOString(),
  agent?: string,
): Promise<DaySpend> {
  await ensureBridgeSchema(client);
  const rs = await client.execute({
    sql: `SELECT COALESCE(SUM(llm_calls),0) AS calls, COALESCE(SUM(input_tokens),0) AS inp,
                 COALESCE(SUM(output_tokens),0) AS outp, COALESCE(SUM(cost_usd),0) AS cost
          FROM bridge_budget WHERE day = ?${agent ? ' AND agent = ?' : ''}`,
    args: agent ? [dayOf(nowIso), agent] : [dayOf(nowIso)],
  });
  const row = rs.rows[0];
  return {
    llmCalls: Number(row?.calls ?? 0),
    inputTokens: Number(row?.inp ?? 0),
    outputTokens: Number(row?.outp ?? 0),
    costUsd: Number(row?.cost ?? 0),
  };
}

/** True when the named agent (or the whole crew) is at or over its daily call cap. */
export async function isOverBudget(
  client: Client,
  cap: number,
  nowIso = new Date().toISOString(),
  agent?: string,
): Promise<boolean> {
  const spend = await daySpend(client, nowIso, agent);
  return spend.llmCalls >= cap;
}
