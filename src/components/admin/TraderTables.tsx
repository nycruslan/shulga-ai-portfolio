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
import TradeLifecycle, { captureTone, type TradeEvent, type TradeFacts } from './TradeLifecycle';

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
  events?: TradeEvent[] | null;
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
  events?: TradeEvent[] | null;
};
type Align = 'left' | 'right';
// `help` puts a column's definition in its header, where it belongs — stated
// once, instead of repeated as an icon on every one of 73 rows.
type Meta = { align?: Align; className?: string; help?: React.ReactNode; helpLabel?: string };

// P&L polarity uses the reserved gain/loss tokens, never a categorical hue.
const pnlTone = (n?: number | null) =>
  n == null
    ? 'text-text-muted'
    : n > 0.05
      ? 'text-gain'
      : n < -0.05
        ? 'text-loss'
        : 'text-text-muted';

// Direction as a text glyph rather than an emoji. Emoji render differently on
// every platform and announce as their CLDR name ("large green circle"), which
// tells a screen-reader user nothing about the trade.
// Thresholds deliberately match pnlTone: the glyph is the non-color channel for
// exactly the same fact, so a row can never show a red number beside a "flat"
// mark. The old emoji used a different cutoff and did precisely that.
const dirMark = (n?: number | null) => (n == null ? '·' : n > 0.05 ? '▲' : n < -0.05 ? '▼' : '–');
const dirLabel = (n?: number | null) =>
  n == null ? 'no data' : n > 0.05 ? 'up' : n < -0.05 ? 'down' : 'flat';

// Color encodes STRATEGY FAMILY, not the individual book — five families fit
// the six validated categorical slots, where nine books would not. Asset class
// (stk/crp) rides the label text, which is already in the badge.
// Real money is the exception: it keeps the amber ring + bold, a deliberate
// safety signal paired with the "REAL $" text tag so it never relies on color.
const bookBadge = (b?: string, isReal?: boolean) => {
  const name = (b ?? '').toLowerCase();
  if (isReal || name.includes('robinhood'))
    return 'bg-amber-400/15 text-amber-200 ring-amber-400/60 font-semibold';
  if (name.includes('alpaca')) return 'bg-cat-5/12 text-cat-5 ring-cat-5/30';
  if (name.includes('systematic')) return 'bg-cat-4/12 text-cat-4 ring-cat-4/30';
  if (name.includes('aggressive')) return 'bg-cat-3/12 text-cat-3 ring-cat-3/30';
  if (name.includes('mild')) return 'bg-cat-2/12 text-cat-2 ring-cat-2/30';
  return 'bg-cat-1/12 text-cat-1 ring-cat-1/30';
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
    className="rounded bg-amber-400/15 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200 ring-1 ring-inset ring-amber-400/60"
    aria-label="real money position, live broker"
  >
    REAL $
  </span>
);

/**
 * A definition tooltip that keyboard and touch users can actually open.
 * Uses the native popover API, so there is no JS behind it and no focus trap to
 * get wrong — the browser handles light-dismiss, Escape and the top layer.
 */
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  // React 19 emits CSS-safe ids (`_r7R_23d_`), which matters here because the
  // id is interpolated into a custom property name below. React 18's `:r0:`
  // form would not have been.
  const id = useId();
  // Each pair needs its OWN anchor name. A single shared `anchor-name: --tip`
  // makes every popover resolve against whichever button the cascade picks, so
  // tooltips land next to the wrong column. The name is threaded through a
  // custom property on the wrapper, which both children inherit.
  return (
    <span className="tip-wrap" style={{ '--tip-anchor': `--tip-${id}` } as React.CSSProperties}>
      <button
        type="button"
        popoverTarget={id}
        className="tip-btn ml-1 align-middle"
        aria-label={label}
      >
        <span aria-hidden="true">?</span>
      </button>
      <div id={id} popover="auto" role="tooltip" className="tip-pop">
        {children}
      </div>
    </span>
  );
}

const alignClass = (a?: Align) => (a === 'right' ? 'text-right' : '');

// Exported: the Playground reuses this exact table (sortable, filterable,
// expandable rows) for its per-portfolio trade lists.
export function DataTable<T>({
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
          // `scroll` is set once a table passes 12 rows, which is also where
          // per-row render cost starts to matter (positions is 73, closed 60).
          // deferred-rows skips layout/paint for rows outside the scroll port.
          (scroll ? ' themed-scroll deferred-rows max-h-[28rem] overflow-y-auto' : '')
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
                      className={
                        'whitespace-nowrap px-4 py-2.5 font-medium ' + alignClass(meta?.align)
                      }
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
                      {/* Sibling of the sort button, never inside it — a button
                          nested in a button is invalid and breaks activation. */}
                      {meta?.help && (
                        <InfoTip label={meta.helpLabel ?? 'What this column means'}>
                          {meta.help}
                        </InfoTip>
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
      'inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset ' +
      bookBadge(b, isReal)
    }
  >
    {(b ?? '—').replace(' stock', ' stk').replace(' crypto', ' crp')}
  </span>
);

const positionColumns: ColumnDef<Position, unknown>[] = [
  {
    accessorKey: 'symbol',
    header: 'Name',
    meta: {
      className: 'whitespace-nowrap text-text font-medium',
      helpLabel: 'What the row markers mean',
      help: (
        <ul className="space-y-1">
          <li>
            <b className="text-text">▲ ▼ –</b> direction of the position, matching the P&amp;L
            color.
          </li>
          <li>
            <b className="text-amber-200">REAL $</b> a live broker position with real money in it.
          </li>
          <li>
            <b className="text-gain">▲ add</b> up at least 1R with the stop at breakeven, so it can
            be pyramided.
          </li>
          <li>
            <b className="text-warning">⚠ ER</b> earnings within 7 days. Binary risk the model
            can&rsquo;t price.
          </li>
          <li>Open a row to see its thesis and full lifecycle.</li>
        </ul>
      ),
    },
    cell: ({ row }) => {
      const p = row.original;
      const ed = p.earnings_days;
      return (
        <span className="inline-flex items-center gap-1.5">
          <span>
            <span className={pnlTone(p.pnl_pct)} aria-hidden="true">
              {dirMark(p.pnl_pct)}
            </span>{' '}
            <span className="sr-only">{dirLabel(p.pnl_pct)}, </span>
            {p.symbol}
          </span>
          {p.is_real && <RealTag />}
          {p.pyramid_eligible && (
            <span className="rounded bg-gain/10 px-1 py-0.5 text-[11px] font-medium text-gain ring-1 ring-inset ring-gain/25">
              ▲ add
            </span>
          )}
          {typeof ed === 'number' && ed >= 0 && ed <= 7 && (
            <span className="rounded bg-warning/10 px-1 py-0.5 text-[11px] font-medium text-warning ring-1 ring-inset ring-warning/25">
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
    meta: {
      align: 'right',
      className: 'whitespace-nowrap font-mono tabular-nums',
      helpLabel: 'What Peak means',
      help: (
        <>
          The best unrealized gain the trade has reached. Amber means it was at least 5% ahead and
          now sits flat or down, so it&rsquo;s giving the gain back.
        </>
      ),
    },
    cell: ({ row }) => {
      const p = row.original;
      if (p.peak_pct == null) return <span className="text-text-subtle">—</span>;
      // Amber: was ≥+5% ahead but sits at/below flat now — a round-trip in progress.
      const fading = p.peak_pct >= 5 && (p.pnl_pct ?? 0) <= 0;
      return (
        <span className={fading ? 'text-warning' : 'text-text-muted'}>
          +{p.peak_pct}%{fading && <span className="sr-only"> (giving the gain back)</span>}
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
      // Conviction is an ordered rank, not a P&L outcome, so it steps through
      // text weight rather than borrowing the gain color.
      const t =
        c === 'high'
          ? 'text-text font-medium'
          : c === 'low'
            ? 'text-text-subtle'
            : 'text-text-muted';
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
          <span className={pnlTone(row.original.return_pct)} aria-hidden="true">
            {dirMark(row.original.return_pct)}
          </span>{' '}
          <span className="sr-only">{dirLabel(row.original.return_pct)}, </span>
          {row.original.symbol}
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
    meta: {
      align: 'right',
      className: 'whitespace-nowrap font-mono tabular-nums text-text-muted',
      helpLabel: 'What Peak means',
      help: (
        <>
          The best unrealized gain the trade reached. A dash means no peak was recorded, either a
          pre-watermark trade or one that never traded above entry.
        </>
      ),
    },
    cell: ({ row }) =>
      row.original.peak_pct == null ? (
        <span className="text-text-subtle">—</span>
      ) : (
        <span>+{row.original.peak_pct}%</span>
      ),
  },
  {
    accessorKey: 'capture_pct',
    header: 'Kept',
    meta: {
      align: 'right',
      className: 'whitespace-nowrap font-mono tabular-nums',
      helpLabel: 'What Kept measures',
      help: (
        <>
          Exit quality: the share of the peak gain the exit actually kept. Around 100 means it sold
          near the top. Zero or below means the trade round-tripped.
        </>
      ),
    },
    cell: ({ row }) => {
      const c = row.original;
      if (c.capture_pct == null) return <span className="text-text-subtle">—</span>;
      return <span className={captureTone(c.peak_pct, c.capture_pct)}>{c.capture_pct}%</span>;
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
        events: p.events,
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
        events: c.events,
      }
    : null;

function LifecycleDetail({ facts, thesis }: { facts: TradeFacts | null; thesis?: string | null }) {
  // The thesis used to live in a title="" on the ticker, which meant keyboard
  // and touch users could never read it. It belongs here, in the row's own
  // detail panel, where it has room to be a sentence.
  const note = thesis ? (
    <p className="border-b border-border px-4 py-3 text-sm leading-relaxed text-text-muted">
      <span className="font-mono text-[11px] uppercase tracking-wider text-text-subtle">
        Thesis ·{' '}
      </span>
      {thesis}
    </p>
  ) : null;

  if (!facts) {
    return (
      <>
        {note}
        <p className="px-4 py-4 text-xs text-text-muted">
          No lifecycle data for this row (published before the chart fields existed — the next
          snapshot will carry them).
        </p>
      </>
    );
  }
  // Keyed per trade: a different trade remounts the chart, so its fetch state
  // starts clean without effect-time setState (react-hooks/set-state-in-effect).
  return (
    <>
      {note}
      <TradeLifecycle
        key={facts.symbol + ':' + (facts.opened_at ?? '') + ':' + (facts.closed_at ?? '')}
        trade={facts}
      />
    </>
  );
}

// Positions and closed trades ship as separate islands so each can mount into
// its own tab panel. Splitting them also means the 60-row closed table isn't
// built on first paint when the user is looking at positions.

export function PositionsTable({ positions = [] }: { positions?: Position[] }) {
  if (positions.length === 0) return <Empty>No open positions.</Empty>;
  return (
    <DataTable
      data={positions}
      columns={positionColumns}
      scroll={positions.length > 12}
      detail={(p) => <LifecycleDetail facts={positionFacts(p)} thesis={p.thesis} />}
    />
  );
}

export function ClosedTable({ closed = [] }: { closed?: Closed[] }) {
  if (closed.length === 0) return <Empty>No closed trades yet.</Empty>;
  return (
    <DataTable
      data={closed}
      columns={closedColumns}
      scroll={closed.length > 12}
      detail={(c) => <LifecycleDetail facts={closedFacts(c)} />}
    />
  );
}
