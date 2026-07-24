import { useCallback, useId, useMemo, useRef, useState } from 'react';

// ── Equity charts ────────────────────────────────────────────────────────────
//
// Two views over the same data, both on ONE shared scale:
//
//   <EquityDeck/>   every book on a single plot, indexed to 100 at t0
//   <BookCurves/>   per-book small multiples, sharing that same y-domain
//
// Why indexed rather than dollars: the books run from $99 to $99,556. On a
// dollar axis the small ones are a flat line at the bottom and nothing is
// comparable. Indexing to 100 puts every book on one axis honestly, which is
// the standard fix for series of different magnitude (the alternative — a
// second y-axis — invents correlations that aren't in the data).
//
// Why one shared domain across the small multiples: independent per-card
// autoscaling makes a book that moved 0.1% draw the same amplitude as one that
// moved 9%. Readers assume small multiples share a scale, so independent scales
// produce confident wrong reads. Every card here uses the same [min,max].

// Only the fields the charts actually read. The page pre-reduces the publisher's
// raw curve to one point per date before handing it over, so `ret_pct` and the
// intraday duplicates never reach the client.
export type EquityPoint = {
  t?: string;
  equity?: number | null;
  bench_pct?: number | null;
};

// Color encodes STRATEGY FAMILY, never the individual book. Five families fit
// inside the six validated categorical slots. Asset class (stock vs crypto)
// rides a second channel — the dash pattern plus the text label — so eight
// curves never need eight hues.
type Family = 'core' | 'mild' | 'aggressive' | 'systematic' | 'broker';

const FAMILY_COLOR: Record<Family, string> = {
  core: 'var(--color-cat-1)',
  mild: 'var(--color-cat-2)',
  aggressive: 'var(--color-cat-3)',
  systematic: 'var(--color-cat-4)',
  broker: 'var(--color-cat-5)',
};

const CURVE_META: Record<string, { label: string; family: Family; crypto: boolean }> = {
  stock: { label: 'Core stk', family: 'core', crypto: false },
  crypto: { label: 'Core crp', family: 'core', crypto: true },
  mild_stock: { label: 'Mild stk', family: 'mild', crypto: false },
  mild_crypto: { label: 'Mild crp', family: 'mild', crypto: true },
  aggressive_stock: { label: 'Aggr stk', family: 'aggressive', crypto: false },
  aggressive_crypto: { label: 'Aggr crp', family: 'aggressive', crypto: true },
  systematic: { label: 'Systematic (no-AI)', family: 'systematic', crypto: false },
  alpaca: { label: 'Alpaca (broker)', family: 'broker', crypto: false },
};

const CURVE_ORDER = Object.keys(CURVE_META);

export type Series = {
  key: string;
  label: string;
  color: string;
  /** Asset-class channel: crypto draws dashed so identity survives greyscale. */
  dashed: boolean;
  /** Indexed to 100 at the series' own first point, aligned to the shared axis. */
  values: (number | null)[];
  /** Benchmark for this book, indexed the same way. Null where unpublished. */
  bench: (number | null)[];
  last: number | null;
};

export type Model = {
  axis: string[];
  series: Series[];
  min: number;
  max: number;
};

const META_FALLBACK = (key: string) => ({
  label: key.replace(/_/g, ' '),
  family: 'core' as Family,
  crypto: /crypto|crp/.test(key),
});

/** How a caller names and colours one series. */
export type SeriesMeta = { label: string; color: string; dashed?: boolean };
export type MetaFor = (key: string, index: number) => SeriesMeta;

// Default: the trader books, coloured by strategy family.
const traderMetaFor: MetaFor = (key) => {
  const m = CURVE_META[key] ?? META_FALLBACK(key);
  return { label: m.label, color: FAMILY_COLOR[m.family], dashed: m.crypto };
};

/**
 * Slots for callers whose series have no inherent families — the playground's
 * portfolios, for instance. Six is the whole validated budget; a caller with
 * more than six should fold or facet rather than inventing a seventh hue.
 */
export const CAT_SLOTS = [
  'var(--color-cat-1)',
  'var(--color-cat-2)',
  'var(--color-cat-3)',
  'var(--color-cat-4)',
  'var(--color-cat-5)',
  'var(--color-cat-6)',
];

/**
 * Aligns every curve onto one time axis and indexes each to 100 at its own
 * first published point, then derives the single y-domain all views share.
 */
export function buildModel(
  equityCurve: Record<string, EquityPoint[]>,
  metaFor: MetaFor = traderMetaFor,
): Model {
  const entries = Object.entries(equityCurve)
    .filter(([, pts]) => (pts?.length ?? 0) > 0)
    .sort(([a], [b]) => {
      const ia = CURVE_ORDER.indexOf(a);
      const ib = CURVE_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

  // Shared time axis = the union of every DATE any book published, so a book
  // that started late lines up under the right x rather than being stretched
  // across the full width.
  const axis = [
    ...new Set(entries.flatMap(([, pts]) => pts.map((p) => p.t).filter((t): t is string => !!t))),
  ].sort();
  const slot = new Map(axis.map((t, i) => [t, i]));

  const series: Series[] = entries.map(([key, pts], seriesIdx) => {
    const meta = metaFor(key, seriesIdx);
    const clean = pts.filter((p) => p.t && p.equity != null);
    const base = clean[0]?.equity ?? null;

    const values: (number | null)[] = axis.map(() => null);
    const bench: (number | null)[] = axis.map(() => null);

    // The page already reduces the publisher's raw feed to one point per date.
    // Last-write-wins is kept here anyway so this stays correct if it is ever
    // handed an unreduced curve: iterating in publish order leaves each slot
    // holding that day's close.
    for (const p of clean) {
      const i = slot.get(p.t as string);
      if (i == null || base == null || base === 0) continue;
      values[i] = ((p.equity as number) / base) * 100;
      // The publisher gives the benchmark as a cumulative % return, so it
      // indexes onto the same 100 base directly.
      if (typeof p.bench_pct === 'number') bench[i] = 100 + p.bench_pct;
    }

    // Books publish on different days (stocks skip weekends, crypto doesn't,
    // and sleeves start at different dates), so on the shared axis every series
    // has holes. Drawing those as breaks is wrong — the book didn't cease to
    // exist, its equity just wasn't restated — and it left the crosshair able
    // to report only whichever book happened to write on that exact date.
    // Carry the last known value forward, but ONLY between a book's own first
    // and last point. Outside that range it stays null, because "hadn't started
    // yet" is genuinely missing data and must not be drawn as a flat line.
    const firstIdx = values.findIndex((v) => v != null);
    // Annotated: without it TS widens the accumulator to `number | null` from
    // the array's element type and the index reads below stop type-checking.
    const lastIdx = values.reduce<number>((acc, v, i) => (v != null ? i : acc), -1);
    if (firstIdx !== -1) {
      let heldV = values[firstIdx] as number;
      let heldB = bench[firstIdx];
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (values[i] == null) values[i] = heldV;
        else heldV = values[i] as number;
        if (bench[i] == null) bench[i] = heldB;
        else heldB = bench[i];
      }
    }

    return {
      key,
      label: meta.label,
      color: meta.color,
      dashed: !!meta.dashed,
      values,
      bench,
      last: lastIdx === -1 ? null : (values[lastIdx] as number),
    };
  });

  const all = series
    .flatMap((s) => [...s.values, ...s.bench])
    .filter((v): v is number => v != null);
  // Always include 100 so the baseline is on-scale, and pad the domain by 8% of
  // its span so extremes aren't drawn flush against the plot edge.
  const lo = Math.min(100, ...(all.length ? all : [100]));
  const hi = Math.max(100, ...(all.length ? all : [100]));
  const pad = (hi - lo || 2) * 0.08;

  return { axis, series, min: lo - pad, max: hi + pad };
}

const fmtIdx = (v: number) => `${v - 100 >= 0 ? '+' : '−'}${Math.abs(v - 100).toFixed(1)}%`;
const toneOf = (v: number | null) =>
  v == null
    ? 'text-text-muted'
    : v > 100.05
      ? 'text-gain'
      : v < 99.95
        ? 'text-loss'
        : 'text-text-muted';

// The publisher stamps bare dates ("2026-07-23"). `new Date(str)` parses those
// as UTC midnight, so anywhere west of Greenwich they render as the PREVIOUS
// day — the axis was labelling the latest point "Jul 22". Build the date from
// its parts and format in UTC so the label matches the string it came from, and
// so the server and client agree (this island server-renders, and a locale- or
// zone-dependent format would hydrate to different text).
const dayFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const fmtDay = (t: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (!m) return t;
  return dayFmt.format(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
};

// ── Plot geometry ────────────────────────────────────────────────────────────
// A fixed viewBox scaled uniformly by CSS. preserveAspectRatio is left at its
// default ("meet"), NOT "none" — "none" stretches the coordinate system
// non-uniformly, which distorts stroke weight and makes the visual slope of a
// line a function of container width instead of the data. Strokes are pinned to
// real pixels with vector-effect so they stay hairline at any render size.
const VB = { w: 900, h: 280, l: 44, r: 12, t: 12, b: 24 };
const plotW = VB.w - VB.l - VB.r;
const plotH = VB.h - VB.t - VB.b;

function pathFor(values: (number | null)[], x: (i: number) => number, y: (v: number) => number) {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}

/** Nice-ish tick values across a domain, always including the 100 baseline. */
function ticks(min: number, max: number, count = 4): number[] {
  const span = max - min;
  if (span <= 0) return [100];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(Number(v.toFixed(4)));
  return out.includes(100) ? out : [...out, 100].sort((a, b) => a - b);
}

// ── Unified deck chart ───────────────────────────────────────────────────────

export function EquityDeck({
  equityCurve,
  metaFor,
  title = 'Equity · all books · indexed to 100 at start',
}: {
  equityCurve: Record<string, EquityPoint[]>;
  /** Override naming/colour when the series aren't the trader's books. */
  metaFor?: MetaFor;
  title?: string;
}) {
  const model = useMemo(() => buildModel(equityCurve, metaFor), [equityCurve, metaFor]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  // Was the crosshair last moved by keyboard? Only then is a live region
  // wanted — announcing on every pointermove would make a screen reader talk
  // continuously while a sighted mouse user drags across the plot.
  const [kbd, setKbd] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const titleId = useId();

  const { axis, series, min, max } = model;
  const n = axis.length;

  const x = useCallback((i: number) => VB.l + (n < 2 ? plotW / 2 : (i / (n - 1)) * plotW), [n]);
  const y = useCallback(
    (v: number) => VB.t + plotH - ((v - min) / (max - min || 1)) * plotH,
    [min, max],
  );

  // Map a pointer event to the nearest sample index. The SVG is uniformly
  // scaled, so one ratio converts client px to viewBox units on both axes.
  const onMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const box = svgRef.current?.getBoundingClientRect();
      if (!box || n < 1) return;
      const vbX = ((e.clientX - box.left) / box.width) * VB.w;
      const ratio = (vbX - VB.l) / (plotW || 1);
      setKbd(false);
      setCursor(Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1)))));
    },
    [n],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGSVGElement>) => {
      if (n < 1) return;
      setKbd(true);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setCursor((c) => {
          const next = (c ?? (e.key === 'ArrowRight' ? -1 : n)) + (e.key === 'ArrowRight' ? 1 : -1);
          return Math.max(0, Math.min(n - 1, next));
        });
      } else if (e.key === 'Home') {
        e.preventDefault();
        setCursor(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setCursor(n - 1);
      } else if (e.key === 'Escape') {
        setCursor(null);
      }
    },
    [n],
  );

  // Everything here depends on the data and the plot geometry, never on the
  // cursor. Without this it all rebuilt on every pointermove — 8 path strings,
  // a sort and the tick scan at pointer-event rate. React Compiler is not
  // enabled on this project, so the memo has to be explicit.
  const { yTicks, paths, best, worst } = useMemo(() => {
    const ranked = [...series].filter((s) => s.last != null).sort((a, b) => b.last! - a.last!);
    return {
      yTicks: ticks(min, max),
      paths: series.map((s) => ({ ...s, d: pathFor(s.values, x, y) })),
      best: ranked[0],
      worst: ranked[ranked.length - 1],
    };
  }, [series, min, max, x, y]);

  if (!series.length) {
    return (
      <div className="rounded-xl border border-border bg-bg-elevated/40 p-5">
        <p className="text-sm text-text-muted">No equity history published yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-bg-elevated/40 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={titleId} className="font-mono text-xs uppercase tracking-wider text-text-subtle">
          {title}
        </h3>
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
          className="rounded-md border border-border-strong px-2 py-1 font-mono text-[11px] text-text-muted transition-colors hover:bg-white/[0.04] hover:text-text"
        >
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {asTable ? (
        <EquityTable model={model} />
      ) : (
        <>
          <div className="relative mt-3">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${VB.w} ${VB.h}`}
              // pan-y, not none: the chart claims horizontal drags for the
              // crosshair but must never trap a vertical scroll on a phone.
              className="w-full touch-pan-y rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              role="img"
              aria-labelledby={titleId}
              tabIndex={0}
              onPointerMove={onMove}
              onPointerLeave={() => setCursor(null)}
              onKeyDown={onKeyDown}
              onBlur={() => setCursor(null)}
            >
              {/* Gridlines: solid hairlines one shade off the surface. Dashed
                  grids read as "threshold" when they're only a grid. */}
              {yTicks.map((tv) => (
                <g key={tv}>
                  <line
                    x1={VB.l}
                    x2={VB.w - VB.r}
                    y1={y(tv)}
                    y2={y(tv)}
                    stroke="var(--color-border)"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                  <text
                    x={VB.l - 8}
                    y={y(tv)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-[var(--color-text-subtle)] font-mono text-[11px] tabular-nums"
                  >
                    {tv.toFixed(0)}
                  </text>
                </g>
              ))}

              {/* The 100 baseline is the whole point of indexing: above it the
                  book made money, below it lost. Drawn stronger than the grid. */}
              <line
                x1={VB.l}
                x2={VB.w - VB.r}
                y1={y(100)}
                y2={y(100)}
                stroke="var(--color-border-strong)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />

              {cursor != null && (
                <line
                  x1={x(cursor)}
                  x2={x(cursor)}
                  y1={VB.t}
                  y2={VB.t + plotH}
                  stroke="var(--color-text-subtle)"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              )}

              {paths.map((s) => (
                <path
                  key={s.key}
                  d={s.d}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="1.75"
                  strokeDasharray={s.dashed ? '5 3' : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}

              {cursor != null &&
                series.map((s) =>
                  s.values[cursor] == null ? null : (
                    <circle
                      key={s.key}
                      cx={x(cursor)}
                      cy={y(s.values[cursor] as number)}
                      r="3.5"
                      fill={s.color}
                      stroke="var(--color-bg-elevated)"
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                    />
                  ),
                )}

              {n > 1 && (
                <>
                  <text
                    x={VB.l}
                    y={VB.h - 6}
                    className="fill-[var(--color-text-subtle)] font-mono text-[11px]"
                  >
                    {fmtDay(axis[0])}
                  </text>
                  <text
                    x={VB.w - VB.r}
                    y={VB.h - 6}
                    textAnchor="end"
                    className="fill-[var(--color-text-subtle)] font-mono text-[11px]"
                  >
                    {fmtDay(axis[n - 1])}
                  </text>
                </>
              )}
            </svg>

            {cursor != null && <Readout model={model} i={cursor} />}
          </div>

          {/* Keyboard-only announcement. The visual readout is aria-hidden, so
              this is the single spoken channel and it exists only while the
              crosshair is being driven by arrow keys. */}
          <div role="status" aria-live="polite" className="sr-only">
            {kbd && cursor != null
              ? `${fmtDay(axis[cursor])}: ` +
                series
                  .filter((s) => s.values[cursor] != null)
                  .map((s) => `${s.label} ${fmtIdx(s.values[cursor] as number)}`)
                  .join(', ')
              : ''}
          </div>

          {/* Legend is always present for ≥2 series; the leader and laggard are
              also called out by name so identity is never color-alone. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[11px]">
            {series.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5 text-text-muted">
                <svg width="14" height="8" aria-hidden="true" className="shrink-0">
                  <line
                    x1="0"
                    y1="4"
                    x2="14"
                    y2="4"
                    stroke={s.color}
                    strokeWidth="2"
                    strokeDasharray={s.dashed ? '4 2.5' : undefined}
                  />
                </svg>
                {s.label}
              </span>
            ))}
          </div>

          {best && worst && best.key !== worst.key && (
            <p className="mt-2 text-xs text-text-muted">
              Leading <b className="text-text">{best.label}</b>{' '}
              <span className={toneOf(best.last)}>{fmtIdx(best.last!)}</span> · trailing{' '}
              <b className="text-text">{worst.label}</b>{' '}
              <span className={toneOf(worst.last)}>{fmtIdx(worst.last!)}</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Cursor readout. Values are also in the table view, so this enhances only. */
function Readout({ model, i }: { model: Model; i: number }) {
  const rows = model.series
    .map((s) => ({ s, v: s.values[i] }))
    .filter((r) => r.v != null)
    .sort((a, b) => b.v! - a.v!);
  if (!rows.length) return null;
  // Flip to the left half once the cursor passes the midpoint so the panel
  // never runs off the container.
  const rightHalf = i > (model.axis.length - 1) / 2;
  return (
    <div
      // Visual only. The spoken version is a separate sr-only live region that
      // fires for keyboard navigation, so this must not be announced too.
      aria-hidden="true"
      className={
        'pointer-events-none absolute top-0 w-44 rounded-lg border border-border-strong bg-bg/95 p-2.5 shadow-lg backdrop-blur ' +
        (rightHalf ? 'left-0' : 'right-0')
      }
    >
      <div className="font-mono text-[11px] text-text-subtle">{fmtDay(model.axis[i])}</div>
      <ul className="mt-1.5 space-y-1">
        {rows.map(({ s, v }) => (
          <li key={s.key} className="flex items-center justify-between gap-2 font-mono text-[11px]">
            <span className="inline-flex items-center gap-1.5 truncate text-text-muted">
              <span
                className="inline-block h-0.5 w-2.5 shrink-0"
                style={{ background: s.color }}
                aria-hidden="true"
              />
              <span className="truncate">{s.label}</span>
            </span>
            <span className={'shrink-0 tabular-nums ' + toneOf(v!)}>{fmtIdx(v!)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The WCAG-clean twin. Every charted value is reachable here without hover. */
function EquityTable({ model }: { model: Model }) {
  // Newest first — the recent end is what gets read.
  const rows = model.axis.map((_, i) => i).reverse();
  return (
    <div className="themed-scroll mt-3 max-h-96 overflow-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Book equity indexed to 100 at each book&rsquo;s first published point.
        </caption>
        <thead className="sticky top-0 bg-bg-elevated/95 backdrop-blur">
          <tr className="text-left font-mono text-[11px] uppercase tracking-wider text-text-subtle">
            <th scope="col" className="px-3 py-2 font-medium">
              Date
            </th>
            {model.series.map((s) => (
              <th key={s.key} scope="col" className="px-3 py-2 text-right font-medium">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={model.axis[i]} className="border-t border-border/70">
              <th
                scope="row"
                className="px-3 py-1.5 text-left font-mono text-xs font-normal text-text-subtle tabular-nums"
              >
                {fmtDay(model.axis[i])}
              </th>
              {model.series.map((s) => (
                <td
                  key={s.key}
                  className={
                    'px-3 py-1.5 text-right font-mono text-xs tabular-nums ' +
                    toneOf(s.values[i] ?? null)
                  }
                >
                  {s.values[i] == null ? '—' : fmtIdx(s.values[i] as number)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Per-book small multiples ─────────────────────────────────────────────────

export function BookCurves({ equityCurve }: { equityCurve: Record<string, EquityPoint[]> }) {
  const model = useMemo(() => buildModel(equityCurve), [equityCurve]);
  if (!model.series.length) return null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {model.series.map((s) => (
        <BookCurve key={s.key} s={s} model={model} />
      ))}
    </div>
  );
}

const MINI = { w: 300, h: 96, pad: 6 };

/**
 * A bare sparkline drawn on a domain shared with its siblings. Callers that
 * already render their own heading (the playground's portfolio cards) use this
 * instead of BookCurve so the amplitude of one card is comparable with the next
 * — the whole reason a per-card chart is worth showing at all.
 */
export function MiniSeriesChart({
  series,
  model,
  height = 40,
}: {
  series: Series;
  model: Model;
  height?: number;
}) {
  const { min, max, axis } = model;
  const n = axis.length;
  const W = MINI.w;
  const H = height;
  const pad = 3;
  const x = (i: number) => pad + (n < 2 ? 0 : (i / (n - 1)) * (W - pad * 2));
  const y = (v: number) => H - pad - ((v - min) / (max - min || 1)) * (H - pad * 2);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mt-2 w-full"
      role="img"
      aria-label={
        series.last == null
          ? `${series.label}: no history yet`
          : `${series.label}: ${fmtIdx(series.last)} since start, on the same scale as the other portfolios`
      }
    >
      <line
        x1={pad}
        x2={W - pad}
        y1={y(100)}
        y2={y(100)}
        stroke="var(--color-border-strong)"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={pathFor(series.values, x, y)}
        fill="none"
        stroke={series.color}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function BookCurve({ s, model }: { s: Series; model: Model }) {
  const { min, max, axis } = model;
  const n = axis.length;
  const x = (i: number) => MINI.pad + (n < 2 ? 0 : (i / (n - 1)) * (MINI.w - MINI.pad * 2));
  const y = (v: number) =>
    MINI.h - MINI.pad - ((v - min) / (max - min || 1)) * (MINI.h - MINI.pad * 2);

  const hasBench = s.bench.filter((v) => v != null).length >= 2;
  const lastBench = [...s.bench].reverse().find((v) => v != null) ?? null;
  const gapPts = s.last != null && lastBench != null ? s.last - lastBench : null;

  return (
    <div className="rounded-xl border border-border bg-bg-elevated/40 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-text-subtle">
          <svg width="12" height="8" aria-hidden="true" className="shrink-0">
            <line
              x1="0"
              y1="4"
              x2="12"
              y2="4"
              stroke={s.color}
              strokeWidth="2"
              strokeDasharray={s.dashed ? '4 2.5' : undefined}
            />
          </svg>
          {s.label}
        </span>
        <span className={'font-mono text-xs tabular-nums ' + toneOf(s.last)}>
          {s.last == null ? '—' : fmtIdx(s.last)}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${MINI.w} ${MINI.h}`}
        className="mt-2 w-full"
        role="img"
        aria-label={
          `${s.label}: ${s.last == null ? 'no data' : fmtIdx(s.last)} since start` +
          (gapPts == null
            ? ''
            : `, ${gapPts >= 0 ? 'ahead of' : 'behind'} benchmark by ${Math.abs(gapPts).toFixed(1)} points`)
        }
      >
        <line
          x1={MINI.pad}
          x2={MINI.w - MINI.pad}
          y1={y(100)}
          y2={y(100)}
          stroke="var(--color-border-strong)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        {hasBench && (
          <path
            d={pathFor(s.bench, x, y)}
            fill="none"
            stroke="var(--color-text-subtle)"
            strokeWidth="1.25"
            strokeDasharray="3 3"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path
          d={pathFor(s.values, x, y)}
          fill="none"
          stroke={s.color}
          strokeWidth="1.75"
          strokeDasharray={s.dashed ? '5 3' : undefined}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[11px] text-text-subtle">
        <span className="inline-flex items-center gap-1">
          <svg width="12" height="6" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="12"
              y2="3"
              stroke="var(--color-text-subtle)"
              strokeWidth="1.25"
              strokeDasharray="3 3"
            />
          </svg>
          bench
        </span>
        {gapPts != null && (
          <span className={gapPts >= 0 ? 'text-gain' : 'text-loss'}>
            {gapPts >= 0 ? '+' : '−'}
            {Math.abs(gapPts).toFixed(1)} pts vs bench
          </span>
        )}
      </div>
    </div>
  );
}
