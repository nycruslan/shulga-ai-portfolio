import { createClient } from '@libsql/client';
import {
  LIMITS,
  statusSchema,
  type CreatePortfolioInput,
  type PlaygroundConfig,
  type PlaygroundStatus,
} from './playground-schema';
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
// schema_version 3: books carry a `kind` and `is_real` flag, and the live rails
// (Robinhood/Alpaca) publish an alternate shape — deployed/realized_usd instead
// of the paper sleeve's deployed_pct/cash/heat/max_dd. Every field stays optional
// so either shape (or a partial one) renders without a guard blowing up.
export type BookKind = 'paper' | 'control' | 'real' | 'broker-paper';
export type TraderBook = {
  name?: string;
  mode?: string;
  kind?: BookKind;
  is_real?: boolean;
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
  // Exit quality: avg % of peak gain kept on closed trades that got ≥+5% ahead.
  capture_avg?: number | null;
  // Live-rail (kind "real" | "broker-paper") alternate fields:
  deployed?: number | null; // dollars at work (cost), not a percent
  realized_usd?: number | null;
  // Real broker/account truth, marked to live prices:
  account_value?: number | null; // true account total (holdings + idle cash)
  account_cash?: number | null;
  account_pnl_pct?: number | null; // whole-account return vs start
  account_source?: 'broker_api' | 'session' | null; // where the true value came from
  current_value?: number | null; // marked value of open holdings
  unrealized_usd?: number | null;
  deployed_pnl_pct?: number | null; // return on capital put to work
  pnl_basis?: 'account' | 'deployed' | null; // what pnl_pct measures
  marked?: boolean; // every holding got a live mark (else some fell back to cost)
};
export type TradeEvent = {
  kind?: 'add' | 'partial';
  ts?: string; // YYYY-MM-DD
  price?: number | null;
  qty?: number | null;
  note?: string | null;
};
export type TraderPosition = {
  book?: string;
  symbol?: string;
  is_real?: boolean;
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
  // Lifecycle fields (per-trade chart + peak audit):
  stop?: number | null; // current stop price
  init_stop?: number | null; // stop at entry (defines 1R)
  peak_pct?: number | null; // best unrealized gain so far
  opened_at?: string | null; // YYYY-MM-DD
  events?: TradeEvent[] | null; // scale-in adds + partial sells (chart markers)
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
  is_real?: boolean;
  return_pct?: number | null;
  pnl_usd?: number | null;
  exit_reason?: string | null;
  source?: string | null;
  closed_at?: string | null;
  // Lifecycle fields (per-trade chart + capture audit):
  opened_at?: string | null;
  entry?: number | null;
  exit?: number | null;
  init_stop?: number | null; // stop at entry (defines 1R)
  peak_pct?: number | null; // best unrealized gain the trade reached
  capture_pct?: number | null; // realized/peak ×100, only when peak ≥ +5%
  events?: TradeEvent[] | null; // scale-in adds + partial sells (chart markers)
};
// The headline experiment: the AI's $50k stock book vs a deterministic no-AI
// book that buys the same universe on the same rules. Positive edge = AI adds
// value over the code. verdict is one of "AI ahead" | "code ahead" | "dead heat".
export type DecisionTest = {
  ai_ret_pct?: number | null;
  systematic_ret_pct?: number | null;
  edge_pts?: number | null;
  verdict?: string;
};
export type EquityPoint = {
  t?: string;
  equity?: number | null;
  ret_pct?: number | null;
  bench_pct?: number | null;
};
// Playground: results published by the VPS for each UI-configured portfolio.
// Config truth lives in the playground_portfolios Turso table (this app writes
// it); THESE rows are the trading side's ledger view, keyed by the same id.
export type PlaygroundResult = {
  id?: string;
  name?: string;
  status?: string;
  params?: Record<string, unknown>;
  capital?: number | null;
  cash?: number | null;
  equity?: number | null;
  pnl_pct?: number | null;
  open_n?: number | null;
  closed_n?: number | null;
  win_rate?: number | null;
  capture_avg?: number | null;
  created_at?: string;
  bought_today?: number | null;
  scan_today?: { day?: string; strong_buys?: number | null; buys?: number | null };
  positions?: TraderPosition[];
  closed?: TraderClosed[];
  curve?: EquityPoint[];
};
// Today's candidate shelf, per name. The list the playgrounds shop from — and
// it grows through the day as later scans add intraday movers, which is why a
// portfolio that buys at 10:05 can miss names that show up here at 11:00/14:00.
export type ScanShelfItem = {
  symbol?: string;
  action?: string; // 'STRONG BUY' | 'BUY'
  score?: number | null;
  price?: number | null; // scan reference price
  mark?: number | null; // live
  since_scan_pct?: number | null;
  stop?: number | null;
  stop_pct?: number | null;
  sector?: string | null;
};
export type ScanShelf = {
  day?: string;
  strong_buys?: number | null;
  buys?: number | null;
  items?: ScanShelfItem[];
};
export type TraderSnapshot = {
  schema_version?: number;
  generated_at?: string;
  degraded?: string[];
  books?: TraderBook[];
  positions?: TraderPosition[];
  closed?: TraderClosed[];
  playground?: PlaygroundResult[];
  scan_shelf?: ScanShelf;
  equity_curve?: Record<string, EquityPoint[]>;
  decision_test?: DecisionTest;
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

// The dashboard must tell three failure modes apart: a genuinely-empty table
// ("publisher hasn't run yet") reads very differently from a DB/parse error
// ("something is broken") — and both differ from the app running without creds.
// A discriminated result keeps that distinction instead of collapsing to null.
export type TraderSnapshotResult =
  | { status: 'ok'; snap: TraderSnapshot }
  | { status: 'empty' }
  | { status: 'error' }
  | { status: 'unconfigured' };

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// The JSON blob is untrusted (a separate process writes it). Coerce the shapes
// the page iterates over so a malformed/partial payload degrades a section
// rather than throwing during SSR. Per-field guards in the page still apply.
function normalizeTraderSnapshot(raw: unknown): TraderSnapshot {
  const p = asRecord(raw) as Partial<TraderSnapshot>;
  return {
    ...p,
    books: asArray<TraderBook>(p.books),
    positions: asArray<TraderPosition>(p.positions),
    closed: asArray<TraderClosed>(p.closed),
    equity_curve: p.equity_curve && typeof p.equity_curve === 'object' ? p.equity_curve : {},
    reflections: asArray(p.reflections),
    macro_events: asArray<TraderMacroEvent>(p.macro_events),
    degraded: asArray<string>(p.degraded),
    playground: asArray<PlaygroundResult>(p.playground),
  };
}

export async function readTraderSnapshot(): Promise<TraderSnapshotResult> {
  if (!client) return { status: 'unconfigured' };
  try {
    const rs = await client.execute('SELECT data FROM trader_snapshot WHERE id = 1');
    const row = rs.rows[0];
    if (!row || row.data == null) return { status: 'empty' };
    return { status: 'ok', snap: normalizeTraderSnapshot(JSON.parse(String(row.data))) };
  } catch (err) {
    console.error('[turso] readTraderSnapshot failed:', err);
    return { status: 'error' };
  }
}

// ── Trade Playground configs (this app is the WRITER; the VPS syncs them) ────

async function ensurePlaygroundTable(): Promise<void> {
  await client!.execute(
    'CREATE TABLE IF NOT EXISTS playground_portfolios (' +
      'id TEXT PRIMARY KEY, name TEXT NOT NULL, params_json TEXT NOT NULL, ' +
      "status TEXT NOT NULL DEFAULT 'active', capital REAL NOT NULL, " +
      'created_at TEXT, updated_at TEXT)',
  );
}

export async function listPlaygroundConfigs(): Promise<PlaygroundConfig[]> {
  if (!client) return [];
  try {
    await ensurePlaygroundTable();
    const rs = await client.execute(
      'SELECT id, name, params_json, status, capital, created_at, updated_at ' +
        'FROM playground_portfolios ORDER BY created_at',
    );
    return rs.rows.flatMap((r) => {
      try {
        return [
          {
            id: String(r.id),
            name: String(r.name),
            params: JSON.parse(String(r.params_json)),
            status: statusSchema.catch('paused').parse(String(r.status)),
            capital: Number(r.capital),
            created_at: r.created_at == null ? undefined : String(r.created_at),
            updated_at: r.updated_at == null ? undefined : String(r.updated_at),
          } satisfies PlaygroundConfig,
        ];
      } catch {
        return [];
      }
    });
  } catch (err) {
    console.error('[turso] listPlaygroundConfigs failed:', err);
    return [];
  }
}

type PlaygroundWriteResult =
  | { ok: true; id: string }
  | { ok: false; error: string; status: 404 | 409 | 500 };

export async function savePlaygroundConfig(
  input: CreatePortfolioInput,
  replacesId: string | null = null,
): Promise<PlaygroundWriteResult> {
  if (!client) return { ok: false, error: 'Turso not configured', status: 500 };
  let tx: Awaited<ReturnType<NonNullable<typeof client>['transaction']>> | null = null;
  try {
    await ensurePlaygroundTable();
    tx = await client.transaction('write');
    const rows = await tx.execute('SELECT id, name, status FROM playground_portfolios');
    const existing = rows.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      status: String(row.status),
    }));
    if (replacesId && !existing.some((item) => item.id === replacesId)) {
      return { ok: false, error: 'the portfolio being edited no longer exists', status: 404 };
    }
    const others = existing.filter((item) => item.id !== replacesId);
    if (others.filter((item) => item.status === 'active').length >= LIMITS.maxActive) {
      return {
        ok: false,
        error: `max ${LIMITS.maxActive} active portfolios; archive one first`,
        status: 409,
      };
    }
    if (
      others.some(
        (item) =>
          item.status !== 'archived' && item.name.toLowerCase() === input.name.toLowerCase(),
      )
    ) {
      return { ok: false, error: 'an active or paused portfolio has that name', status: 409 };
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    if (replacesId) {
      const archived = await tx.execute({
        sql: "UPDATE playground_portfolios SET status = 'archived', updated_at = ? WHERE id = ?",
        args: [now, replacesId],
      });
      if (archived.rowsAffected !== 1) throw new Error('Replacement disappeared during write.');
    }
    await tx.execute({
      sql:
        'INSERT INTO playground_portfolios (id, name, params_json, status, capital, created_at, updated_at) ' +
        "VALUES (?, ?, ?, 'active', ?, ?, ?)",
      args: [id, input.name, JSON.stringify(input.params), input.capital, now, now],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    console.error('[turso] savePlaygroundConfig failed:', err);
    return { ok: false, error: 'write failed', status: 500 };
  } finally {
    tx?.close();
  }
}

export async function setPlaygroundStatus(
  id: string,
  status: PlaygroundStatus,
): Promise<{ ok: true } | { ok: false; error: string; status: 404 | 409 | 500 }> {
  if (!client || !id) return { ok: false, error: 'not configured', status: 500 };
  let tx: Awaited<ReturnType<NonNullable<typeof client>['transaction']>> | null = null;
  try {
    await ensurePlaygroundTable();
    tx = await client.transaction('write');
    const target = await tx.execute({
      sql: 'SELECT id, name FROM playground_portfolios WHERE id = ?',
      args: [id],
    });
    if (!target.rows[0]) {
      return { ok: false, error: 'not found', status: 404 };
    }
    if (status !== 'archived') {
      const conflicts = await tx.execute({
        sql: `SELECT
                SUM(CASE WHEN status = 'active' AND id != ? THEN 1 ELSE 0 END) AS active_count,
                SUM(CASE WHEN status != 'archived' AND id != ? AND lower(name) = lower(?) THEN 1 ELSE 0 END) AS name_count
              FROM playground_portfolios`,
        args: [id, id, String(target.rows[0].name)],
      });
      if (status === 'active' && Number(conflicts.rows[0]?.active_count ?? 0) >= LIMITS.maxActive) {
        return {
          ok: false,
          error: `max ${LIMITS.maxActive} active portfolios; pause one first`,
          status: 409,
        };
      }
      if (Number(conflicts.rows[0]?.name_count ?? 0) > 0) {
        return { ok: false, error: 'a current portfolio has that name', status: 409 };
      }
    }
    const rs = await tx.execute({
      sql: 'UPDATE playground_portfolios SET status = ?, updated_at = ? WHERE id = ?',
      args: [status, new Date().toISOString(), id],
    });
    if (rs.rowsAffected !== 1) throw new Error('Status update did not affect one row.');
    await tx.commit();
    return { ok: true };
  } catch (err) {
    console.error('[turso] setPlaygroundStatus failed:', err);
    return { ok: false, error: 'write failed', status: 500 };
  } finally {
    tx?.close();
  }
}
