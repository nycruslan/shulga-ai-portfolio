import { useEffect, useMemo, useRef, useState } from 'react';

// Per-trade lifecycle chart: the daily price path from just before entry to
// exit (or today), with the entry, initial stop, current stop, peak and exit
// marked and labeled. Answers one question at a glance: where did this trade
// get to, and how much of that did the exit keep?
//
// Single price series → no legend (the row it expands from names it). Every
// marker is direct-labeled, so identity never rides on color alone. Colors are
// the site's status tokens on the dark surface (contrast ≥3:1, checked).

export type TradeFacts = {
  symbol: string;
  book?: string;
  opened_at?: string | null;
  closed_at?: string | null; // absent → open trade, chart runs to today
  entry?: number | null;
  exit?: number | null;
  init_stop?: number | null;
  stop?: number | null; // current stop (open trades; may have trailed up)
  peak_pct?: number | null;
  result_pct?: number | null; // realized (closed) or unrealized (open)
};

type Bars = { t: string[]; c: number[] };

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Clean y-axis ticks: 3 values on a nice step covering [min, max]. */
export function niceTicks(min: number, max: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return [];
  const span = max - min;
  const step = 10 ** Math.floor(Math.log10(span / 2));
  const mult = span / 2 / step >= 5 ? 5 : span / 2 / step >= 2 ? 2 : 1;
  const s = step * mult;
  const first = Math.ceil(min / s) * s;
  const out: number[] = [];
  for (let v = first; v <= max + 1e-9 && out.length < 4; v += s) out.push(Number(v.toFixed(6)));
  return out;
}

/** SVG path through (x, y) points. */
export function linePath(xs: number[], ys: number[]): string {
  return xs.map((x, i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' ');
}

/** First bar index on/after an ISO date; -1 when none. */
export function indexOnOrAfter(dates: string[], day?: string | null): number {
  if (!day) return -1;
  for (let i = 0; i < dates.length; i++) if (dates[i] >= day) return i;
  return -1;
}

/** Last bar index on/before an ISO date; -1 when none. */
export function indexOnOrBefore(dates: string[], day?: string | null): number {
  if (!day) return -1;
  for (let i = dates.length - 1; i >= 0; i--) if (dates[i] <= day) return i;
  return -1;
}

/** Tone for "kept % of peak". Red flags: a sizable gain mostly given back
 * (peak ≥8%, kept <30%), or ANY real peak that round-tripped to a loss
 * (kept <0). Small partial give-backs are the normal trailing cost — muted. */
export function captureTone(peakPct?: number | null, keptPct?: number | null): string {
  if (peakPct == null || keptPct == null) return 'text-text-subtle';
  if ((peakPct >= 8 && keptPct < 30) || keptPct < 0) return 'text-rose-300';
  if (keptPct >= 60) return 'text-emerald-300';
  return 'text-text-muted';
}

// ── Chart ────────────────────────────────────────────────────────────────────

const LINE = '#7dd3fc'; // price series (identity)
const STOP = '#f07878'; // danger token — stop levels
const PEAK = '#e2a04a'; // warning token — peak flag
const WIN = '#7af2a0';
const LOSS = '#fb7185';
const GRID = 'rgba(255,255,255,0.07)';
const INK_SUBTLE = '#787f86';

const W = 640;
const H = 240;
const M = { top: 18, right: 74, bottom: 26, left: 10 };

export default function TradeLifecycle({ trade }: { trade: TradeFacts }) {
  const [bars, setBars] = useState<Bars | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const isCrypto = (trade.book ?? '').toLowerCase().includes('crypto');

  useEffect(() => {
    let alive = true;
    setBars(null);
    setErr(null);
    const q = new URLSearchParams({ symbol: trade.symbol, crypto: isCrypto ? '1' : '0' });
    if (trade.opened_at) q.set('from', trade.opened_at);
    if (trade.closed_at) q.set('to', trade.closed_at);
    fetch(`/admin/api/trade-chart?${q}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
        return r.json() as Promise<Bars>;
      })
      .then((d) => alive && setBars(d))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : 'failed'));
    return () => {
      alive = false;
    };
  }, [trade.symbol, trade.opened_at, trade.closed_at, isCrypto]);

  const model = useMemo(() => {
    if (!bars || bars.c.length < 2) return null;
    const { t, c } = bars;
    const entryIdx = Math.max(0, indexOnOrAfter(t, trade.opened_at));
    const exitIdx = trade.closed_at
      ? Math.max(entryIdx, indexOnOrBefore(t, trade.closed_at))
      : t.length - 1;

    const levels = [trade.entry, trade.exit, trade.init_stop, trade.stop].filter(
      (v): v is number => typeof v === 'number' && v > 0,
    );
    const lo = Math.min(...c, ...levels);
    const hi = Math.max(...c, ...levels);
    const pad = (hi - lo || 1) * 0.06;
    const min = lo - pad;
    const max = hi + pad;

    const x = (i: number) => M.left + (i / (t.length - 1)) * (W - M.left - M.right);
    const y = (v: number) => M.top + (1 - (v - min) / (max - min)) * (H - M.top - M.bottom);

    const xs = c.map((_, i) => x(i));
    const ys = c.map((v) => y(v));

    let peakIdx = entryIdx;
    for (let i = entryIdx; i <= exitIdx; i++) if (c[i] > c[peakIdx]) peakIdx = i;

    return { t, c, entryIdx, exitIdx, peakIdx, min, max, x, y, xs, ys };
  }, [bars, trade]);

  if (err) {
    return (
      <p className="px-4 py-6 text-xs text-text-muted">
        Chart unavailable for {trade.symbol}: {err}
      </p>
    );
  }
  if (!model) {
    return (
      <p className="animate-pulse px-4 py-6 text-xs text-text-subtle" aria-live="polite">
        Loading {trade.symbol} price history…
      </p>
    );
  }

  const { t, c, entryIdx, exitIdx, peakIdx, x, y, xs, ys } = model;
  const closed = Boolean(trade.closed_at);
  const result = trade.result_pct;
  const outcomeColor = result == null ? '#8a8f98' : result >= 0 ? WIN : LOSS;
  const ticks = niceTicks(model.min, model.max);
  const kept =
    trade.peak_pct != null && trade.peak_pct >= 5 && result != null
      ? Math.round((result / trade.peak_pct) * 100)
      : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - M.left) / (W - M.left - M.right)) * (t.length - 1));
    setHover(Math.max(0, Math.min(t.length - 1, i)));
  };

  const stopY = trade.init_stop ? y(trade.init_stop) : null;
  const curStopY = !closed && trade.stop && trade.stop !== trade.init_stop ? y(trade.stop) : null;
  const label = (v?: number | null) =>
    v == null ? '' : '$' + v.toLocaleString(undefined, { maximumFractionDigits: v < 5 ? 4 : 2 });

  return (
    <div className="px-2 py-3 sm:px-4">
      <div
        className="relative rounded-lg border border-border bg-bg/60 p-2"
        onPointerLeave={() => setHover(null)}
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full touch-none select-none"
          role="img"
          aria-label={
            `${trade.symbol} lifecycle: entry ${label(trade.entry)} on ${trade.opened_at ?? '?'}` +
            (trade.peak_pct != null ? `, peaked +${trade.peak_pct}%` : '') +
            (closed
              ? `, exited ${label(trade.exit)} on ${trade.closed_at} (${result != null ? (result >= 0 ? '+' : '') + result + '%' : '—'})`
              : `, still open (${result != null ? (result >= 0 ? '+' : '') + result + '%' : '—'})`) +
            (kept != null ? `, kept ${kept}% of its peak gain` : '')
          }
          onPointerMove={onMove}
        >
          {/* holding-period wash: entry → exit */}
          <rect
            x={x(entryIdx)}
            y={M.top}
            width={Math.max(0, x(exitIdx) - x(entryIdx))}
            height={H - M.top - M.bottom}
            fill="rgba(255,255,255,0.025)"
          />

          {/* gridlines + y ticks */}
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={M.left}
                x2={W - M.right}
                y1={y(v)}
                y2={y(v)}
                stroke={GRID}
                strokeWidth="1"
              />
              <text
                x={W - M.right + 6}
                y={y(v) + 3}
                fontSize="10"
                fontFamily="ui-monospace, monospace"
                fill={INK_SUBTLE}
              >
                {v >= 100 ? Math.round(v).toLocaleString() : v}
              </text>
            </g>
          ))}

          {/* initial stop */}
          {stopY != null && (
            <g>
              <line
                x1={x(entryIdx)}
                x2={W - M.right}
                y1={stopY}
                y2={stopY}
                stroke={STOP}
                strokeWidth="1"
                strokeOpacity="0.75"
                strokeDasharray={curStopY != null ? '3 3' : undefined}
              />
              <text
                x={W - M.right + 6}
                y={stopY + 3}
                fontSize="9"
                fontFamily="ui-monospace, monospace"
                fill={STOP}
              >
                stop{curStopY != null ? '@in' : ''}
              </text>
            </g>
          )}
          {/* current (trailed) stop, open trades only */}
          {curStopY != null && (
            <g>
              <line
                x1={x(entryIdx)}
                x2={W - M.right}
                y1={curStopY}
                y2={curStopY}
                stroke={STOP}
                strokeWidth="1"
              />
              <text
                x={W - M.right + 6}
                y={curStopY + 3}
                fontSize="9"
                fontFamily="ui-monospace, monospace"
                fill={STOP}
              >
                stop now
              </text>
            </g>
          )}

          {/* area wash + price line */}
          <path
            d={
              linePath(xs, ys) +
              ` L ${xs[xs.length - 1].toFixed(1)} ${H - M.bottom} L ${xs[0].toFixed(1)} ${H - M.bottom} Z`
            }
            fill={LINE}
            fillOpacity="0.08"
            stroke="none"
          />
          <path
            d={linePath(xs, ys)}
            fill="none"
            stroke={LINE}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* crosshair */}
          {hover != null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={M.top}
              y2={H - M.bottom}
              stroke="rgba(255,255,255,0.25)"
              strokeWidth="1"
            />
          )}

          {/* peak flag (only when it isn't the entry/exit bar) */}
          {peakIdx !== entryIdx && peakIdx !== exitIdx && (
            <g>
              <circle
                cx={x(peakIdx)}
                cy={y(c[peakIdx])}
                r="4"
                fill={PEAK}
                stroke="#0e1011"
                strokeWidth="2"
              />
              <text
                x={x(peakIdx)}
                y={y(c[peakIdx]) - 8}
                fontSize="9"
                textAnchor="middle"
                fontFamily="ui-monospace, monospace"
                fill={PEAK}
              >
                peak{trade.peak_pct != null ? ` +${trade.peak_pct}%` : ''}
              </text>
            </g>
          )}

          {/* entry marker */}
          <g>
            <circle
              cx={x(entryIdx)}
              cy={trade.entry ? y(trade.entry) : ys[entryIdx]}
              r="4.5"
              fill="#e6e7e8"
              stroke="#0e1011"
              strokeWidth="2"
            />
            <text
              x={x(entryIdx)}
              y={H - M.bottom + 14}
              fontSize="9"
              textAnchor="middle"
              fontFamily="ui-monospace, monospace"
              fill={INK_SUBTLE}
            >
              in {label(trade.entry)}
            </text>
          </g>

          {/* exit / now marker */}
          <g>
            <circle
              cx={x(exitIdx)}
              cy={closed && trade.exit ? y(trade.exit) : ys[exitIdx]}
              r="4.5"
              fill={outcomeColor}
              stroke="#0e1011"
              strokeWidth="2"
            />
            <text
              x={Math.min(x(exitIdx), W - M.right - 4)}
              y={H - M.bottom + 14}
              fontSize="9"
              textAnchor="middle"
              fontFamily="ui-monospace, monospace"
              fill={INK_SUBTLE}
            >
              {closed ? 'out' : 'now'}{' '}
              {result != null ? (result >= 0 ? '+' : '') + result + '%' : ''}
            </text>
          </g>
        </svg>

        {/* tooltip — values lead, label follows */}
        {hover != null && (
          <div
            className="pointer-events-none absolute top-2 rounded-md border border-border bg-bg-elevated/95 px-2.5 py-1.5 font-mono text-[11px] tabular-nums shadow-lg"
            style={{
              left: `${Math.min(92, Math.max(2, (x(hover) / W) * 100))}%`,
              transform: x(hover) > W * 0.7 ? 'translateX(-100%)' : undefined,
            }}
          >
            <div className="text-text">{label(c[hover])}</div>
            <div className="text-text-subtle">
              {t[hover]}
              {trade.entry ? (
                <span className={c[hover] >= trade.entry ? ' text-emerald-300' : ' text-rose-300'}>
                  {' '}
                  {((c[hover] / trade.entry - 1) * 100 >= 0 ? '+' : '') +
                    ((c[hover] / trade.entry - 1) * 100).toFixed(1)}
                  % vs entry
                </span>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {/* facts strip + no-hover access to the numbers */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-text-subtle">
        <span>
          {trade.opened_at ?? '?'} → {trade.closed_at ?? 'open'}
        </span>
        {trade.peak_pct != null && <span style={{ color: PEAK }}>peak +{trade.peak_pct}%</span>}
        {kept != null && (
          <span className={captureTone(trade.peak_pct, kept)}>kept {kept}% of peak</span>
        )}
        <details className="ml-auto">
          <summary className="cursor-pointer transition-colors hover:text-text-muted">
            data table
          </summary>
          <div className="mt-1 max-h-40 overflow-y-auto rounded border border-border bg-bg-elevated/60 px-2 py-1 themed-scroll">
            <table className="text-[10px]">
              <thead>
                <tr className="text-left">
                  <th scope="col" className="pr-4 font-medium">
                    date
                  </th>
                  <th scope="col" className="text-right font-medium">
                    close
                  </th>
                </tr>
              </thead>
              <tbody>
                {t.map((d, i) => (
                  <tr key={d}>
                    <td className="pr-4">{d}</td>
                    <td className="text-right">{c[i]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </div>
  );
}
