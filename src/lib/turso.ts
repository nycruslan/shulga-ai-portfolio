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
    // Fill every required field: an older or partial (but valid-JSON) row must
    // not make the SSR'd dashboard throw on a missing funnel/pipeline/followups.
    const p = JSON.parse(String(row.data)) as Partial<Snapshot>;
    return {
      generated_at: p.generated_at ?? '',
      pipeline: p.pipeline ?? {},
      funnel: {
        applied_total: p.funnel?.applied_total ?? 0,
        responded: p.funnel?.responded ?? 0,
        response_rate: p.funnel?.response_rate ?? 0,
        offers: p.funnel?.offers ?? 0,
      },
      today: p.today ?? [],
      matches: p.matches ?? [],
      matches_total: p.matches_total ?? 0,
      applications: p.applications ?? [],
      followups: p.followups ?? [],
    };
  } catch (err) {
    console.error('[turso] readSnapshot failed:', err);
    return null;
  }
}

// ── AI trader dashboard ───────────────────────────────────────────────────────
// publish_trader.py (on the trading Mac) writes one JSON row (id=1) to
// trader_snapshot. Every field is optional on purpose: the publisher versions
// the payload and degrades section-by-section, so the dashboard must never
// assume a field exists. Add/remove data on the publisher side without touching
// this type and the page still renders.
export type TraderBook = {
  name?: string;
  mode?: string;
  equity?: number;
  start?: number;
  cash?: number | null;
  deployed_pct?: number | null;
  pnl_pct?: number | null;
  alpha_pct?: number | null;
  win_rate?: number | null;
  open_n?: number | null;
  closed_n?: number | null;
  reward_risk?: number | null;
  max_dd?: number | null;
  heat_pct?: number | null;
  heat_cap?: number | null;
  stop_exits?: number | null;
  time_exits?: number | null;
};
export type TraderPosition = {
  book?: string;
  symbol?: string;
  entry?: number | null;
  current?: number | null;
  pnl_pct?: number | null;
  pnl_usd?: number | null;
  days_held?: number | null;
  days_left?: number | null;
  stop_dist_pct?: number | null;
  pct_of_book?: number | null;
  conviction?: string | null;
  source?: string | null;
  earnings_days?: number | null;
  gain_r?: number | null;
  pyramid_eligible?: boolean | null;
  thesis?: string | null;
};
export type TraderCarry = {
  flag?: string; // calm | elevated | unwinding | unknown
  score?: number | null;
  levels?: Record<string, number | null>;
  moves_5d_pct?: Record<string, number | null>;
};
export type TraderMacroEvent = {
  date?: string;
  event?: string;
  country?: string;
  impact?: string; // HIGH | MEDIUM
  days?: number | null;
  forecast?: string | null;
  previous?: string | null;
};
export type TraderClosed = {
  book?: string;
  symbol?: string;
  return_pct?: number | null;
  pnl_usd?: number | null;
  exit_reason?: string | null;
  source?: string | null;
  closed_at?: string | null;
};
export type EquityPoint = {
  t?: string;
  equity?: number | null;
  ret_pct?: number | null;
  bench_pct?: number | null;
};
export type TraderSnapshot = {
  schema_version?: number;
  generated_at?: string;
  degraded?: string[];
  books?: TraderBook[];
  positions?: TraderPosition[];
  closed?: TraderClosed[];
  equity_curve?: Record<string, EquityPoint[]>;
  learning?: Record<string, unknown>;
  reflections?: Array<{
    symbol?: string;
    verdict?: string;
    lesson?: string;
    return_pct?: number | null;
    created_at?: string;
  }>;
  regime?: Record<string, unknown>;
  carry?: TraderCarry;
  macro_events?: TraderMacroEvent[];
  monitor?: Record<string, unknown>;
};

export async function readTraderSnapshot(): Promise<TraderSnapshot | null> {
  if (!client) return null;
  try {
    const rs = await client.execute('SELECT data FROM trader_snapshot WHERE id = 1');
    const row = rs.rows[0];
    if (!row || row.data == null) return null;
    return JSON.parse(String(row.data)) as TraderSnapshot;
  } catch (err) {
    console.error('[turso] readTraderSnapshot failed:', err);
    return null;
  }
}
