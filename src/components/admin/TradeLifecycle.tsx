import { useEffect, useRef, useState } from 'react';
import type {
  IChartApi,
  ISeriesApi,
  MouseEventParams,
  SeriesMarker,
  Time,
} from 'lightweight-charts';

// Per-trade lifecycle chart on TradingView Lightweight Charts™ — the same
// canvas engine real market UIs use. Candlesticks (OHLC), so the wicks show the
// intraday high/low where a stop actually fires; an ADAPTIVE interval, so a
// same-day trade renders its real intraday path instead of collapsing onto one
// daily bar; a STEPPED stop line, so the dynamic exit's ratchet is visible as a
// staircase, not two flat lines. BUY/SELL arrows, a flagged peak, add/partial
// markers, native crosshair, and a pointer readout complete the grammar. The
// library is imported inside the effect: this only mounts client-side on row
// expand, and the canvas engine has no business in the SSR bundle.

export type TradeEvent = {
  kind?: 'add' | 'partial';
  ts?: string; // YYYY-MM-DD
  price?: number | null;
  qty?: number | null;
  note?: string | null;
};

export type TradeFacts = {
  symbol: string;
  book?: string;
  opened_at?: string | null;
  closed_at?: string | null; // absent → open trade, chart runs to now
  entry?: number | null;
  exit?: number | null;
  init_stop?: number | null;
  stop?: number | null; // current stop (open trades; may have trailed up)
  peak_pct?: number | null;
  result_pct?: number | null; // realized (closed) or unrealized (open)
  events?: TradeEvent[] | null; // scale-in adds (＋) + partial sells (½)
};

type Bar = { t: number; o: number; h: number; l: number; c: number };
type ChartData = { interval: string; bars: Bar[] };

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** First index whose value is on/after `target`; -1 when none. Works for the
 * sorted date-strings (event placement) and sorted timestamps alike. */
export function indexOnOrAfter(
  values: (string | number)[],
  target?: string | number | null,
): number {
  if (target == null) return -1;
  for (let i = 0; i < values.length; i++) if (values[i] >= target) return i;
  return -1;
}

/** Last index whose value is on/before `target`; -1 when none. */
export function indexOnOrBefore(
  values: (string | number)[],
  target?: string | number | null,
): number {
  if (target == null) return -1;
  for (let i = values.length - 1; i >= 0; i--) if (values[i] <= target) return i;
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

/** Bar timestamp → label. Intraday shows the clock; daily shows the date. */
export function fmtBarTime(unixSec: number, intraday: boolean): string {
  const d = new Date(unixSec * 1000);
  const iso = d.toISOString();
  return intraday ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

// Site tokens on the dark surface (all ≥3:1 contrast, validator-checked).
const C = {
  up: '#4ec98a',
  down: '#f07878',
  wickUp: 'rgba(78, 201, 138, 0.6)',
  wickDown: 'rgba(240, 120, 120, 0.6)',
  buy: '#7af2a0',
  sell: '#fb7185',
  stop: '#f0a878', // warm, distinct from the red down-candles it sits among
  peak: '#e2a04a',
  entryLine: '#8a8f98',
  grid: 'rgba(255, 255, 255, 0.06)',
  text: '#8a8f98',
  surface: 'transparent',
};

export default function TradeLifecycle({ trade }: { trade: TradeFacts }) {
  const [data, setData] = useState<ChartData | null>(null);
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

  // Fetch bars. The parent keys this component per trade, so a different trade
  // mounts fresh — no manual reset needed.
  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ symbol: trade.symbol, crypto: isCrypto ? '1' : '0' });
    if (trade.opened_at) q.set('from', trade.opened_at);
    if (trade.closed_at) q.set('to', trade.closed_at);
    fetch(`/admin/api/trade-chart?${q}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
        return r.json() as Promise<ChartData>;
      })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : 'failed'));
    return () => {
      alive = false;
    };
  }, [trade.symbol, trade.opened_at, trade.closed_at, isCrypto]);

  // Build the chart once bars land.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !data || data.bars.length < 2) return;
    const bars = data.bars;
    const intraday = data.interval !== '1d';

    let chart: IChartApi | null = null;
    let series: ISeriesApi<'Candlestick'> | null = null;
    let ro: ResizeObserver | null = null;
    let disposed = false;

    (async () => {
      const {
        createChart,
        CandlestickSeries,
        LineSeries,
        createSeriesMarkers,
        LineStyle,
        LineType,
        ColorType,
        CrosshairMode,
      } = await import('lightweight-charts');
      if (disposed || !containerRef.current) return;

      const times = bars.map((b) => b.t);
      const dates = bars.map((b) => new Date(b.t * 1000).toISOString().slice(0, 10));
      const openSec = trade.opened_at ? Math.floor(Date.parse(trade.opened_at) / 1000) : null;
      const closeSec = trade.closed_at ? Math.floor(Date.parse(trade.closed_at) / 1000) : null;

      // Entry snaps to the first bar at/after the fill; exit to the last bar
      // at/before the close. On an intraday chart these land on the real 10:05
      // and same-day exit bars — the point of the whole rebuild.
      const entryIdx = Math.max(0, indexOnOrAfter(times, openSec));
      const exitIdx = closed
        ? Math.max(
            entryIdx,
            indexOnOrBefore(times, closeSec) < 0
              ? bars.length - 1
              : indexOnOrBefore(times, closeSec),
          )
        : bars.length - 1;
      // Peak = highest intraday HIGH in the window (matches high_watermark, not
      // the highest close the old line used).
      let peakIdx = entryIdx;
      for (let i = entryIdx; i <= exitIdx; i++) if (bars[i].h > bars[peakIdx].h) peakIdx = i;

      const px0 = bars[entryIdx].c;
      const precision = px0 < 5 ? 4 : 2;

      chart = createChart(el, {
        height: 300,
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: C.surface },
          textColor: C.text,
          fontSize: 11,
          attributionLogo: false,
        },
        grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
        rightPriceScale: { borderVisible: false },
        timeScale: {
          borderVisible: false,
          fixLeftEdge: true,
          fixRightEdge: true,
          timeVisible: intraday,
          secondsVisible: false,
        },
        crosshair: {
          mode: CrosshairMode.Magnet,
          vertLine: { labelBackgroundColor: '#2a2e33' },
          horzLine: { labelBackgroundColor: '#2a2e33' },
        },
        // A fixed audit window, not an explorer: no pan/zoom, no scroll-jacking
        // inside the table. The crosshair still reads every value.
        handleScroll: false,
        handleScale: false,
      });

      series = chart.addSeries(CandlestickSeries, {
        upColor: C.up,
        downColor: C.down,
        borderVisible: false,
        wickUpColor: C.wickUp,
        wickDownColor: C.wickDown,
        priceLineVisible: false,
        lastValueVisible: !closed,
        priceFormat: {
          type: 'price',
          precision,
          minMove: px0 < 5 ? 0.0001 : 0.01,
        },
      });
      series.setData(
        bars.map((b) => ({ time: b.t as Time, open: b.o, high: b.h, low: b.l, close: b.c })),
      );

      // Entry: a dotted reference at the fill price.
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

      // Stop: a STEPPED line reconstructing the trail. We know three things per
      // trade: the initial stop, the current/exit stop, and the running high
      // each bar. A trailing stop rides the running high at a fixed distance, so
      // we back out that distance from the peak (peakHigh − currentStop) and
      // draw stop[i] = clamp(runningHigh[i] − gap, init, current). The result is
      // a real rising staircase: flat at init until the trail lifts off, rising
      // with each new high, reaching the current stop exactly at the peak. This
      // survives a recent peak (a single step at the peak would collapse to the
      // right edge and look flat — the bug this replaces).
      const initStop = trade.init_stop ?? null;
      const curStop = trade.stop ?? null;
      const trailed = curStop != null && initStop != null && Math.abs(curStop - initStop) > 1e-9;
      if (initStop != null) {
        const stopSeries = chart.addSeries(LineSeries, {
          color: C.stop,
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          lineType: LineType.WithSteps,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
          priceFormat: { type: 'price', precision, minMove: px0 < 5 ? 0.0001 : 0.01 },
        });
        const round = (v: number) => Math.round(v * 10000) / 10000;
        const gap = trailed && curStop != null ? Math.max(0, bars[peakIdx].h - curStop) : 0;
        const pts: { time: Time; value: number }[] = [];
        let runHigh = bars[entryIdx].h;
        for (let i = 0; i < bars.length; i++) {
          if (i >= entryIdx && i <= exitIdx) runHigh = Math.max(runHigh, bars[i].h);
          let v = initStop;
          if (trailed && curStop != null && i >= entryIdx) {
            v = Math.min(curStop, Math.max(initStop, runHigh - gap));
          }
          pts.push({ time: times[i] as Time, value: round(v) });
        }
        stopSeries.setData(pts);
      }

      // Trade markers — BUY in, SELL out, peak flagged between them.
      const outcomeColor = result == null ? '#8a8f98' : result >= 0 ? C.buy : C.sell;
      const markers: SeriesMarker<Time>[] = [
        {
          time: times[entryIdx] as Time,
          position: 'belowBar',
          color: C.buy,
          shape: 'arrowUp',
          text: `BUY ${fmtPx(trade.entry)}`,
        },
      ];
      if (peakIdx !== entryIdx && peakIdx !== exitIdx) {
        markers.push({
          time: times[peakIdx] as Time,
          position: 'aboveBar',
          color: C.peak,
          shape: 'circle',
          size: 0, // label-only flag; the default blob is oversized
          text: trade.peak_pct != null ? `peak +${trade.peak_pct}%` : 'peak',
        });
      }
      if (closed) {
        markers.push({
          time: times[exitIdx] as Time,
          position: 'aboveBar',
          color: outcomeColor,
          shape: 'arrowDown',
          text: `SELL ${result != null ? (result >= 0 ? '+' : '') + result + '%' : ''}`,
        });
      }

      // Mid-trade events: scale-in adds (＋) and +2R partial sells (½). Each
      // snaps to the first bar on/after its date; an event outside the window is
      // skipped, never crashes.
      for (const ev of trade.events ?? []) {
        if (!ev?.ts) continue;
        const i = indexOnOrAfter(dates, ev.ts);
        if (i < 0) continue;
        if (ev.kind === 'add') {
          markers.push({
            time: times[i] as Time,
            position: 'belowBar',
            color: C.buy,
            shape: 'square',
            text: `＋ added${ev.price ? ' ' + fmtPx(ev.price) : ''}`,
          });
        } else if (ev.kind === 'partial') {
          markers.push({
            time: times[i] as Time,
            position: 'aboveBar',
            color: C.peak,
            shape: 'square',
            text: `½ sold${ev.note ? ' ' + ev.note : ''}`,
          });
        }
      }

      // Lightweight-charts requires markers in ascending time order.
      markers.sort((a, b) => Number(a.time) - Number(b.time));
      createSeriesMarkers(series, markers);

      // Pointer readout (TradingView-style legend): time · price · % vs entry.
      const readout = readoutRef.current;
      const renderReadout = (label: string | null, price: number | null) => {
        if (!readout) return;
        const px = price ?? bars[bars.length - 1].c;
        const when = label ?? fmtBarTime(times[times.length - 1], intraday);
        const vs =
          trade.entry && px
            ? ` · ${px >= trade.entry ? '+' : ''}${(((px - trade.entry) / trade.entry) * 100).toFixed(1)}% vs entry`
            : '';
        // textContent, never innerHTML: bar data is external input.
        readout.textContent = `${when} · ${fmtPx(px)}${vs}`;
      };
      renderReadout(null, null);
      chart.subscribeCrosshairMove((param: MouseEventParams) => {
        if (param.time == null || !series || !param.seriesData.has(series)) {
          renderReadout(null, null);
          return;
        }
        const d = param.seriesData.get(series) as { close?: number } | undefined;
        renderReadout(fmtBarTime(Number(param.time), intraday), d?.close ?? null);
      });

      chart.timeScale().fitContent();
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
  }, [data, trade, closed, result]);

  if (err) {
    return (
      <p className="px-4 py-6 text-xs text-text-muted">
        Chart unavailable for {trade.symbol}: {err}
      </p>
    );
  }

  const intraday = data != null && data.interval !== '1d';

  return (
    <div className="px-2 py-3 sm:px-4">
      <div className="relative overflow-hidden rounded-lg border border-border bg-bg/60">
        {/* live readout — top-left, like every trading terminal */}
        <div
          ref={readoutRef}
          aria-live="polite"
          className="pointer-events-none absolute left-3 top-2 z-10 font-mono text-[11px] tabular-nums text-text-muted"
        />
        {data && (
          <div className="pointer-events-none absolute right-3 top-2 z-10 font-mono text-[10px] uppercase tracking-wide text-text-subtle">
            {data.interval} bars
          </div>
        )}
        <div ref={containerRef} className="h-[300px] w-full" />
        {!data && (
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
        {data && (
          <details className="ml-auto">
            <summary className="cursor-pointer transition-colors hover:text-text-muted">
              data table
            </summary>
            <div className="themed-scroll mt-1 max-h-40 overflow-y-auto rounded border border-border bg-bg-elevated/60 px-2 py-1">
              <table className="text-[10px]">
                <thead>
                  <tr className="text-left">
                    <th scope="col" className="pr-4 font-medium">
                      time
                    </th>
                    <th scope="col" className="pr-3 text-right font-medium">
                      high
                    </th>
                    <th scope="col" className="pr-3 text-right font-medium">
                      low
                    </th>
                    <th scope="col" className="text-right font-medium">
                      close
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.bars.map((b) => (
                    <tr key={b.t}>
                      <td className="pr-4">{fmtBarTime(b.t, intraday)}</td>
                      <td className="pr-3 text-right">{b.h}</td>
                      <td className="pr-3 text-right">{b.l}</td>
                      <td className="text-right">{b.c}</td>
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
