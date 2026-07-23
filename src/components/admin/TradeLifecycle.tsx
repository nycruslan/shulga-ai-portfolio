import { useEffect, useRef, useState } from 'react';
import type {
  IChartApi,
  ISeriesApi,
  MouseEventParams,
  SeriesMarker,
  Time,
} from 'lightweight-charts';

// Per-trade lifecycle chart on TradingView Lightweight Charts™ — the same
// canvas engine real market UIs use, so the grammar is instantly readable:
// BUY/SELL arrow markers on the price path, dashed/solid price lines for the
// stops, a flagged peak, native crosshair with axis labels, and a live
// readout that tracks the pointer. The library is dynamically imported inside
// the effect: this component only mounts client-side on row expand, and the
// canvas engine has no business in the SSR bundle.

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

/** Compact price formatting: sub-$5 names (alt coins) keep 4 decimals. */
export function fmtPx(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return '$' + v.toLocaleString(undefined, { maximumFractionDigits: v < 5 ? 4 : 2 });
}

// Site tokens on the dark surface (all ≥3:1 contrast, validator-checked).
const C = {
  line: '#7dd3fc',
  fillTop: 'rgba(125, 211, 252, 0.22)',
  fillBottom: 'rgba(125, 211, 252, 0.0)',
  buy: '#7af2a0',
  sell: '#fb7185',
  stop: '#f07878',
  peak: '#e2a04a',
  entryLine: '#8a8f98',
  grid: 'rgba(255, 255, 255, 0.06)',
  text: '#8a8f98',
  surface: 'transparent',
};

export default function TradeLifecycle({ trade }: { trade: TradeFacts }) {
  const [bars, setBars] = useState<Bars | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);

  const isCrypto = (trade.book ?? '').toLowerCase().includes('crypto');
  const closed = Boolean(trade.closed_at);
  const result = trade.result_pct;
  const kept =
    trade.peak_pct != null && trade.peak_pct >= 5 && result != null
      ? Math.round((result / trade.peak_pct) * 100)
      : null;

  // Fetch daily bars. No sync state reset needed: the parent keys this
  // component per trade, so a different trade mounts fresh.
  useEffect(() => {
    let alive = true;
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

  // Build the chart once bars land.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !bars || bars.c.length < 2) return;

    let chart: IChartApi | null = null;
    let series: ISeriesApi<'Area'> | null = null;
    let ro: ResizeObserver | null = null;
    let disposed = false;

    (async () => {
      const { createChart, AreaSeries, createSeriesMarkers, LineStyle, ColorType, CrosshairMode } =
        await import('lightweight-charts');
      if (disposed || !containerRef.current) return;

      const { t, c } = bars;
      const entryIdx = Math.max(0, indexOnOrAfter(t, trade.opened_at));
      const exitIdx = closed
        ? Math.max(entryIdx, indexOnOrBefore(t, trade.closed_at))
        : t.length - 1;
      let peakIdx = entryIdx;
      for (let i = entryIdx; i <= exitIdx; i++) if (c[i] > c[peakIdx]) peakIdx = i;

      chart = createChart(el, {
        height: 280,
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: C.surface },
          textColor: C.text,
          fontSize: 11,
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: C.grid },
          horzLines: { color: C.grid },
        },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
        crosshair: {
          mode: CrosshairMode.Magnet,
          vertLine: { labelBackgroundColor: '#2a2e33' },
          horzLine: { labelBackgroundColor: '#2a2e33' },
        },
        // A fixed audit window, not an explorer: no pan/zoom, no accidental
        // scroll-jacking inside the table. The crosshair still reads values.
        handleScroll: false,
        handleScale: false,
      });

      series = chart.addSeries(AreaSeries, {
        lineColor: C.line,
        lineWidth: 2,
        topColor: C.fillTop,
        bottomColor: C.fillBottom,
        priceLineVisible: false,
        lastValueVisible: !closed,
        crosshairMarkerRadius: 5,
        priceFormat: {
          type: 'price',
          precision: c[entryIdx] < 5 ? 4 : 2,
          minMove: c[entryIdx] < 5 ? 0.0001 : 0.01,
        },
      });
      series.setData(t.map((time, i) => ({ time: time as Time, value: c[i] })));

      // Reference lines — the levels that governed this trade.
      if (trade.entry) {
        series.createPriceLine({
          price: trade.entry,
          color: C.entryLine,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'entry',
        });
      }
      if (trade.init_stop) {
        const trailed = !closed && trade.stop != null && trade.stop !== trade.init_stop;
        series.createPriceLine({
          price: trade.init_stop,
          color: C.stop,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: !trailed, // the live stop owns the axis label if both exist
          title: trailed ? 'stop @ entry' : 'stop',
        });
        if (trailed && trade.stop) {
          series.createPriceLine({
            price: trade.stop,
            color: C.stop,
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: 'stop now',
          });
        }
      }

      // Trade markers — BUY in, SELL out, peak flagged between them.
      const outcomeColor = result == null ? '#8a8f98' : result >= 0 ? C.buy : C.sell;
      const markers: SeriesMarker<Time>[] = [
        {
          time: t[entryIdx] as Time,
          position: 'belowBar',
          color: C.buy,
          shape: 'arrowUp',
          text: `BUY ${fmtPx(trade.entry)}`,
        },
      ];
      if (peakIdx !== entryIdx && peakIdx !== exitIdx) {
        markers.push({
          time: t[peakIdx] as Time,
          position: 'aboveBar',
          color: C.peak,
          shape: 'circle',
          // size 0 renders the label without the circle blob — a clean flag
          // (verified in the local harness; the default circle is oversized).
          size: 0,
          text: trade.peak_pct != null ? `peak +${trade.peak_pct}%` : 'peak',
        });
      }
      if (closed) {
        markers.push({
          time: t[exitIdx] as Time,
          position: 'aboveBar',
          color: outcomeColor,
          shape: 'arrowDown',
          text: `SELL ${result != null ? (result >= 0 ? '+' : '') + result + '%' : ''}`,
        });
      }
      createSeriesMarkers(series, markers);

      // Pointer readout (TradingView-style legend): date · price · % vs entry.
      const readout = readoutRef.current;
      const renderReadout = (time: string | null, price: number | null) => {
        if (!readout) return;
        const px = price ?? c[c.length - 1];
        const when = time ?? t[t.length - 1];
        const vs =
          trade.entry && px
            ? ` · ${px >= trade.entry ? '+' : ''}${(((px - trade.entry) / trade.entry) * 100).toFixed(1)}% vs entry`
            : '';
        // textContent, never innerHTML: bar data is external input.
        readout.textContent = `${when} · ${fmtPx(px)}${vs}`;
      };
      renderReadout(null, null);
      chart.subscribeCrosshairMove((param: MouseEventParams) => {
        if (!param.time || !series || !param.seriesData.has(series)) {
          renderReadout(null, null);
          return;
        }
        const d = param.seriesData.get(series) as { value?: number } | undefined;
        renderReadout(String(param.time), d?.value ?? null);
      });

      chart.timeScale().fitContent();

      // autoSize handles container resizes, but only while the element is
      // attached; the observer refits content so the window never clips.
      ro = new ResizeObserver(() => chart?.timeScale().fitContent());
      ro.observe(el);
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      chart?.remove();
      chart = null;
      series = null;
    };
  }, [bars, trade, closed, result]);

  if (err) {
    return (
      <p className="px-4 py-6 text-xs text-text-muted">
        Chart unavailable for {trade.symbol}: {err}
      </p>
    );
  }

  return (
    <div className="px-2 py-3 sm:px-4">
      <div className="relative overflow-hidden rounded-lg border border-border bg-bg/60">
        {/* live readout — top-left, like every trading terminal */}
        <div
          ref={readoutRef}
          aria-live="polite"
          className="pointer-events-none absolute left-3 top-2 z-10 font-mono text-[11px] tabular-nums text-text-muted"
        />
        <div ref={containerRef} className="h-[280px] w-full" />
        {!bars && (
          <p
            className="absolute inset-0 flex animate-pulse items-center justify-center text-xs text-text-subtle"
            aria-live="polite"
          >
            Loading {trade.symbol} price history…
          </p>
        )}
      </div>

      {/* facts strip + no-hover access to the numbers */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-text-subtle">
        <span>
          {trade.opened_at ?? '?'} → {trade.closed_at ?? 'open'}
        </span>
        {trade.init_stop != null && (
          <span style={{ color: C.stop }}>stop {fmtPx(trade.init_stop)}</span>
        )}
        {trade.peak_pct != null && <span style={{ color: C.peak }}>peak +{trade.peak_pct}%</span>}
        {kept != null && (
          <span className={captureTone(trade.peak_pct, kept)}>kept {kept}% of peak</span>
        )}
        {bars && (
          <details className="ml-auto">
            <summary className="cursor-pointer transition-colors hover:text-text-muted">
              data table
            </summary>
            <div className="themed-scroll mt-1 max-h-40 overflow-y-auto rounded border border-border bg-bg-elevated/60 px-2 py-1">
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
                  {bars.t.map((d, i) => (
                    <tr key={d}>
                      <td className="pr-4">{d}</td>
                      <td className="text-right">{bars.c[i]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
