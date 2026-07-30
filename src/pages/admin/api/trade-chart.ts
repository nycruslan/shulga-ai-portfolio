import type { APIRoute } from 'astro';

export const prerender = false;

// OHLC price bars for the per-trade lifecycle chart, proxied server-side from
// Yahoo's chart API (the browser can't call it: CORS). Lives under /admin so
// the auth middleware gates it like every other admin surface.
//
// Adaptive interval — the whole point. A same-day playground trade on daily
// bars collapses to a single candle (entry, peak, exit stacked). So the
// interval is chosen by how long the trade was actually held:
//   ≤ ~2.5 days held  → 5-minute bars (intraday path, wicks, precise fills)
//   ≤ ~12 days        → hourly
//   longer            → daily (swing trades don't need the noise)
// Older trades fall back one step when Yahoo's intraday window has rolled off
// (5m ≈ 60 days back, 60m ≈ 730 days).
//
// GET /admin/api/trade-chart?symbol=SPY&from=2026-07-30T14:05&to=...&crypto=0
// → { interval: "5m", bars: [{ t: 1753886700, o, h, l, c }, ...] }  (t = unix s)

const SYMBOL_RE = /^[A-Z0-9.-]{1,12}$/;
const DAY_MS = 86_400_000;

const memo = new Map<string, { at: number; body: string }>();
const MEMO_TTL_MS = 30 * 60 * 1000;

// Yahoo intraday history windows (how far back each interval is served).
const INTRADAY_5M_MAX_AGE_D = 55;
const INTRADAY_60M_MAX_AGE_D = 720;

type Interval = '5m' | '60m' | '1d';

/** Interval + padding for a trade of `spanDays` held, `fromAgeDays` old.
 * Exported pure so the choice is unit-tested, not guessed. */
export function pickInterval(
  spanDays: number,
  fromAgeDays: number,
): { interval: Interval; padDays: number } {
  if (spanDays <= 2.5 && fromAgeDays <= INTRADAY_5M_MAX_AGE_D) {
    return { interval: '5m', padDays: 1 };
  }
  if (spanDays <= 12 && fromAgeDays <= INTRADAY_60M_MAX_AGE_D) {
    return { interval: '60m', padDays: 2 };
  }
  return { interval: '1d', padDays: 7 };
}

function parseInstant(s: string | null): number | null {
  if (!s) return null;
  // Accepts a plain date (YYYY-MM-DD) or a full ISO datetime.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export const GET: APIRoute = async ({ url }) => {
  const raw = (url.searchParams.get('symbol') ?? '').toUpperCase();
  const from = parseInstant(url.searchParams.get('from'));
  // Open trades send no `to`; chart runs to now.
  const to = parseInstant(url.searchParams.get('to')) ?? Date.now();
  const crypto = url.searchParams.get('crypto') === '1';

  if (!SYMBOL_RE.test(raw) || from == null || from > to) {
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
  }

  const spanDays = (to - from) / DAY_MS;
  const fromAgeDays = (Date.now() - from) / DAY_MS;
  const { interval, padDays } = pickInterval(spanDays, fromAgeDays);

  // Yahoo notation: BRK.B → BRK-B; crypto quotes as SYM-USD.
  const ySym = crypto ? `${raw}-USD` : raw.replace(/\./g, '-');
  const p1 = Math.floor((from - padDays * DAY_MS) / 1000);
  const p2 = Math.floor(Math.min(to + padDays * DAY_MS, Date.now() + DAY_MS) / 1000);

  const key = `${ySym}:${interval}:${p1}:${p2}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return json(hit.body);

  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}` +
        `?period1=${p1}&period2=${p2}&interval=${interval}&includePrePost=false`,
      // Yahoo 429s the default undici UA far more often than a browser one.
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; shulga-ai-dashboard)' } },
    );
    if (!r.ok) {
      return new Response(JSON.stringify({ error: `upstream ${r.status}` }), { status: 502 });
    }
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    const stamps: number[] = result?.timestamp ?? [];
    const q = result?.indicators?.quote?.[0] ?? {};
    const open: (number | null)[] = q.open ?? [];
    const high: (number | null)[] = q.high ?? [];
    const low: (number | null)[] = q.low ?? [];
    const close: (number | null)[] = q.close ?? [];

    const round = (v: number) => Math.round(v * 10000) / 10000;
    const bars: Array<{ t: number; o: number; h: number; l: number; c: number }> = [];
    stamps.forEach((s, i) => {
      const o = open[i];
      const h = high[i];
      const l = low[i];
      const c = close[i];
      // A bar needs all four to be a real OHLC candle; intraday gaps carry nulls.
      if (
        [o, h, l, c].every((v) => typeof v === 'number' && Number.isFinite(v) && (v as number) > 0)
      ) {
        bars.push({ t: s, o: round(o!), h: round(h!), l: round(l!), c: round(c!) });
      }
    });
    if (bars.length === 0) {
      return new Response(JSON.stringify({ error: 'no data' }), { status: 404 });
    }

    const body = JSON.stringify({ interval, bars });
    memo.set(key, { at: Date.now(), body });
    return json(body);
  } catch {
    return new Response(JSON.stringify({ error: 'upstream unreachable' }), { status: 502 });
  }
};

function json(body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json',
      // Private: behind auth. An open trade's last bar moves intraday, so a
      // short cache; historical bars for a closed trade are immutable but 30
      // min is a fine ceiling either way.
      'Cache-Control': 'private, max-age=1800',
    },
  });
}
