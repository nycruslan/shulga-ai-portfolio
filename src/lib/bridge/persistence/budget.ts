import type { Client } from '@libsql/client';
import { ensureBridgeSchema } from './schema';

// Per-day, per-agent spend accounting. Hard caps are enforced HERE, in our own
// rows; platform caps (gateway budgets) are monitoring, not enforcement.

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

export async function recordSpend(
  client: Client,
  spend: SpendRecord,
  nowIso = new Date().toISOString(),
): Promise<void> {
  await ensureBridgeSchema(client);
  await client.execute({
    sql: `INSERT INTO bridge_budget (day, agent, llm_calls, input_tokens, output_tokens, cost_usd)
          VALUES (?, ?, 1, ?, ?, ?)
          ON CONFLICT(day, agent) DO UPDATE SET
            llm_calls = llm_calls + 1,
            input_tokens = input_tokens + excluded.input_tokens,
            output_tokens = output_tokens + excluded.output_tokens,
            cost_usd = cost_usd + excluded.cost_usd`,
    args: [
      dayOf(nowIso),
      spend.agent,
      spend.inputTokens ?? 0,
      spend.outputTokens ?? 0,
      spend.costUsd ?? 0,
    ],
  });
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
