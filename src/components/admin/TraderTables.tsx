import { useId, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';

// Row shapes mirror the trader snapshot in lib/turso.ts. Kept local so this
// client island never imports the server-only Turso module. Every field is
// optional — the publisher can change without breaking the table.
type Position = {
  book?: string; symbol?: string; entry?: number | null; current?: number | null;
  pnl_pct?: number | null; pnl_usd?: number | null; days_held?: number | null;
  days_left?: number | null; stop_dist_pct?: number | null; pct_of_book?: number | null;
  conviction?: string | null; source?: string | null; earnings_days?: number | null;
  thesis?: string | null;
};
type Closed = {
  book?: string; symbol?: string; return_pct?: number | null; pnl_usd?: number | null;
  exit_reason?: string | null; source?: string | null; closed_at?: string | null;
};
type EquityPoint = { t?: string; equity?: number | null; bench_pct?: number | null };

type Align = 'left' | 'right';
type Meta = { align?: Align; className?: string };

const pnlTone = (n?: number | null) =>
  n == null ? 'text-text-muted' : n > 0.05 ? 'text-emerald-300' : n < -0.05 ? 'text-rose-300' : 'text-text-muted';

const verdict = (n?: number | null) => (n == null ? '⚪' : n > 0.05 ? '🟢' : n < -2 ? '🔴' : '🟡');

const bookBadge = (b?: string) => {
  const aggr = (b ?? '').includes('aggressive');
  return aggr ? 'bg-amber-500/10 text-amber-300 ring-amber-500/20' : 'bg-sky-500/10 text-sky-300 ring-sky-500/20';
};

const fmtUsd = (n?: number | null) =>
  n == null ? '—' : (n >= 0 ? '+$' : '−$') + Math.abs(n).toLocaleString();

const alignClass = (a?: Align) => (a === 'right' ? 'text-right' : '');

function DataTable<T>({
  data,
  columns,
  scroll = false,
}: {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  scroll?: boolean;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState('');
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
                        sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined
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
                <td colSpan={columns.length} className="px-4 py-8 text-center text-sm text-text-muted">
                  Nothing here.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-border/70 transition-colors hover:bg-white/[0.02]"
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta as Meta | undefined;
                    return (
                      <td
                        key={cell.id}
                        className={'px-4 py-2.5 ' + alignClass(meta?.align) + ' ' + (meta?.className ?? '')}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const bookCell = (b?: string) => (
  <span className={'inline-flex rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset ' + bookBadge(b)}>
    {(b ?? '—').replace(' stock', ' stk').replace(' crypto', ' crp')}
  </span>
);

const positionColumns: ColumnDef<Position, unknown>[] = [
  {
    accessorKey: 'symbol',
    header: 'Name',
    meta: { className: 'whitespace-nowrap text-text font-medium' },
    cell: ({ row }) => (
      <span>
        {verdict(row.original.pnl_pct)} {row.original.symbol}
      </span>
    ),
  },
  { id: 'book', accessorFn: (r) => r.book, header: 'Book', cell: ({ row }) => bookCell(row.original.book) },
  {
    accessorKey: 'pnl_pct',
    header: 'P&L %',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums' },
    cell: ({ row }) => (
      <span className={pnlTone(row.original.pnl_pct)}>
        {row.original.pnl_pct == null ? '—' : (row.original.pnl_pct > 0 ? '+' : '') + row.original.pnl_pct + '%'}
      </span>
    ),
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
    meta: { align: 'right', className: 'font-mono tabular-nums text-text-muted' },
    cell: ({ row }) => (row.original.days_held == null ? '—' : row.original.days_held + 'd'),
  },
  {
    accessorKey: 'stop_dist_pct',
    header: 'Stop',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums text-text-muted' },
    cell: ({ row }) => (row.original.stop_dist_pct == null ? '—' : row.original.stop_dist_pct + '% ↓'),
  },
  {
    accessorKey: 'pct_of_book',
    header: 'Size',
    meta: { align: 'right', className: 'font-mono tabular-nums text-text-muted' },
    cell: ({ row }) => (row.original.pct_of_book == null ? '—' : row.original.pct_of_book + '%'),
  },
  { accessorKey: 'source', header: 'Source', meta: { className: 'whitespace-nowrap text-text-subtle' }, cell: ({ row }) => row.original.source || '—' },
];

const closedColumns: ColumnDef<Closed, unknown>[] = [
  {
    accessorKey: 'symbol',
    header: 'Name',
    meta: { className: 'whitespace-nowrap text-text font-medium' },
    cell: ({ row }) => (
      <span>
        {verdict(row.original.return_pct)} {row.original.symbol}
      </span>
    ),
  },
  { id: 'book', accessorFn: (r) => r.book, header: 'Book', cell: ({ row }) => bookCell(row.original.book) },
  {
    accessorKey: 'return_pct',
    header: 'Return',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums' },
    cell: ({ row }) => (
      <span className={pnlTone(row.original.return_pct)}>
        {row.original.return_pct == null ? '—' : (row.original.return_pct > 0 ? '+' : '') + row.original.return_pct + '%'}
      </span>
    ),
  },
  {
    accessorKey: 'pnl_usd',
    header: 'P&L $',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums text-text-muted' },
    cell: ({ row }) => fmtUsd(row.original.pnl_usd),
  },
  { accessorKey: 'exit_reason', header: 'Exit', meta: { className: 'whitespace-nowrap text-text-muted' }, cell: ({ row }) => row.original.exit_reason || '—' },
  { accessorKey: 'source', header: 'Source', meta: { className: 'whitespace-nowrap text-text-subtle' }, cell: ({ row }) => row.original.source || '—' },
  {
    accessorKey: 'closed_at',
    header: 'Closed',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums text-text-subtle' },
    cell: ({ row }) => row.original.closed_at || '—',
  },
];

// ── Equity sparkline (pure SVG, no charting dependency) ──────────────────────
function EquityChart({ label, points }: { label: string; points: EquityPoint[] }) {
  const vals = points.map((p) => p.equity).filter((v): v is number => v != null);
  if (vals.length < 2) {
    return (
      <div className="rounded-xl border border-border bg-bg-elevated/40 p-4">
        <div className="font-mono text-[11px] uppercase tracking-wider text-text-subtle">{label}</div>
        <p className="mt-3 text-xs text-text-muted">No history yet.</p>
      </div>
    );
  }
  const W = 260, H = 64, pad = 4;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const step = (W - pad * 2) / (vals.length - 1);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - pad * 2);
  const d = vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${(pad + i * step).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const last = vals[vals.length - 1], first = vals[0];
  const up = last >= first;
  const color = up ? '#7af2a0' : '#fb7185';
  const chgPct = first ? ((last - first) / first) * 100 : 0;
  return (
    <div className="rounded-xl border border-border bg-bg-elevated/40 p-4">
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-[11px] uppercase tracking-wider text-text-subtle">{label}</div>
        <div className={'font-mono text-xs tabular-nums ' + (up ? 'text-emerald-300' : 'text-rose-300')}>
          {up ? '+' : ''}{chgPct.toFixed(1)}%
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" preserveAspectRatio="none" aria-label={`${label} equity curve`}>
        <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-text-subtle tabular-nums">
        <span>${first.toLocaleString()}</span>
        <span>${last.toLocaleString()}</span>
      </div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2.5 mt-9 font-mono text-[11px] uppercase tracking-wider text-text-subtle">
        {title}{count ? ` · ${count}` : ''}
      </h2>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-text-muted">{children}</p>
);

const CURVE_LABELS: Record<string, string> = {
  stock: 'Stocks', crypto: 'Crypto', aggressive_stock: 'Aggressive stk', aggressive_crypto: 'Aggressive crp',
};

export default function TraderTables({
  positions = [],
  closed = [],
  equityCurve = {},
}: {
  positions?: Position[];
  closed?: Closed[];
  equityCurve?: Record<string, EquityPoint[]>;
}) {
  const curves = Object.entries(equityCurve).filter(([, pts]) => (pts?.length ?? 0) > 0);
  return (
    <>
      {curves.length > 0 && (
        <Section title="Equity curves">
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
          <DataTable data={positions} columns={positionColumns} scroll={positions.length > 12} />
        )}
      </Section>

      <Section title="Recent closed trades" count={String(closed.length)}>
        {closed.length === 0 ? (
          <Empty>No closed trades yet.</Empty>
        ) : (
          <DataTable data={closed} columns={closedColumns} scroll={closed.length > 12} />
        )}
      </Section>
    </>
  );
}
