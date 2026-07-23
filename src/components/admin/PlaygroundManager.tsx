import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  describeParams,
  paramsSchema,
  LIMITS,
  type PlaygroundConfig,
  type PlaygroundParams,
  type PlaygroundStatus,
} from '../../lib/playground-schema';
import { DataTable } from './TraderTables';
import TradeLifecycle, { captureTone, fmtPx } from './TradeLifecycle';

// Trade Playground: create paper portfolios with your own rules, watch them
// race. Config truth is Turso (written here); results arrive through the
// trader snapshot after each VPS run — a freshly created portfolio shows
// "waiting for first run" until the next trading morning.

type OpenRow = {
  symbol?: string;
  entry?: number | null;
  current?: number | null;
  pnl_pct?: number | null;
  pnl_usd?: number | null;
  stop?: number | null;
  init_stop?: number | null;
  peak_pct?: number | null;
  opened_at?: string | null;
  days_held?: number | null;
  sector?: string | null;
};
type ClosedRow = {
  symbol?: string;
  return_pct?: number | null;
  pnl_usd?: number | null;
  exit_reason?: string | null;
  closed_at?: string | null;
  opened_at?: string | null;
  entry?: number | null;
  exit?: number | null;
  peak_pct?: number | null;
  capture_pct?: number | null;
  init_stop?: number | null;
};
type Result = {
  id?: string;
  equity?: number | null;
  pnl_pct?: number | null;
  open_n?: number | null;
  closed_n?: number | null;
  win_rate?: number | null;
  capture_avg?: number | null;
  curve?: Array<{ t?: string; equity?: number | null }>;
  positions?: OpenRow[];
  closed?: ClosedRow[];
};

const INPUT =
  'w-full rounded-lg border border-border-strong bg-white/[0.03] px-3 py-2 text-sm text-text placeholder:text-text-subtle outline-none transition-colors focus:border-text/40';
const LABEL = 'font-mono text-[10px] uppercase tracking-wider text-text-subtle';
const BTN =
  'rounded-lg border border-border-strong px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-white/[0.05] hover:text-text disabled:opacity-40';

const HELP = 'mt-1 text-[10px] leading-snug text-text-subtle';

const num = 'whitespace-nowrap font-mono tabular-nums';
const pnlTone = (n?: number | null) =>
  n == null
    ? 'text-text-muted'
    : n > 0.05
      ? 'text-emerald-300'
      : n < -0.05
        ? 'text-rose-300'
        : 'text-text-muted';
const pct = (n?: number | null) => (n == null ? '—' : (n > 0 ? '+' : '') + n + '%');

const openColumns: ColumnDef<OpenRow, unknown>[] = [
  {
    accessorKey: 'symbol',
    header: 'Name',
    meta: { className: 'whitespace-nowrap text-text font-medium' },
    cell: ({ row }) => row.original.symbol ?? '—',
  },
  {
    accessorKey: 'entry',
    header: 'Entry',
    meta: { align: 'right', className: num + ' text-text-subtle' },
    cell: ({ row }) => fmtPx(row.original.entry),
  },
  {
    accessorKey: 'current',
    header: 'Price',
    meta: { align: 'right', className: num + ' text-text-muted' },
    cell: ({ row }) => fmtPx(row.original.current),
  },
  {
    accessorKey: 'pnl_pct',
    header: 'P&L %',
    meta: { align: 'right', className: num },
    cell: ({ row }) => (
      <span className={pnlTone(row.original.pnl_pct)}>{pct(row.original.pnl_pct)}</span>
    ),
  },
  {
    accessorKey: 'peak_pct',
    header: 'Peak',
    meta: { align: 'right', className: num + ' text-text-muted' },
    cell: ({ row }) => (row.original.peak_pct == null ? '—' : '+' + row.original.peak_pct + '%'),
  },
  {
    accessorKey: 'stop',
    header: 'Stop',
    meta: { align: 'right', className: num + ' text-text-muted' },
    cell: ({ row }) => fmtPx(row.original.stop),
  },
  {
    accessorKey: 'days_held',
    header: 'Held',
    meta: { align: 'right', className: num + ' text-text-muted' },
    cell: ({ row }) => (row.original.days_held == null ? '—' : row.original.days_held + 'd'),
  },
];

const closedColumns: ColumnDef<ClosedRow, unknown>[] = [
  {
    accessorKey: 'symbol',
    header: 'Name',
    meta: { className: 'whitespace-nowrap text-text font-medium' },
    cell: ({ row }) => (
      <span>
        {(row.original.return_pct ?? 0) > 0.05
          ? '🟢'
          : (row.original.return_pct ?? 0) < -2
            ? '🔴'
            : '🟡'}{' '}
        {row.original.symbol}
      </span>
    ),
  },
  {
    accessorKey: 'return_pct',
    header: 'Return',
    meta: { align: 'right', className: num },
    cell: ({ row }) => (
      <span className={pnlTone(row.original.return_pct)}>{pct(row.original.return_pct)}</span>
    ),
  },
  {
    accessorKey: 'peak_pct',
    header: 'Peak',
    meta: { align: 'right', className: num + ' text-text-muted' },
    cell: ({ row }) => (row.original.peak_pct == null ? '—' : '+' + row.original.peak_pct + '%'),
  },
  {
    accessorKey: 'capture_pct',
    header: 'Kept',
    meta: { align: 'right', className: num },
    cell: ({ row }) => (
      <span className={captureTone(row.original.peak_pct, row.original.capture_pct)}>
        {row.original.capture_pct == null ? '—' : row.original.capture_pct + '%'}
      </span>
    ),
  },
  {
    accessorKey: 'pnl_usd',
    header: 'P&L $',
    meta: { align: 'right', className: num + ' text-text-muted' },
    cell: ({ row }) =>
      row.original.pnl_usd == null
        ? '—'
        : (row.original.pnl_usd >= 0 ? '+$' : '−$') +
          Math.abs(row.original.pnl_usd).toLocaleString(),
  },
  {
    accessorKey: 'exit_reason',
    header: 'Exit',
    meta: { className: 'whitespace-nowrap text-text-muted' },
    cell: ({ row }) => row.original.exit_reason || '—',
  },
  {
    accessorKey: 'closed_at',
    header: 'Closed',
    meta: { align: 'right', className: num + ' text-text-subtle' },
    cell: ({ row }) => row.original.closed_at || '—',
  },
];

function PortfolioTrades({ name, result }: { name: string; result?: Result }) {
  const opens = result?.positions ?? [];
  const closed = result?.closed ?? [];
  if (opens.length === 0 && closed.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-bg-elevated/40 px-4 py-6 text-sm text-text-muted">
        No trades yet for {name} — the first buys land at the next trading-morning run.
      </p>
    );
  }
  return (
    <div className="grid gap-5">
      <div>
        <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-text-subtle">
          {name} · open positions · {opens.length}
        </h3>
        {opens.length === 0 ? (
          <p className="text-sm text-text-muted">Nothing open.</p>
        ) : (
          <DataTable
            data={opens}
            columns={openColumns}
            scroll={opens.length > 10}
            detail={(o) =>
              o.symbol && o.opened_at ? (
                <TradeLifecycle
                  key={o.symbol + ':' + o.opened_at}
                  trade={{
                    symbol: o.symbol,
                    book: 'playground stock',
                    opened_at: o.opened_at,
                    entry: o.entry,
                    init_stop: o.init_stop,
                    stop: o.stop,
                    peak_pct: o.peak_pct,
                    result_pct: o.pnl_pct,
                  }}
                />
              ) : (
                <p className="px-4 py-4 text-xs text-text-muted">No lifecycle data for this row.</p>
              )
            }
          />
        )}
      </div>
      <div>
        <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-text-subtle">
          {name} · closed trades · {closed.length}
        </h3>
        {closed.length === 0 ? (
          <p className="text-sm text-text-muted">Nothing closed yet.</p>
        ) : (
          <DataTable
            data={closed}
            columns={closedColumns}
            scroll={closed.length > 10}
            detail={(c) =>
              c.symbol && c.opened_at ? (
                <TradeLifecycle
                  key={c.symbol + ':' + c.opened_at + ':' + (c.closed_at ?? '')}
                  trade={{
                    symbol: c.symbol,
                    book: 'playground stock',
                    opened_at: c.opened_at,
                    closed_at: c.closed_at,
                    entry: c.entry,
                    exit: c.exit,
                    init_stop: c.init_stop,
                    peak_pct: c.peak_pct,
                    result_pct: c.return_pct,
                  }}
                />
              ) : (
                <p className="px-4 py-4 text-xs text-text-muted">No lifecycle data for this row.</p>
              )
            }
          />
        )}
      </div>
    </div>
  );
}

const statusTone: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/25',
  paused: 'bg-amber-500/10 text-amber-300 ring-amber-500/25',
  archived: 'bg-white/[0.04] text-text-subtle ring-border-strong',
};

function Sparkline({ curve }: { curve: Result['curve'] }) {
  const pts = (curve ?? []).filter((p): p is { t: string; equity: number } => p?.equity != null);
  if (pts.length < 2) return null;
  const W = 220;
  const H = 40;
  const vals = pts.map((p) => p.equity);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const d = vals
    .map(
      (v, i) =>
        `${i === 0 ? 'M' : 'L'} ${((i / (vals.length - 1)) * W).toFixed(1)} ${(H - 3 - ((v - min) / span) * (H - 6)).toFixed(1)}`,
    )
    .join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mt-2 h-10 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label={`equity ${up ? 'up' : 'down'} since inception`}
    >
      <path
        d={d}
        fill="none"
        stroke={up ? '#7af2a0' : '#fb7185'}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function PlaygroundManager({
  configs: initialConfigs = [],
  results = [],
}: {
  configs?: PlaygroundConfig[];
  results?: Result[];
}) {
  const [configs, setConfigs] = useState(initialConfigs);
  const [showForm, setShowForm] = useState(initialConfigs.length === 0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // form state
  const [name, setName] = useState('');
  const [capital, setCapital] = useState(25_000);
  const [ruleType, setRuleType] = useState<'top_n' | 'all' | 'min_score'>('top_n');
  const [topN, setTopN] = useState(5);
  const [minScore, setMinScore] = useState(95);
  const [sizePct, setSizePct] = useState(5);
  const [maxPositions, setMaxPositions] = useState(20);
  const [sectorCap, setSectorCap] = useState<number | ''>('');
  const [stopMode, setStopMode] = useState<'engine' | 'cap' | 'fixed'>('engine');
  const [stopPct, setStopPct] = useState(8);
  const [takeProfit, setTakeProfit] = useState<number | ''>('');
  const [timeLimit, setTimeLimit] = useState(25);

  const byId = useMemo(() => new Map(results.map((r) => [r.id, r])), [results]);

  const params: PlaygroundParams = useMemo(
    () => ({
      buy_rule:
        ruleType === 'top_n'
          ? { type: 'top_n', n: topN }
          : ruleType === 'all'
            ? { type: 'all' }
            : { type: 'min_score', min_score: minScore },
      include_plain_buys: false,
      size_pct: sizePct,
      max_positions: maxPositions,
      sector_cap: sectorCap === '' ? null : sectorCap,
      stop: stopMode === 'engine' ? { mode: 'engine' } : { mode: stopMode, pct: stopPct },
      take_profit_pct: takeProfit === '' ? null : takeProfit,
      time_limit_days: timeLimit,
    }),
    [
      ruleType,
      topN,
      minScore,
      sizePct,
      maxPositions,
      sectorCap,
      stopMode,
      stopPct,
      takeProfit,
      timeLimit,
    ],
  );
  const paramsValid = paramsSchema.safeParse(params).success;
  const activeCount = configs.filter((c) => c.status === 'active').length;

  async function refresh() {
    try {
      const r = await fetch('/admin/api/playground');
      if (r.ok) setConfigs((await r.json()).portfolios ?? []);
    } catch {
      /* keep current list */
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch('/admin/api/playground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), capital, params }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNote({ text: data.error ?? `HTTP ${r.status}`, error: true });
      } else {
        setNote({ text: `✓ "${name.trim()}" created — first buys at the next market open.` });
        setName('');
        setShowForm(false);
        await refresh();
        if (data.id) setSelectedId(data.id);
      }
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'failed', error: true });
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: PlaygroundStatus) {
    setBusy(true);
    // Archiving hides the card from the grid — never leave its detail panel
    // orphaned below.
    if (status === 'archived' && selectedId === id) setSelectedId(null);
    try {
      const r = await fetch('/admin/api/playground', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setNote({ text: data.error ?? `HTTP ${r.status}`, error: true });
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const visible = configs.filter((c) => c.status !== 'archived');
  const archived = configs.filter((c) => c.status === 'archived');

  return (
    <div className="mt-6 grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-text-muted">
          {visible.length === 0
            ? 'No portfolios yet — create one and it starts buying at the next market open.'
            : `${activeCount} active of ${LIMITS.maxActive} max · buys run each trading morning after the scan.`}
        </p>
        <button type="button" className={BTN} onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Close' : '+ New portfolio'}
        </button>
      </div>

      {note && (
        <p
          role="status"
          aria-live="polite"
          className={'text-xs ' + (note.error ? 'text-rose-300' : 'text-emerald-300')}
        >
          {note.text}
        </p>
      )}

      {showForm && (
        <form
          onSubmit={create}
          className="grid gap-4 rounded-xl border border-border bg-bg-elevated/40 p-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="pg-name" className={LABEL}>
                Name
              </label>
              <input
                id="pg-name"
                className={INPUT}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Top 5 · tight stops"
                maxLength={60}
                required
              />
              <p className={HELP}>Just a label for the card and reports.</p>
            </div>
            <div>
              <label htmlFor="pg-capital" className={LABEL}>
                Starting capital ($)
              </label>
              <input
                id="pg-capital"
                className={INPUT}
                type="number"
                min={LIMITS.capital.min}
                max={LIMITS.capital.max}
                step={1000}
                value={capital}
                onChange={(e) => setCapital(Number(e.target.value))}
                required
              />
              <p className={HELP}>
                Paper money the portfolio starts with. Fixed at creation; position sizes are % of
                this.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="pg-rule" className={LABEL}>
                Buy rule
              </label>
              <select
                id="pg-rule"
                className={INPUT}
                value={ruleType}
                onChange={(e) => setRuleType(e.target.value as typeof ruleType)}
              >
                <option value="top_n">Top N strong buys</option>
                <option value="all">Every strong buy</option>
                <option value="min_score">Score threshold</option>
              </select>
              <p className={HELP}>
                Which of the day's STRONG BUYs to buy (the scan finds ~5–20/day, median 13).
              </p>
            </div>
            {ruleType === 'top_n' && (
              <div>
                <label htmlFor="pg-n" className={LABEL}>
                  N (1–{LIMITS.topN.max})
                </label>
                <input
                  id="pg-n"
                  className={INPUT}
                  type="number"
                  min={LIMITS.topN.min}
                  max={LIMITS.topN.max}
                  value={topN}
                  onChange={(e) => setTopN(Number(e.target.value))}
                />
                <p className={HELP}>
                  Highest composite score first. Held names don't refill the window.
                </p>
              </div>
            )}
            {ruleType === 'min_score' && (
              <div>
                <label htmlFor="pg-score" className={LABEL}>
                  Min score (0–100)
                </label>
                <input
                  id="pg-score"
                  className={INPUT}
                  type="number"
                  min={0}
                  max={100}
                  value={minScore}
                  onChange={(e) => setMinScore(Number(e.target.value))}
                />
                <p className={HELP}>Engine composite score. Recent strong buys score ~90–99.</p>
              </div>
            )}
            <div>
              <label htmlFor="pg-size" className={LABEL}>
                Size %/position
              </label>
              <input
                id="pg-size"
                className={INPUT}
                type="number"
                min={LIMITS.sizePct.min}
                max={LIMITS.sizePct.max}
                step={0.5}
                value={sizePct}
                onChange={(e) => setSizePct(Number(e.target.value))}
              />
              <p className={HELP}>
                Each buy = this % of starting capital. 5% on $25k ≈ $1,250/position.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <label htmlFor="pg-max" className={LABEL}>
                Max positions
              </label>
              <input
                id="pg-max"
                className={INPUT}
                type="number"
                min={LIMITS.maxPositions.min}
                max={LIMITS.maxPositions.max}
                value={maxPositions}
                onChange={(e) => setMaxPositions(Number(e.target.value))}
              />
              <p className={HELP}>Hard ceiling on simultaneous open positions.</p>
            </div>
            <div>
              <label htmlFor="pg-sector" className={LABEL}>
                Sector cap (blank = off)
              </label>
              <input
                id="pg-sector"
                className={INPUT}
                type="number"
                min={LIMITS.sectorCap.min}
                max={LIMITS.sectorCap.max}
                value={sectorCap}
                onChange={(e) => setSectorCap(e.target.value === '' ? '' : Number(e.target.value))}
              />
              <p className={HELP}>Max names per sector. Blank = unlimited concentration.</p>
            </div>
            <div>
              <label htmlFor="pg-days" className={LABEL}>
                Time limit (days)
              </label>
              <input
                id="pg-days"
                className={INPUT}
                type="number"
                min={LIMITS.timeLimitDays.min}
                max={LIMITS.timeLimitDays.max}
                value={timeLimit}
                onChange={(e) => setTimeLimit(Number(e.target.value))}
              />
              <p className={HELP}>Auto-sell anything still open after this many days.</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="pg-stopmode" className={LABEL}>
                Stop loss (sell when down)
              </label>
              <select
                id="pg-stopmode"
                className={INPUT}
                value={stopMode}
                onChange={(e) => setStopMode(e.target.value as typeof stopMode)}
              >
                <option value="engine">Engine structural stop</option>
                <option value="cap">Structural, capped at %</option>
                <option value="fixed">Fixed % below entry</option>
              </select>
              <p className={HELP}>
                Sold tick-level by the live monitor. Structural = the chart's swing low (can be
                wide); capped narrows it; fixed ignores structure entirely.
              </p>
            </div>
            {stopMode !== 'engine' && (
              <div>
                <label htmlFor="pg-stoppct" className={LABEL}>
                  Stop % ({LIMITS.stopPct.min}–{LIMITS.stopPct.max})
                </label>
                <input
                  id="pg-stoppct"
                  className={INPUT}
                  type="number"
                  min={LIMITS.stopPct.min}
                  max={LIMITS.stopPct.max}
                  step={0.5}
                  value={stopPct}
                  onChange={(e) => setStopPct(Number(e.target.value))}
                />
                <p className={HELP}>
                  {stopMode === 'cap'
                    ? 'Never risk more than this %, even when the structure is wider.'
                    : 'Always sell at exactly this % below entry.'}
                </p>
              </div>
            )}
            <div>
              <label htmlFor="pg-tp" className={LABEL}>
                Take profit % (blank = ride)
              </label>
              <input
                id="pg-tp"
                className={INPUT}
                type="number"
                min={LIMITS.takeProfitPct.min}
                max={LIMITS.takeProfitPct.max}
                step={1}
                value={takeProfit}
                onChange={(e) => setTakeProfit(e.target.value === '' ? '' : Number(e.target.value))}
              />
              <p className={HELP}>
                Sell everything at +this %. Checked at the two daily runs (10:05 &amp; 16:05 ET),
                not tick-level. Blank = let the trail ride winners.
              </p>
            </div>
          </div>

          {/* the config, in plain English — no mystery sliders */}
          <p className="rounded-lg border border-border bg-bg/60 px-3 py-2 text-xs leading-relaxed text-text-muted">
            {paramsValid ? describeParams(params) : 'Fix the highlighted values to continue.'}
          </p>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={busy || !paramsValid || !name.trim()}
              className="rounded-lg bg-text px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-white disabled:opacity-50"
            >
              Create portfolio
            </button>
            <span className="text-[11px] text-text-subtle">
              Paper only · deterministic · exits always mechanical
            </span>
          </div>
        </form>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {visible.map((c) => {
          const r = byId.get(c.id);
          const hasData = r && r.equity != null;
          const selected = selectedId === c.id;
          return (
            <div
              key={c.id}
              onClick={() => setSelectedId((cur) => (cur === c.id ? null : c.id))}
              className={
                'cursor-pointer rounded-xl border p-4 transition-colors ' +
                (selected
                  ? 'border-text/30 bg-bg-elevated/70 ring-1 ring-text/20'
                  : 'border-border bg-bg-elevated/40 hover:bg-bg-elevated/60')
              }
            >
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  aria-expanded={selected}
                  aria-label={(selected ? 'Hide' : 'Show') + ' trades for ' + c.name}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedId((cur) => (cur === c.id ? null : c.id));
                  }}
                  className="flex min-w-0 items-center gap-1.5 text-left"
                >
                  <span
                    aria-hidden="true"
                    className={
                      'text-[10px] transition-transform ' +
                      (selected ? 'rotate-90 text-text' : 'text-text-subtle')
                    }
                  >
                    ▶
                  </span>
                  <span className="truncate text-sm font-medium text-text">{c.name}</span>
                </button>
                <span
                  className={
                    'shrink-0 rounded-full px-2 py-0.5 text-[9px] uppercase ring-1 ring-inset ' +
                    (statusTone[c.status] ?? statusTone.paused)
                  }
                >
                  {c.status}
                </span>
              </div>

              {hasData ? (
                <>
                  <div className="mt-1.5 flex items-baseline gap-2">
                    <span className="text-xl font-medium tabular-nums text-text">
                      ${Math.round(r.equity!).toLocaleString()}
                    </span>
                    <span
                      className={
                        'font-mono text-xs tabular-nums ' +
                        ((r.pnl_pct ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300')
                      }
                    >
                      {(r.pnl_pct ?? 0) >= 0 ? '+' : ''}
                      {r.pnl_pct}%
                    </span>
                    <span className="ml-auto font-mono text-[10px] tabular-nums text-text-subtle">
                      {r.open_n ?? 0} open · {r.closed_n ?? 0} closed
                    </span>
                  </div>
                  <Sparkline curve={r.curve} />
                  <div className="mt-1 flex gap-3 font-mono text-[10px] tabular-nums text-text-subtle">
                    {r.win_rate != null && <span>{r.win_rate}% win</span>}
                    {r.capture_avg != null && <span>kept {r.capture_avg}% of peaks</span>}
                  </div>
                </>
              ) : (
                <p className="mt-1.5 text-xs text-text-subtle">
                  Waiting for the first run — buys happen each trading morning after the scan.
                </p>
              )}

              <p className="mt-2 text-[11px] leading-relaxed text-text-subtle">
                ${c.capital.toLocaleString()} ·{' '}
                {(() => {
                  // safeParse: a malformed stored config must degrade one line,
                  // never crash the card grid.
                  const parsed = paramsSchema.safeParse(c.params);
                  return parsed.success ? describeParams(parsed.data) : 'custom parameters';
                })()}
              </p>

              <div className="mt-3 flex gap-2">
                {c.status === 'active' ? (
                  <button
                    type="button"
                    className={BTN}
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      setStatus(c.id, 'paused');
                    }}
                  >
                    Pause buys
                  </button>
                ) : (
                  <button
                    type="button"
                    className={BTN}
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      setStatus(c.id, 'active');
                    }}
                  >
                    Resume
                  </button>
                )}
                <button
                  type="button"
                  className={BTN}
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    setStatus(c.id, 'archived');
                  }}
                >
                  Archive
                </button>
                <span className="ml-auto self-center text-[10px] text-text-subtle">
                  {selected ? 'hide trades' : 'click for trades'}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {selectedId != null &&
        (() => {
          const c = configs.find((x) => x.id === selectedId);
          return c ? <PortfolioTrades name={c.name} result={byId.get(c.id)} /> : null;
        })()}

      {archived.length > 0 && (
        <details className="text-xs text-text-subtle">
          <summary className="cursor-pointer transition-colors hover:text-text-muted">
            {archived.length} archived
          </summary>
          <div className="mt-2 grid gap-2">
            {archived.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2"
              >
                <span>
                  {c.name} · ${c.capital.toLocaleString()}
                </span>
                <button
                  type="button"
                  className={BTN}
                  disabled={busy}
                  onClick={() => setStatus(c.id, 'active')}
                >
                  Reactivate
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
