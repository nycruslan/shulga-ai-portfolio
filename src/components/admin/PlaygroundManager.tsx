import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  describeParams,
  describePlan,
  describeRatchet,
  paramsSpec,
  paramsSchema,
  DEFAULT_RATCHET_STEPS,
  LIMITS,
  type PlaygroundConfig,
  type PlaygroundParams,
  type PlaygroundStatus,
  type RatchetStep,
} from '../../lib/playground-schema';
import { DataTable, InfoTip } from './TraderTables';
import TradeLifecycle, { captureTone, fmtPx, type TradeEvent } from './TradeLifecycle';
import {
  EquityDeck,
  MiniSeriesChart,
  buildModel,
  CAT_SLOTS,
  type EquityPoint,
  type MetaFor,
} from './EquityCharts';

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
  events?: TradeEvent[] | null;
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
  events?: TradeEvent[] | null;
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
  bought_today?: number | null;
  scan_today?: { day?: string; strong_buys?: number | null; buys?: number | null };
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
// P&L polarity on the reserved gain/loss tokens, matching the trader console.
const pnlTone = (n?: number | null) =>
  n == null
    ? 'text-text-muted'
    : n > 0.05
      ? 'text-gain'
      : n < -0.05
        ? 'text-loss'
        : 'text-text-muted';
const pct = (n?: number | null) => (n == null ? '—' : (n > 0 ? '+' : '') + n + '%');

// Direction as a glyph, not an emoji: emoji render differently per platform and
// announce as their CLDR name ("large green circle"), which tells a screen
// reader user nothing. Thresholds match pnlTone so the mark and the colour can
// never disagree — the old emoji used a different cutoff and did exactly that.
const dirMark = (n?: number | null) => (n == null ? '·' : n > 0.05 ? '▲' : n < -0.05 ? '▼' : '–');
const dirLabel = (n?: number | null) =>
  n == null ? 'no data' : n > 0.05 ? 'up' : n < -0.05 ? 'down' : 'flat';

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
        <span className={pnlTone(row.original.return_pct)} aria-hidden="true">
          {dirMark(row.original.return_pct)}
        </span>{' '}
        <span className="sr-only">{dirLabel(row.original.return_pct)}, </span>
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
    meta: {
      align: 'right',
      className: num,
      helpLabel: 'What Kept measures',
      help: (
        <>
          Exit quality: the share of the peak gain the exit actually kept. Around 100 means it sold
          near the top. Zero or below means the trade round-tripped.
        </>
      ),
    },
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
    // min-w-0 throughout: every one of these is a grid item, and a single
    // ancestor left at the default min-width:auto is enough to re-break the
    // horizontal scroll on a narrow screen.
    <div className="grid min-w-0 gap-5">
      <div className="min-w-0">
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
                    events: o.events,
                  }}
                />
              ) : (
                <p className="px-4 py-4 text-xs text-text-muted">No lifecycle data for this row.</p>
              )
            }
          />
        )}
      </div>
      <div className="min-w-0">
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
                    events: c.events,
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
  active: 'bg-gain/10 text-gain ring-gain/25',
  paused: 'bg-warning/10 text-warning ring-warning/25',
  archived: 'bg-white/[0.04] text-text-subtle ring-border-strong',
};

// Portfolios have no inherent families, so identity is a fixed slot.
//
// The slot is keyed to the PORTFOLIO, never to its index among the drawn
// series: a portfolio that isn't chartable yet still holds its colour, so a
// second one becoming chartable can't repaint the first. Colour following rank
// instead of entity is the classic recolor-on-filter mistake — a reader who
// learned "Min profit is teal" must not be told otherwise tomorrow.
const portfolioMetaFor =
  (names: Map<string, string>, slots: Map<string, number>): MetaFor =>
  (key) => ({
    label: names.get(key) ?? key,
    color: CAT_SLOTS[(slots.get(key) ?? 0) % CAT_SLOTS.length],
  });

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
  const [ruleType, setRuleType] = useState<'top_n' | 'all' | 'min_score' | 'tickers'>('top_n');
  const [tickerText, setTickerText] = useState('');
  // Parse the free-text ticker box into clean symbols (comma/space/newline sep).
  const pickedSymbols = useMemo(
    () =>
      Array.from(
        new Set(
          tickerText
            .toUpperCase()
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter((s) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(s)),
        ),
      ).slice(0, 20),
    [tickerText],
  );
  const [plainBuys, setPlainBuys] = useState(false);
  const [exitMode, setExitMode] = useState<'managed' | 'bracket' | 'ratchet'>('managed');
  const [ratchetSteps, setRatchetSteps] = useState<RatchetStep[]>(
    DEFAULT_RATCHET_STEPS.map((s) => ({ ...s })),
  );
  const updateStep = (i: number, field: 'at' | 'lock', value: number) =>
    setRatchetSteps((steps) => steps.map((s, j) => (j === i ? { ...s, [field]: value } : s)));
  const addStep = () =>
    setRatchetSteps((steps) => {
      if (steps.length >= 6) return steps;
      const last = steps[steps.length - 1] ?? { at: 0, lock: 0 };
      return [...steps, { at: last.at + 1, lock: Math.max(0, last.lock + 0.5) }];
    });
  const removeStep = (i: number) =>
    setRatchetSteps((steps) => (steps.length <= 1 ? steps : steps.filter((_, j) => j !== i)));
  // Edit-as-new-version: prefill from an existing card; on submit the old
  // version is archived atomically by the API (configs are immutable).
  const [replacesId, setReplacesId] = useState<string | null>(null);
  const [topN, setTopN] = useState(5);
  const [minScore, setMinScore] = useState(95);
  const [sizeMode, setSizeMode] = useState<'fixed_pct' | 'equal_split'>('fixed_pct');
  const [sizePct, setSizePct] = useState(5);
  const [maxPositions, setMaxPositions] = useState(20);
  const [sectorCap, setSectorCap] = useState<number | ''>('');
  const [stopMode, setStopMode] = useState<'engine' | 'cap' | 'fixed'>('engine');
  const [stopPct, setStopPct] = useState(8);
  const [takeProfit, setTakeProfit] = useState<number | ''>('');
  const [timeLimit, setTimeLimit] = useState(25);
  const [regimeMaDays, setRegimeMaDays] = useState(0); // 0 = off

  const byId = useMemo(() => new Map(results.map((r) => [r.id, r])), [results]);

  // Two-step archive. Archiving pulls a portfolio out of the race, and the
  // button sits next to Pause and Edit, so a stray click is easy. The second
  // click is the confirmation — cheaper and more predictable than a modal.
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);

  const visible = configs.filter((c) => c.status !== 'archived');
  const archived = configs.filter((c) => c.status === 'archived');

  // ONE shared model across every portfolio: the same y-domain feeds the
  // comparison chart and each card's sparkline. Racing portfolios that each
  // auto-scaled to their own min/max looked identical no matter how differently
  // they actually performed — which defeats the entire point of the page.
  // Indexed to 100 so portfolios with different starting capital compare fairly.
  const curves = useMemo(() => {
    const out: Record<string, EquityPoint[]> = {};
    for (const c of visible) {
      const pts = byId.get(c.id)?.curve ?? [];
      const clean = pts.filter((p) => p?.t && p.equity != null) as EquityPoint[];
      if (clean.length >= 2) out[c.id] = clean;
    }
    return out;
  }, [visible, byId]);

  const names = useMemo(() => new Map(configs.map((c) => [c.id, c.name])), [configs]);
  // Slot per portfolio, fixed by position in the visible list.
  const slots = useMemo(() => new Map(visible.map((c, i) => [c.id, i])), [visible]);
  const metaFor = useMemo(() => portfolioMetaFor(names, slots), [names, slots]);

  // "Has a curve" has to be judged AFTER the model collapses each day to its
  // close, not on the raw feed. A portfolio created today publishes several
  // intraday snapshots that all carry the same date, so it looks like four
  // points and charts as one — which drew an empty plot instead of falling
  // through to the "not enough history" copy.
  const racingCurves = useMemo(() => {
    const probe = buildModel(curves, metaFor);
    const ok = new Set(
      probe.series.filter((s) => s.values.filter((v) => v != null).length >= 2).map((s) => s.key),
    );
    return Object.fromEntries(Object.entries(curves).filter(([k]) => ok.has(k)));
  }, [curves, metaFor]);

  // One model for everything that draws, so the deck and every card sparkline
  // share a single y-domain.
  const model = useMemo(() => buildModel(racingCurves, metaFor), [racingCurves, metaFor]);
  const seriesById = useMemo(() => new Map(model.series.map((s) => [s.key, s])), [model]);
  const racing = model.series.length;

  const params: PlaygroundParams = useMemo(
    () => ({
      buy_rule:
        ruleType === 'top_n'
          ? { type: 'top_n', n: topN }
          : ruleType === 'all'
            ? { type: 'all' }
            : ruleType === 'tickers'
              ? { type: 'tickers', symbols: pickedSymbols }
              : { type: 'min_score', min_score: minScore },
      include_plain_buys: plainBuys,
      exit_mode: exitMode,
      ratchet_steps: ratchetSteps,
      size_mode: sizeMode,
      size_pct: sizePct,
      max_positions: maxPositions,
      sector_cap: sectorCap === '' ? null : sectorCap,
      stop: stopMode === 'engine' ? { mode: 'engine' } : { mode: stopMode, pct: stopPct },
      take_profit_pct: takeProfit === '' ? null : takeProfit,
      time_limit_days: timeLimit,
      regime_ma_days: regimeMaDays,
    }),
    [
      ruleType,
      topN,
      minScore,
      pickedSymbols,
      // plainBuys + exitMode + sizeMode + ratchetSteps feed the params body;
      // omitting them left the live preview stale when a toggle changed.
      plainBuys,
      exitMode,
      ratchetSteps,
      sizeMode,
      sizePct,
      maxPositions,
      sectorCap,
      stopMode,
      stopPct,
      takeProfit,
      timeLimit,
      regimeMaDays,
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

  function prefillFrom(c: PlaygroundConfig) {
    const parsed = paramsSchema.safeParse(c.params);
    if (!parsed.success) return;
    const p = parsed.data;
    setName(c.name.replace(/ v(\d+)$/, '') + ' v2');
    setCapital(c.capital);
    setRuleType(p.buy_rule.type);
    if (p.buy_rule.type === 'top_n') setTopN(p.buy_rule.n);
    if (p.buy_rule.type === 'min_score') setMinScore(p.buy_rule.min_score);
    if (p.buy_rule.type === 'tickers') setTickerText(p.buy_rule.symbols.join(', '));
    setPlainBuys(p.include_plain_buys);
    setExitMode(p.exit_mode);
    setRatchetSteps(
      (p.ratchet_steps ?? DEFAULT_RATCHET_STEPS).map((s) => ({ at: s.at, lock: s.lock })),
    );
    setSizeMode(p.size_mode ?? 'fixed_pct');
    setSizePct(p.size_pct);
    setMaxPositions(p.max_positions);
    setSectorCap(p.sector_cap ?? '');
    setStopMode(p.stop.mode);
    if (p.stop.mode !== 'engine') setStopPct(p.stop.pct);
    setTakeProfit(p.take_profit_pct ?? '');
    setTimeLimit(p.time_limit_days);
    setRegimeMaDays(p.regime_ma_days ?? 0);
    setReplacesId(c.id);
    setShowForm(true);
    setNote({
      text: `Editing "${c.name}" as a new version — creating it archives the old one (its open positions keep their exits).`,
    });
  }

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch('/admin/api/playground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), capital, params, replaces_id: replacesId }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNote({ text: data.error ?? `HTTP ${r.status}`, error: true });
      } else {
        setNote({ text: `✓ "${name.trim()}" created — first buys at the next market open.` });
        setName('');
        setReplacesId(null);
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
          className={'text-xs ' + (note.error ? 'text-loss' : 'text-gain')}
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
                name="portfolio-name"
                className={INPUT}
                // Not a personal field — keep password managers and autofill
                // out of it, and stop the browser suggesting unrelated names.
                autoComplete="off"
                spellCheck={false}
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
                inputMode="decimal"
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
                <option value="tickers">Specific tickers (my picks)</option>
              </select>
              <p className={HELP}>
                {ruleType === 'tickers'
                  ? 'Ignores the daily scan — buys exactly the names you list, and re-buys any it isn’t holding each day. Great for running an exit style (e.g. ratchet) on a stock you choose.'
                  : "Which of the day's STRONG BUYs to buy (the scan finds ~5–20/day, median 13 — but some days have zero)."}
              </p>
              {ruleType !== 'tickers' && (
                <label className="mt-2 flex cursor-pointer items-start gap-2 text-[11px] text-text-muted">
                  <input
                    type="checkbox"
                    checked={plainBuys}
                    onChange={(e) => setPlainBuys(e.target.checked)}
                    className="mt-0.5 accent-[var(--color-accent)]"
                  />
                  <span>
                    Include plain BUYs (second tier, scores ~80–90). Keeps the portfolio active on
                    days when the scan has no STRONG BUYs at all.
                  </span>
                </label>
              )}
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
            {ruleType === 'tickers' && (
              <div className="sm:col-span-2">
                <label htmlFor="pg-tickers" className={LABEL}>
                  Tickers ({pickedSymbols.length}/20)
                </label>
                <input
                  id="pg-tickers"
                  className={INPUT}
                  type="text"
                  placeholder="AAPL, MSFT, NVDA"
                  value={tickerText}
                  onChange={(e) => setTickerText(e.target.value)}
                />
                <p className={HELP}>
                  Comma- or space-separated. {pickedSymbols.length > 0 ? 'Buying: ' : ''}
                  {pickedSymbols.join(', ') || 'enter at least one valid symbol.'} Use a fixed or
                  capped stop (there’s no engine structural stop for a picked name).
                </p>
              </div>
            )}
            <div>
              <label htmlFor="pg-sizemode" className={LABEL}>
                Position sizing
              </label>
              <select
                id="pg-sizemode"
                className={INPUT}
                value={sizeMode}
                onChange={(e) => setSizeMode(e.target.value as typeof sizeMode)}
              >
                <option value="fixed_pct">Fixed % per position</option>
                <option value="equal_split">Equal split across buys</option>
              </select>
              <p className={HELP}>
                {sizeMode === 'equal_split'
                  ? 'Divides the cash equally across every name it buys that day — always ~fully invested. More picks = smaller slices.'
                  : 'Each buy is a fixed % of capital (set below); unused cash stays idle.'}
              </p>
            </div>
            <div>
              <label htmlFor="pg-size" className={LABEL}>
                Size %/position
              </label>
              <input
                id="pg-size"
                className={INPUT}
                type="number"
                inputMode="decimal"
                min={LIMITS.sizePct.min}
                max={LIMITS.sizePct.max}
                step={0.5}
                value={sizePct}
                onChange={(e) => setSizePct(Number(e.target.value))}
                disabled={sizeMode === 'equal_split'}
              />
              <p className={HELP}>
                {sizeMode === 'equal_split'
                  ? 'Ignored in equal-split mode — the slice is capital ÷ number of picks.'
                  : 'Each buy = this % of starting capital. 5% on $25k ≈ $1,250/position.'}
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
                inputMode="decimal"
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
                inputMode="decimal"
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
                inputMode="decimal"
                min={LIMITS.timeLimitDays.min}
                max={LIMITS.timeLimitDays.max}
                value={timeLimit}
                onChange={(e) => setTimeLimit(Number(e.target.value))}
              />
              <p className={HELP}>Auto-sell anything still open after this many days.</p>
            </div>
          </div>

          <div className="rounded-md border border-white/10 bg-white/[0.02] p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={regimeMaDays > 0}
                onChange={(e) => setRegimeMaDays(e.target.checked ? 200 : 0)}
              />
              Only buy when the market is in an uptrend
            </label>
            {regimeMaDays > 0 && (
              <div className="mt-3 flex items-center gap-2">
                <span className="text-sm text-white/70">SPY above its</span>
                <input
                  aria-label="Regime moving-average days"
                  className={`${INPUT} w-24`}
                  type="number"
                  inputMode="numeric"
                  min={20}
                  max={300}
                  value={regimeMaDays}
                  onChange={(e) => setRegimeMaDays(Number(e.target.value))}
                />
                <span className="text-sm text-white/70">day average</span>
              </div>
            )}
            <p className={HELP}>
              The trend-follower&apos;s risk switch: on red-regime days this book sits in cash
              instead of buying, and held names keep their exits. 200 is the classic line; 20–300
              allowed. Off by default.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="pg-exitmode" className={LABEL}>
                Exit style
              </label>
              <select
                id="pg-exitmode"
                className={INPUT}
                value={exitMode}
                onChange={(e) => setExitMode(e.target.value as typeof exitMode)}
              >
                <option value="managed">Managed (mechanical stack)</option>
                <option value="bracket">Simple bracket (my % only)</option>
                <option value="ratchet">Ratchet (milestone step-stop)</option>
              </select>
              <p className={HELP}>
                {exitMode === 'bracket'
                  ? 'Each position sells ONLY at your profit %, its stop, or the time limit. No trailing, no ratchet, no partial sells — pure bracket.'
                  : exitMode === 'ratchet'
                    ? 'Winners ride a ladder of profit-locking steps you define below (in R = entry − stop). No fixed take-profit — the stop climbs and the position runs until it’s hit or times out.'
                    : 'Breakeven arming, peak ratchet, trailing stop and +2R partial manage each position; your profit % (if set) adds a tick-level target on top.'}
              </p>
            </div>
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
                  step={0.1}
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
                inputMode="decimal"
                min={LIMITS.takeProfitPct.min}
                max={LIMITS.takeProfitPct.max}
                step={0.1}
                value={takeProfit}
                onChange={(e) => setTakeProfit(e.target.value === '' ? '' : Number(e.target.value))}
              />
              <p className={HELP}>
                Sell each position at +this % above ITS entry — enforced tick-level by the live
                monitor. Blank = no target
                {exitMode === 'managed' ? ' (the trail rides winners)' : ''}.
              </p>
              {takeProfit !== '' && takeProfit < 3 && (
                <p className="mt-1 text-[11px] leading-snug text-warning">
                  ⚠ Targets under ~3% mostly sell daily noise: expect many tiny wins and capped
                  winners. Your experiment to run — that's what the playground is for.
                </p>
              )}
            </div>
          </div>

          {/* Ratchet ladder editor — only when exit style is ratchet. An editable
              list of milestone steps (at R of gain → lock R), the 3Commas-style
              tiered pattern. */}
          {exitMode === 'ratchet' && (
            <div className="rounded-lg border border-border bg-bg/40 p-3">
              <div className="flex items-center justify-between">
                <span className={LABEL}>Ratchet ladder (in R = entry − stop)</span>
                <button
                  type="button"
                  onClick={addStep}
                  disabled={ratchetSteps.length >= 6}
                  className="rounded-md border border-border-strong px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-white/[0.05] hover:text-text disabled:opacity-40"
                >
                  + add step
                </button>
              </div>
              <p className={HELP}>
                At each trigger (R of gain the peak clears), the stop climbs to lock that many R of
                profit. Classic: +1R → breakeven, +2R → +0.5R, +3R → +1.5R.
              </p>
              <div className="mt-2 space-y-1.5">
                {ratchetSteps.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-text-subtle">at</span>
                    <input
                      className={INPUT + ' w-16'}
                      type="number"
                      inputMode="decimal"
                      min={0.1}
                      max={20}
                      step={0.5}
                      value={s.at}
                      onChange={(e) => updateStep(i, 'at', Number(e.target.value))}
                      aria-label={`step ${i + 1} trigger in R`}
                    />
                    <span className="text-text-subtle">R → lock</span>
                    <input
                      className={INPUT + ' w-16'}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={20}
                      step={0.5}
                      value={s.lock}
                      onChange={(e) => updateStep(i, 'lock', Number(e.target.value))}
                      aria-label={`step ${i + 1} lock in R`}
                    />
                    <span className="text-text-muted">
                      R {s.lock === 0 ? '(breakeven)' : `(+${s.lock}R profit)`}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeStep(i)}
                      disabled={ratchetSteps.length <= 1}
                      className="ml-auto rounded-md px-2 py-1 text-[11px] text-text-subtle transition-colors hover:text-loss disabled:opacity-30"
                      aria-label={`remove step ${i + 1}`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-text-subtle">
                Ladder: {describeRatchet(ratchetSteps)}. Rungs auto-sort and clamp on save (a lock
                must be below its trigger).
              </p>
            </div>
          )}

          {/* the config, in plain English — no mystery sliders */}
          <p className="rounded-lg border border-border bg-bg/60 px-3 py-2 text-xs leading-relaxed text-text-muted">
            {paramsValid ? describeParams(params) : 'Fix the highlighted values to continue.'}
          </p>

          {/* what the size/capital knobs actually DO — so "score 50 but only 4 buys"
              is never a mystery: it's the position size filling the account. */}
          {paramsValid && (
            <p className="-mt-1 rounded-lg border border-dashed border-border bg-bg/40 px-3 py-2 text-[11px] leading-relaxed text-text-subtle">
              <span className="font-medium text-text-muted">In practice: </span>
              {describePlan(params, capital)}
            </p>
          )}

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

      {/* The race itself. Every portfolio on one shared, indexed axis — the
          only view that answers "which rule set is actually winning". */}
      {racing >= 2 && (
        <EquityDeck
          equityCurve={racingCurves}
          metaFor={metaFor}
          title={`Race · ${racing} portfolios · indexed to 100 at each start`}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {visible.map((c) => {
          const r = byId.get(c.id);
          const hasData = r && r.equity != null;
          const selected = selectedId === c.id;
          const series = seriesById.get(c.id);
          return (
            // A section, not a click target. The card used to be a <div
            // onClick>: unreachable by keyboard, invisible to assistive tech,
            // and it swallowed every click — you could not select the config
            // text without toggling the panel. The disclosure now lives
            // entirely in the header button, which was already here.
            <section
              key={c.id}
              aria-labelledby={`pg-card-${c.id}`}
              className={
                // @container: the spec grid below reflows on the CARD's width,
                // not the viewport's. An open card spans the grid while its
                // neighbours stay half-width, so a viewport breakpoint would
                // get one of the two wrong every time.
                '@container min-w-0 rounded-xl border p-4 transition-colors ' +
                // An open card spans the grid so its trade tables get the full
                // width; at half a column they would scroll horizontally.
                (selected
                  ? 'border-text/30 bg-bg-elevated/70 ring-1 ring-text/20 sm:col-span-2'
                  : 'border-border bg-bg-elevated/40')
              }
            >
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  id={`pg-card-${c.id}`}
                  aria-expanded={selected}
                  aria-controls={`pg-trades-${c.id}`}
                  onClick={() => setSelectedId((cur) => (cur === c.id ? null : c.id))}
                  className="flex min-w-0 items-center gap-1.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                >
                  <span
                    aria-hidden="true"
                    className={
                      'text-xs transition-transform ' +
                      (selected ? 'rotate-90 text-text' : 'text-text-subtle')
                    }
                  >
                    ▶
                  </span>
                  <span className="truncate text-sm font-medium text-text hover:underline">
                    {c.name}
                  </span>
                  <span className="sr-only">{selected ? ' — hide trades' : ' — show trades'}</span>
                </button>
                <span
                  className={
                    'shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase ring-1 ring-inset ' +
                    (statusTone[c.status] ?? statusTone.paused)
                  }
                >
                  {c.status}
                </span>
              </div>

              {hasData ? (
                <>
                  <div className="mt-1.5 flex items-baseline gap-2">
                    {/* Proportional digits on the headline figure; tabular-nums
                        makes a large standalone number read loose. */}
                    <span className="text-xl font-medium text-text">
                      ${Math.round(r.equity!).toLocaleString()}
                    </span>
                    <span className={'font-mono text-xs tabular-nums ' + pnlTone(r.pnl_pct)}>
                      {(r.pnl_pct ?? 0) >= 0 ? '+' : ''}
                      {r.pnl_pct}%
                    </span>
                    <span className="ml-auto font-mono text-[11px] tabular-nums text-text-subtle">
                      {r.open_n ?? 0} open · {r.closed_n ?? 0} closed
                    </span>
                  </div>
                  {series ? (
                    <MiniSeriesChart series={series} model={model} />
                  ) : (
                    <p className="mt-2 text-[11px] text-text-subtle">
                      Equity is charted daily — the curve starts once this portfolio has closed a
                      second day.
                    </p>
                  )}
                  <div className="mt-1 flex gap-3 font-mono text-[11px] tabular-nums text-text-subtle">
                    {r.win_rate != null && <span>{r.win_rate}% win</span>}
                    {r.capture_avg != null && (
                      <span>
                        kept {r.capture_avg}% of peaks
                        <InfoTip label="What kept-of-peaks means">
                          Average share of each winner&rsquo;s peak gain that the exit actually
                          kept. Low numbers mean the rules are giving gains back.
                        </InfoTip>
                      </span>
                    )}
                  </div>
                  {r.scan_today?.day && (
                    <p className="mt-1.5 text-[11px] text-text-muted">
                      {(r.bought_today ?? 0) > 0
                        ? `Today: bought ${r.bought_today} · scan had ${r.scan_today.strong_buys ?? 0} strong buys`
                        : (r.scan_today.strong_buys ?? 0) === 0
                          ? `Today: nothing bought — the scan produced 0 STRONG BUYs (${r.scan_today.buys ?? 0} plain BUYs; enable "include plain BUYs" to trade days like this).`
                          : `Today: nothing bought yet · scan has ${r.scan_today.strong_buys} strong buys.`}
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-1.5 text-xs text-text-subtle">
                  Waiting for the first run — buys happen each trading morning after the scan.
                </p>
              )}

              {/* The rules as a scannable spec. As one prose sentence you had
                  to read both cards end to end to spot the one knob that
                  differs — which is the only thing a race card is for. */}
              {(() => {
                // safeParse: a malformed stored config must degrade to one
                // line, never crash the card grid.
                const parsed = paramsSchema.safeParse(c.params);
                if (!parsed.success)
                  return (
                    <p className="mt-2 text-[11px] text-text-subtle">
                      Custom parameters (stored config does not match the current schema).
                    </p>
                  );
                return (
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-2.5 font-mono text-[11px] @2xl:grid-cols-4">
                    {paramsSpec(parsed.data, c.capital).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-2">
                        <dt className="truncate text-text-subtle">{k}</dt>
                        <dd className="shrink-0 tabular-nums text-text-muted">{v}</dd>
                      </div>
                    ))}
                  </dl>
                );
              })()}

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={BTN}
                  disabled={busy}
                  onClick={() => setStatus(c.id, c.status === 'active' ? 'paused' : 'active')}
                >
                  {c.status === 'active' ? 'Pause buys' : 'Resume'}
                </button>
                <button
                  type="button"
                  className={BTN}
                  disabled={busy}
                  onClick={() => prefillFrom(c)}
                >
                  Edit
                </button>
                {confirmArchive === c.id ? (
                  <span className="inline-flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs text-warning transition-colors hover:bg-warning/15"
                      disabled={busy}
                      onClick={() => {
                        setConfirmArchive(null);
                        setStatus(c.id, 'archived');
                      }}
                    >
                      Confirm archive
                    </button>
                    <button type="button" className={BTN} onClick={() => setConfirmArchive(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={BTN}
                    disabled={busy}
                    onClick={() => setConfirmArchive(c.id)}
                  >
                    Archive
                  </button>
                )}
              </div>

              {/* The trades panel lives INSIDE its own card. It used to render
                  after the entire grid, so opening the first card pushed its
                  table below every other card. */}
              <div id={`pg-trades-${c.id}`} hidden={!selected} className="mt-4 min-w-0">
                {selected && <PortfolioTrades name={c.name} result={r} />}
              </div>
            </section>
          );
        })}
      </div>

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
