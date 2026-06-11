import { createClient } from '@libsql/client';
import { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN } from 'astro:env/server';

export type Snapshot = {
  generated_at: string;
  pipeline: Record<string, number>;
  funnel: {
    applied_total: number;
    responded: number;
    response_rate: number;
    offers: number;
  };
  today: Array<{
    id: string;
    company: string;
    title: string;
    score: number;
    comp: string;
    url: string;
    location: string;
    contacts: number;
  }>;
  matches: Array<{
    id: string;
    company: string;
    title: string;
    score: number;
    comp: string;
    url: string;
    location: string;
    contacts: number;
  }>;
  matches_total: number;
  applications: Array<{
    id: string;
    company: string;
    title: string;
    status: string;
    applied_at: string | null;
    url: string;
  }>;
  followups: Array<{ company: string; title: string; applied_days_ago: number }>;
};

const client =
  TURSO_DATABASE_URL && TURSO_AUTH_TOKEN
    ? createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN })
    : null;

export type EvalCategory = {
  key: string;
  label: string;
  score: number; // 0-10 average
  passed: number;
  total: number;
};

export type EvalCase = {
  id: string;
  category: string;
  prompt: string;
  score: number;
  passed: boolean;
  note: string;
};

export type EvalRun = {
  generated_at: string;
  model: string;
  judge_model: string;
  overall: number; // 0-10
  passed: number;
  total: number;
  categories: EvalCategory[];
  cases: EvalCase[];
};

// scripts/run-evals.mjs appends one JSON row per nightly run.
export async function readEvalRuns(limit = 30): Promise<EvalRun[]> {
  if (!client) return [];
  try {
    const rs = await client.execute({
      sql: 'SELECT data FROM eval_runs ORDER BY id DESC LIMIT ?',
      args: [limit],
    });
    return rs.rows
      .map((row) => {
        try {
          return JSON.parse(String(row.data)) as EvalRun;
        } catch {
          return null;
        }
      })
      .filter((r): r is EvalRun => r !== null);
  } catch (err) {
    console.error('[turso] readEvalRuns failed:', err);
    return [];
  }
}

// The jobhunt tool writes one JSON row (id=1) to jobhunt_snapshot. We just read it.
export async function readSnapshot(): Promise<Snapshot | null> {
  if (!client) return null;
  try {
    const rs = await client.execute('SELECT data FROM jobhunt_snapshot WHERE id = 1');
    const row = rs.rows[0];
    if (!row || row.data == null) return null;
    return JSON.parse(String(row.data)) as Snapshot;
  } catch (err) {
    console.error('[turso] readSnapshot failed:', err);
    return null;
  }
}
