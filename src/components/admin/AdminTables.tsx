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

// Row shapes mirror the snapshot in lib/turso.ts. Kept local so this client
// island never imports the server-only Turso module.
type Job = {
  id: string;
  company: string;
  title: string;
  score: number;
  comp: string;
  url: string;
  location: string;
  contacts: number;
};
type Application = {
  id: string;
  company: string;
  title: string;
  status: string;
  applied_at: string | null;
  url: string;
};

type Align = 'left' | 'right';
type Meta = { align?: Align; className?: string };

const scoreTone = (n: number) =>
  n >= 80 ? 'text-emerald-300' : n >= 68 ? 'text-sky-300' : 'text-text-muted';

const statusBadge = (s: string) =>
  ({
    applied: 'bg-sky-500/10 text-sky-300 ring-sky-500/20',
    screen: 'bg-amber-500/10 text-amber-300 ring-amber-500/20',
    onsite: 'bg-violet-500/10 text-violet-300 ring-violet-500/20',
    offer: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20',
    rejected: 'bg-rose-500/10 text-rose-300 ring-rose-500/20',
    withdrawn: 'bg-white/5 text-text-subtle ring-white/10',
  })[s] ?? 'bg-white/5 text-text-muted ring-white/10';

// Pull the leading number out of currency-ish strings ("$310k" -> 310) so TC
// sorts numerically instead of lexically. Empty/'—' sink to the bottom.
const compValue = (s: string) => {
  const m = s.match(/-?\d[\d,.]*/);
  return m ? parseFloat(m[0].replace(/,/g, '')) : -Infinity;
};

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy job id"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
      className="font-mono text-xs text-text-subtle transition-colors hover:text-text"
    >
      {copied ? 'copied ✓' : value}
    </button>
  );
}

function ExternalLink({ url, label }: { url: string; label: string }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener"
      className="whitespace-nowrap text-text-muted underline-offset-4 hover:text-text hover:underline"
    >
      {label} →
    </a>
  );
}

// Visually-hidden header label so the action column still has an accessible
// header (axe: td-has-header) without showing a column title.
const srHeader = (text: string) => () => <span className="sr-only">{text}</span>;

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
            placeholder="Filter by company, role, location…"
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
                  No matches.
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
                        className={
                          'px-4 py-2.5 ' + alignClass(meta?.align) + ' ' + (meta?.className ?? '')
                        }
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

const jobColumns: ColumnDef<Job, unknown>[] = [
  {
    accessorKey: 'company',
    header: 'Company',
    meta: { className: 'whitespace-nowrap text-text' },
    cell: ({ row }) => (
      <>
        {row.original.company}
        {row.original.contacts > 0 && (
          <span className="ml-1.5 text-text-subtle">· 👥 {row.original.contacts}</span>
        )}
      </>
    ),
  },
  { accessorKey: 'title', header: 'Role', meta: { className: 'text-text-muted' } },
  {
    accessorKey: 'score',
    header: 'Score',
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums' },
    cell: ({ row }) => <span className={scoreTone(row.original.score)}>{row.original.score}%</span>,
  },
  {
    id: 'comp',
    accessorFn: (r) => r.comp,
    header: 'TC',
    sortingFn: (a, b) => compValue(a.original.comp) - compValue(b.original.comp),
    meta: { align: 'right', className: 'whitespace-nowrap font-mono tabular-nums text-text-muted' },
    cell: ({ row }) => row.original.comp || '—',
  },
  {
    accessorKey: 'location',
    header: 'Location',
    meta: { className: 'whitespace-nowrap text-text-muted' },
    cell: ({ row }) => row.original.location || '—',
  },
  {
    accessorKey: 'id',
    header: 'ID',
    enableSorting: false,
    cell: ({ row }) => <CopyButton value={row.original.id} />,
  },
  {
    id: 'action',
    header: srHeader('Apply link'),
    enableSorting: false,
    meta: { align: 'right' },
    cell: ({ row }) => <ExternalLink url={row.original.url} label="apply" />,
  },
];

const appColumns: ColumnDef<Application, unknown>[] = [
  { accessorKey: 'company', header: 'Company', meta: { className: 'whitespace-nowrap text-text' } },
  { accessorKey: 'title', header: 'Role', meta: { className: 'text-text-muted' } },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <span
        className={
          'inline-flex rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ' +
          statusBadge(row.original.status)
        }
      >
        {row.original.status}
      </span>
    ),
  },
  {
    accessorKey: 'applied_at',
    header: 'Applied',
    meta: { className: 'whitespace-nowrap font-mono tabular-nums text-text-muted' },
    cell: ({ row }) => (row.original.applied_at ? row.original.applied_at.slice(0, 10) : '—'),
  },
  {
    accessorKey: 'id',
    header: 'ID',
    enableSorting: false,
    cell: ({ row }) => <CopyButton value={row.original.id} />,
  },
  {
    id: 'action',
    header: srHeader('Listing link'),
    enableSorting: false,
    meta: { align: 'right' },
    cell: ({ row }) => <ExternalLink url={row.original.url} label="link" />,
  },
];

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2.5 mt-9 font-mono text-[11px] uppercase tracking-wider text-text-subtle">
        {title} · {count}
      </h2>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-text-muted">{children}</p>
);

export default function AdminTables({
  today,
  matches,
  matchesTotal,
  applications,
}: {
  today: Job[];
  matches: Job[];
  matchesTotal: number;
  applications: Application[];
}) {
  return (
    <>
      <Section title="Today's matches" count={String(today.length)}>
        {today.length === 0 ? (
          <Empty>Nothing new today.</Empty>
        ) : (
          <DataTable data={today} columns={jobColumns} />
        )}
      </Section>

      <Section title="Matches" count={`showing ${matches.length} of ${matchesTotal}`}>
        {matches.length === 0 ? (
          <Empty>No matches stored yet.</Empty>
        ) : (
          <DataTable data={matches} columns={jobColumns} scroll />
        )}
      </Section>

      <Section title="Active applications" count={String(applications.length)}>
        {applications.length === 0 ? (
          <Empty>No active applications.</Empty>
        ) : (
          <DataTable data={applications} columns={appColumns} />
        )}
      </Section>
    </>
  );
}
