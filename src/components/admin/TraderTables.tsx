import { Fragment, useId, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import TradeLifecycle, { captureTone, type TradeFacts } from './TradeLifecycle';

// Row shapes mirror the trader snapshot in lib/turso.ts. Kept local so this
// client island never imports the server-only Turso module. Every field is
// optional — the publisher can change without breaking the table.
type Position = {
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
  stop?: number | null;
  init_stop?: number | null;
  peak_pct?: number | null;
  opened_at?: string | null;
};
type Closed = {
  book?: string;
  symbol?: string;
  is_real?: boolean;
  return_pct?: number | null;
  pnl_usd?: number | null;
  exit_reason?: string | null;
  source?: string | null;
  closed_at?: string | null;
  opened_at?: string | null;
  entry?: number | null;
  exit?: number | null;
  init_stop?: number | null;
  peak_pct?: number | null;
  capture_pct?: number | null;
};
type EquityPoint = {
  t?: string;
  equity?: number | null;
  ret_pct?: number | null;
  bench_pct?: number | null;
};

type Align = 'left' | 'right';
type Meta = { align?: Align; className?: string };

const pnlTone = (n?: number | null) =>
  n == null
    ? 'text-text-muted'
    : n > 0.05
      ? 'text-emerald-300'
      : n < -0.05
        ? 'text-rose-300'
        : 'text-text-muted';

const verdict = (n?: number | null) => (n == null ? '⚪' : n > 0.05 ? '🟢' : n < -2 ? '🔴' : '🟡');

// Categorical sleeve colors. Real money gets an amber ring + bold — a channel
// that survives colorblindness and any background (paired with the "REAL $" text
// tag on the row, never color alone).
const bookBadge = (b?: string, isReal?: boolean) => {
  const name = (b ?? '').toLowerCase();
  if (isReal || name.includes('robinhood'))
    return 'bg-amber-400/15 text-amber-200 ring-amber-400/60 font-semibold';
  if (name.includes('alpaca')) return 'bg-cyan-500/10 text-cyan-300 ring-cyan-500/20';
  if (name.includes('systematic')) return 'bg-violet-500/10 text-violet-300 ring-violet-500/20';
  if (name.includes('aggressive')) return 'bg-fuchsia-500/10 text-fuchsia-300 ring-fuchsia-500/20';
  if (name.includes('mild')) return 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20';
  return 'bg-sky-500/10 text-sky-300 ring-sky-500/20';
};

const fmtUsd = (n?: number | null) =>
  n == null ? '—' : (n >= 0 ? '+$' : '−$') + Math.abs(n).toLocaleString();

const fmtPrice = (n?: number | null) =>
  n == null
    ? '—'
    : '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Unmissable per-row real-money tag: text + amber + ring, sits next to the ticker
// so it's visible regardless of sort/scroll and independent of the book column.
const RealTag = () => (
  <span
    className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1 ring-inset ring-amber-400/60 bg-amber-400/15 text-amber-200"
    aria-label="real money position"
    title="real money — live broker position"
  >
    REAL $
  </span>
);

const alignClass = (a?: Align) => (a === 'right' ? 'text-right' : '');

function DataTable<T>({
  data,
  columns,
  scroll = false,
  detail,
}: {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  scroll?: boolean;
  // When set, every row becomes expandable and this renders the detail panel
  // (the per-trade lifecycle chart). One row open at a time — the panel is a
  // focused inspection, not a comparison wall.
  detail?: (row: T) => React.ReactNode;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState('');
  const [openRow, setOpenRow] = useState<string | null>(null);
  const searchable = data.length > 6;
  const filterId = useId();

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableSortingRemoval: false,
  });

  const rows = table.getRowModel().rows;

  return (
    <div>
      {searchable && (
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <input
            id={filterId}
            name="filter"
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by symbol, book, source…"
            aria-label="Filter rows"
            className="w-full max-w-xs rounded-lg border border-border-strong bg-white/[0.03] px-3 py-1.5 text-sm text-text placeholder:text-text-subtle outline-none transition-colors focus:border-text/40"
          />
          {filter && (
            <span className="shrink-0 font-mono text-xs text-text-subtle tabular-nums">
              {rows.length} of {data.length}
            </span>
          )}
        </div>
      )}

      <div
        className={
          'overflow-x-auto rounded-xl border border-border bg-bg-elevated/40' +
          (scroll ? ' max-h-[28rem] overflow-y-auto themed-scroll' : '')
        }
      >
        <table className="w-full border-collapse text-sm">
          <thead className={scroll ? 'sticky top-0 z-10 bg-bg-elevated/90 backdrop-blur' : ''}>
            {table.getHeaderGroups().map((hg) => (
              <tr
                key={hg.id}
                className="text-left font-mono text-[11px] uppercase tracking-wider text-text-subtle"
              >
                {hg.headers.map((header) => {
                  const meta = header.column.columnDef.meta as Meta | undefined;
                  const sortable = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        sorted === 'asc'
                          ? 'ascending'
                          : sorted === 'desc'
                            ? 'descending'
                            : undefined
                      }
                      className={'px-4 py-2.5 font-medium ' + alignClass(meta?.align)}
                    >
                      {header.isPlaceholder ? null : sortable ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={
                            'inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-text ' +
                            (sorted ? 'text-text' : '')
                          }
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <span aria-hidden="true" className={sorted ? 'opacity-90' : 'opacity-30'}>
                            {sorted === 'asc' ? '↑' : sorted === 'desc' ? '↓' : '↕'}
                          </span>
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-8 text-center text-sm text-text-muted"
                >
                  Nothing here.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const expanded = detail != null && openRow === row.id;
                return (
                  <Fragment key={row.id}>
                    <tr
                      className={
                        'border-t border-border/70 transition-colors hover:bg-white/[0.02]' +
                        (detail ? ' cursor-pointer' : '') +
                        (expanded ? ' bg-white/[0.03]' : '')
                      }
                      onClick={
                        detail
                          ? () => setOpenRow((cur) => (cur === row.id ? null : row.id))
                          : undefined
                      }
                    >
                      {row.getVisibleCells().map((cell, ci) => {
                        const meta = cell.column.columnDef.meta as Meta | undefined;
                        return (
                          <td
                            key={cell.id}
                            className={
                              'px-4 py-2.5 ' +
                              alignClass(meta?.align) +
                              ' ' +
                              (meta?.className ?? '')
                            }
                          >
                            {detail && ci === 0 ? (
                              <span className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  aria-expanded={expanded}
                                  aria-label={
                                    (expanded ? 'Hide' : 'Show') + ' trade lifecycle chart'
                                  }
                                  onClick={(e) => {
                                    // The row onClick covers pointer users; keep
                                    // the button for keyboard/AT without firing twice.
                                    e.stopPropagation();
                                    setOpenRow((cur) => (cur === row.id ? null : row.id));
                                  }}
                                  className={
                                    'inline-block w-3 text-center text-[10px] transition-transform ' +
                                    (expanded
                                      ? 'rotate-90 text-text'
                                      : 'text-text-subtle hover:text-text')
                                  }
                                >
                                  ▶
                                </button>
                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </span>
                            ) : (
                              flexRender(cell.column.columnDef.cell, cell.getContext())
                            )}
                          </td>
                        );
                      })}
                    </tr>
                    {expanded && (
                      <tr className="border-t border-border/40 bg-bg/40">
                        <td colSpan={columns.length} className="p-0">
                          {detail(row.original)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const bookCell = (b?: string, isReal?: boolean) => (
  <span
    className={
      'inline-flex rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset ' + bookBadge(b, isReal)
    }
  >
    {(b ?? '—').replace(' stock', ' stk').replace(' crypto', ' crp')}
  </span>
);

const positionColumns: ColumnDef<Position, unknown>[] = [
  {
    accessorKey: 'symbol',
    header: 'Name',
    meta: { className: 'whitespace-nowrap text-text font-medium' },
    cell: ({ row }) => {
      const p = row.original;
      const ed = p.earnings_days;
      return (
        <span className="inline-flex items-center gap-1.5" title={p.thesis ?? undefined}>
          <span>
            {verdict(p.pnl_pct)} {p.symbol}
          </span>
          {p.is_real && <RealTag />}
          {p.pyramid_eligible && (
            <span
              className="rounded px-1 py-0.5 text-[9px] font-medium ring-1 ring-inset ring-emerald-500/20 bg-emerald-500/10 text-emerald-300"
              title="up ≥1R with stop at breakeven — eligible to pyramid"
            >
              ▲ add
            </span>
          )}
          {typeof ed === 'number' && ed >= 0 && ed <= 7 && (
            <span
              className="rounded px-1 py-0.5 text-[9px] font-medium ring-1 ring-inset ring-amber-500/20 bg-amber-500/10 text-amber-300"
              title="earnings within 7 days — binary risk"
            >
              ⚠ ER {ed}d
            </span>
          )}
        </span>
      );
    },
  },
  {
    id: 'book',
    accessorFn: (r) => r.book,
    header: 'Book',
    cell: ({ row }) => bookCell(row.original.book, row.original.is_real),
  },
  {
    accessorKey: 'entry',
    header: 'Entry',
    meta: {
      align: 'right',
      className: 'whitespace-nowrap font-mono tabular-nums text-text-subtle',
    },
    cell: ({ row }) => fmtPrice(row.original.entry),
  },
  {
    accessorKey: 'current',
    header: 'Price',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums text-text-muted' },
    cell: ({ row }) => fmtPrice(row.original.current),
  },
  {
    accessorKey: 'pnl_pct',
    header: 'P&L %',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums' },
    cell: ({ row }) => (
      <span className={pnlTone(row.original.pnl_pct)}>
        {row.original.pnl_pct == null
          ? '—'
          : (row.original.pnl_pct > 0 ? '+' : '') + row.original.pnl_pct + '%'}
      </span>
    ),
  },
  {
    accessorKey: 'gain_r',
    header: 'R',
    meta: { align: 'right', className: 'font-mono tabular-nums text-text-muted' },
    cell: ({ row }) =>
      row.original.gain_r == null
        ? '—'
        : (row.original.gain_r > 0 ? '+' : '') + row.original.gain_r + 'R',
  },
  {
    accessorKey: 'peak_pct',
    header: 'Peak',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums' },
    cell: ({ row }) => {
      const p = row.original;
      if (p.peak_pct == null) return <span className="text-text-subtle">—</span>;
      // Amber: was ≥+5% ahead but sits at/below flat now — a round-trip in progress.
      const fading = p.peak_pct >= 5 && (p.pnl_pct ?? 0) <= 0;
      return (
        <span
          className={fading ? 'text-amber-300' : 'text-text-muted'}
          title={
            fading
              ? 'was ahead ≥5%, now flat or down — giving the gain back'
              : 'best unrealized gain so far'
          }
        >
          +{p.peak_pct}%
        </span>
      );
    },
  },
  {
    accessorKey: 'pnl_usd',
    header: 'P&L $',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums text-text-muted' },
    cell: ({ row }) => fmtUsd(row.original.pnl_usd),
  },
  {
    accessorKey: 'days_held',
    header: 'Held',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums text-text-muted' },
    cell: ({ row }) => {
      const p = row.original;
      if (p.days_held == null) return '—';
      return (
        <span>
          {p.days_held}d
          {typeof p.days_left === 'number' && (
            <span className="text-text-subtle"> ·{p.days_left} left</span>
          )}
        </span>
      );
    },
  },
  {
    accessorKey: 'stop_dist_pct',
    header: 'Stop',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums text-text-muted' },
    cell: ({ row }) =>
      row.original.stop_dist_pct == null ? '—' : row.original.stop_dist_pct + '% ↓',
  },
  {
    accessorKey: 'pct_of_book',
    header: 'Size',
    meta: { align: 'right', className: 'font-mono tabular-nums text-text-muted' },
    cell: ({ row }) => (row.original.pct_of_book == null ? '—' : row.original.pct_of_book + '%'),
  },
  {
    id: 'conviction',
    accessorFn: (r) => r.conviction,
    header: 'Conv',
    meta: { className: 'whitespace-nowrap' },
    cell: ({ row }) => {
      const c = row.original.conviction;
      if (!c) return <span className="text-text-subtle">—</span>;
      const t =
        c === 'high' ? 'text-emerald-300' : c === 'low' ? 'text-text-subtle' : 'text-text-muted';
      return <span className={'text-xs ' + t}>{c}</span>;
    },
  },
  {
    accessorKey: 'source',
    header: 'Source',
    meta: { className: 'whitespace-nowrap text-text-subtle' },
    cell: ({ row }) => row.original.source || '—',
  },
];

const closedColumns: ColumnDef<Closed, unknown>[] = [
  {
    accessorKey: 'symbol',
    header: 'Name',
    meta: { className: 'whitespace-nowrap text-text font-medium' },
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-1.5">
        <span>
          {verdict(row.original.return_pct)} {row.original.symbol}
        </span>
        {row.original.is_real && <RealTag />}
      </span>
    ),
  },
  {
    id: 'book',
    accessorFn: (r) => r.book,
    header: 'Book',
    cell: ({ row }) => bookCell(row.original.book, row.original.is_real),
  },
  {
    accessorKey: 'return_pct',
    header: 'Return',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums' },
    cell: ({ row }) => (
      <span className={pnlTone(row.original.return_pct)}>
        {row.original.return_pct == null
          ? '—'
          : (row.original.return_pct > 0 ? '+' : '') + row.original.return_pct + '%'}
      </span>
    ),
  },
  {
    accessorKey: 'peak_pct',
    header: 'Peak',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums text-text-muted' },
    cell: ({ row }) =>
      row.original.peak_pct == null ? (
        <span
          className="text-text-subtle"
          title="no peak recorded (pre-watermark trade or never above entry)"
        >
          —
        </span>
      ) : (
        <span title="best unrealized gain the trade reached">+{row.original.peak_pct}%</span>
      ),
  },
  {
    accessorKey: 'capture_pct',
    header: 'Kept',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums' },
    cell: ({ row }) => {
      const c = row.original;
      if (c.capture_pct == null) return <span className="text-text-subtle">—</span>;
      return (
        <span
          className={captureTone(c.peak_pct, c.capture_pct)}
          title="% of the peak gain the exit kept — ~100 sold near the top, ≤0 round-tripped"
        >
          {c.capture_pct}%
        </span>
      );
    },
  },
  {
    accessorKey: 'pnl_usd',
    header: 'P&L $',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums text-text-muted' },
    cell: ({ row }) => fmtUsd(row.original.pnl_usd),
  },
  {
    accessorKey: 'exit_reason',
    header: 'Exit',
    meta: { className: 'whitespace-nowrap text-text-muted' },
    cell: ({ row }) => row.original.exit_reason || '—',
  },
  {
    accessorKey: 'source',
    header: 'Source',
    meta: { className: 'whitespace-nowrap text-text-subtle' },
    cell: ({ row }) => row.original.source || '—',
  },
  {
    accessorKey: 'closed_at',
    header: 'Closed',
    meta: {
      align: 'right',
      className: 'whitespace-nowrap font-mono tabular-nums text-text-subtle',
    },
    cell: ({ row }) => row.original.closed_at || '—',
  },
];

// ── Equity sparkline (pure SVG, no charting dependency) ──────────────────────
// Two series on one dollar scale: the book's equity (green/red = up/down) and a
// muted-blue benchmark grown from the same starting dollar (firstEquity ×
// (1+bench%)). Benchmark is blue-not-red so P&L color stays unambiguous.
const BENCH_COLOR = '#6ea8fe';
function EquityChart({ label, points }: { label: string; points: EquityPoint[] }) {
  // Keep only points with a real equity value, but carry bench_pct/ret_pct along.
  const rows = points.filter((p): p is EquityPoint & { equity: number } => p.equity != null);
  if (rows.length < 2) {
    return (
      <div className="rounded-xl border border-border bg-bg-elevated/40 p-4">
        <div className="font-mono text-[11px] uppercase tracking-wider text-text-subtle">
          {label}
        </div>
        <p className="mt-3 text-xs text-text-muted">No history yet.</p>
      </div>
    );
  }
  const W = 260,
    H = 64,
    pad = 4;
  const vals = rows.map((r) => r.equity);
  const first = vals[0];
  const last = vals[vals.length - 1];
  const up = last >= first;

  // Benchmark grown from the same starting dollar. Only where bench_pct exists.
  const benchEq = rows.map((r) =>
    typeof r.bench_pct === 'number' ? first * (1 + r.bench_pct / 100) : null,
  );
  const benchCount = benchEq.filter((v) => v != null).length;
  const hasBench = benchCount >= 2;

  const scaleVals = hasBench ? vals.concat(benchEq.filter((v): v is number => v != null)) : vals;
  const min = Math.min(...scaleVals),
    max = Math.max(...scaleVals);
  const span = max - min || 1;
  const step = (W - pad * 2) / (rows.length - 1);
  const x = (i: number) => pad + i * step;
  const y = (v: number) => H - pad - ((v - min) / span) * (H - pad * 2);

  const d = vals
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(' ');
  // Benchmark path may have leading/trailing gaps; start a fresh sub-path after
  // any null so we never draw a line through missing data.
  let benchD = '';
  let penDown = false;
  benchEq.forEach((v, i) => {
    if (v == null) {
      penDown = false;
      return;
    }
    benchD += `${penDown ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    penDown = true;
  });

  const color = up ? '#7af2a0' : '#fb7185';
  const chgPct = first ? ((last - first) / first) * 100 : 0;
  // Gap vs benchmark in points: book cumulative return minus benchmark return.
  const lastRow = rows[rows.length - 1];
  const bookRet = typeof lastRow.ret_pct === 'number' ? lastRow.ret_pct : chgPct;
  const benchRet = typeof lastRow.bench_pct === 'number' ? lastRow.bench_pct : null;
  const gapPts = benchRet != null ? bookRet - benchRet : null;

  return (
    <div className="rounded-xl border border-border bg-bg-elevated/40 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-mono text-[11px] uppercase tracking-wider text-text-subtle">
          {label}
        </div>
        <div
          className={
            'font-mono text-xs tabular-nums ' + (up ? 'text-emerald-300' : 'text-rose-300')
          }
        >
          {up ? '+' : ''}
          {chgPct.toFixed(1)}%
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={
          `${label}: ${up ? 'up' : 'down'} ${Math.abs(chgPct).toFixed(1)} percent` +
          (gapPts != null
            ? `, ${gapPts >= 0 ? 'ahead of' : 'behind'} benchmark by ${Math.abs(gapPts).toFixed(1)} points`
            : '')
        }
      >
        {hasBench && (
          <path
            d={benchD.trim()}
            fill="none"
            stroke={BENCH_COLOR}
            strokeWidth="1.25"
            strokeOpacity="0.7"
            strokeDasharray="3 3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[10px] tabular-nums">
        {hasBench ? (
          <span className="inline-flex items-center gap-2 text-text-subtle">
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-0.5 w-3 align-middle"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
              book
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-0 w-3 border-t border-dashed align-middle"
                style={{ borderColor: BENCH_COLOR }}
                aria-hidden="true"
              />
              bench
            </span>
          </span>
        ) : (
          <span className="text-text-subtle">${first.toLocaleString()}</span>
        )}
        {gapPts != null ? (
          <span className={gapPts >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
            {gapPts >= 0 ? '+' : '−'}
            {Math.abs(gapPts).toFixed(1)} pts vs bench
          </span>
        ) : (
          <span className="text-text-subtle">${last.toLocaleString()}</span>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2.5 mt-9 font-mono text-[11px] uppercase tracking-wider text-text-subtle">
        {title}
        {count ? ` · ${count}` : ''}
      </h2>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-text-muted">{children}</p>
);

// ── Per-trade lifecycle detail (expandable row) ──────────────────────────────

const positionFacts = (p: Position): TradeFacts | null =>
  p.symbol && p.opened_at
    ? {
        symbol: p.symbol,
        book: p.book,
        opened_at: p.opened_at,
        entry: p.entry,
        init_stop: p.init_stop,
        stop: p.stop,
        peak_pct: p.peak_pct,
        result_pct: p.pnl_pct,
      }
    : null;

const closedFacts = (c: Closed): TradeFacts | null =>
  c.symbol && c.opened_at
    ? {
        symbol: c.symbol,
        book: c.book,
        opened_at: c.opened_at,
        closed_at: c.closed_at,
        entry: c.entry,
        exit: c.exit,
        init_stop: c.init_stop,
        peak_pct: c.peak_pct,
        result_pct: c.return_pct,
      }
    : null;

function LifecycleDetail({ facts }: { facts: TradeFacts | null }) {
  if (!facts) {
    return (
      <p className="px-4 py-4 text-xs text-text-muted">
        No lifecycle data for this row (published before the chart fields existed — the next
        snapshot will carry them).
      </p>
    );
  }
  return <TradeLifecycle trade={facts} />;
}

const CURVE_LABELS: Record<string, string> = {
  stock: 'Stocks',
  crypto: 'Crypto',
  mild_stock: 'Mild stk',
  mild_crypto: 'Mild crp',
  aggressive_stock: 'Aggressive stk',
  aggressive_crypto: 'Aggressive crp',
  systematic: 'Systematic (no-AI)',
  alpaca: 'Alpaca (broker)',
};

// Sleeves first, then the control + live rails, so the grid reads in the same
// order as the book cards above. Unknown keys sort last, in publish order.
const CURVE_ORDER = [
  'stock',
  'crypto',
  'mild_stock',
  'mild_crypto',
  'aggressive_stock',
  'aggressive_crypto',
  'systematic',
  'alpaca',
];

export default function TraderTables({
  positions = [],
  closed = [],
  equityCurve = {},
}: {
  positions?: Position[];
  closed?: Closed[];
  equityCurve?: Record<string, EquityPoint[]>;
}) {
  const curves = Object.entries(equityCurve)
    .filter(([, pts]) => (pts?.length ?? 0) > 0)
    .sort(([a], [b]) => {
      const ia = CURVE_ORDER.indexOf(a),
        ib = CURVE_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  return (
    <>
      {curves.length > 0 && (
        <Section title="Equity curves · vs benchmark">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {curves.map(([key, pts]) => (
              <EquityChart key={key} label={CURVE_LABELS[key] ?? key} points={pts} />
            ))}
          </div>
        </Section>
      )}

      <Section title="Open positions" count={String(positions.length)}>
        {positions.length === 0 ? (
          <Empty>No open positions.</Empty>
        ) : (
          <DataTable
            data={positions}
            columns={positionColumns}
            scroll={positions.length > 12}
            detail={(p) => <LifecycleDetail facts={positionFacts(p)} />}
          />
        )}
      </Section>

      <Section title="Recent closed trades" count={String(closed.length)}>
        {closed.length === 0 ? (
          <Empty>No closed trades yet.</Empty>
        ) : (
          <DataTable
            data={closed}
            columns={closedColumns}
            scroll={closed.length > 12}
            detail={(c) => <LifecycleDetail facts={closedFacts(c)} />}
          />
        )}
      </Section>
    </>
  );
}
