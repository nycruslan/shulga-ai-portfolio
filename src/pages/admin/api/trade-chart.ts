import type { APIRoute } from 'astro';

export const prerender = false;

// Daily price bars for the per-trade lifecycle chart, proxied server-side from
// Yahoo's chart API (the browser can't call it directly: CORS). Lives under
// /admin so the auth middleware gates it like every other admin surface.
//
// GET /admin/api/trade-chart?symbol=SPY&from=2026-06-01&to=2026-07-10&crypto=0
// → { t: ["2026-05-27", ...], c: [592.1, ...] }   (padded ±7d around the trade)

const SYMBOL_RE = /^[A-Z0-9.\-]{1,12}$/;
const DAY_MS = 86_400_000;
const PAD_DAYS = 7;

// Per-instance memo. Serverless instances recycle, so this is a best-effort
// warm cache; the Cache-Control header does the real work at the edge/browser.
const memo = new Map<string, { at: number; body: string }>();
const MEMO_TTL_MS = 30 * 60 * 1000;

function parseDay(s: string | null): number | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) ? t : null;
}

export const GET: APIRoute = async ({ url }) => {
  const raw = (url.searchParams.get('symbol') ?? '').toUpperCase();
  const from = parseDay(url.searchParams.get('from'));
  // Open trades send no `to`; chart runs to today.
  const to = parseDay(url.searchParams.get('to')) ?? Date.now();
  const crypto = url.searchParams.get('crypto') === '1';

  if (!SYMBOL_RE.test(raw) || from == null || from > to) {
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
  }

  // Yahoo notation: BRK.B → BRK-B; crypto quotes as SYM-USD.
  const ySym = crypto ? `${raw}-USD` : raw.replace(/\./g, '-');
  const p1 = Math.floor((from - PAD_DAYS * DAY_MS) / 1000);
  const p2 = Math.floor(Math.min(to + PAD_DAYS * DAY_MS, Date.now() + DAY_MS) / 1000);

  const key = `${ySym}:${p1}:${p2}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) {
    return json(hit.body);
  }

  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}` +
        `?period1=${p1}&period2=${p2}&interval=1d&includePrePost=false`,
      // Yahoo 429s the default undici UA far more often than a browser one.
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; shulga-ai-dashboard)' } },
    );
    if (!r.ok) {
      return new Response(JSON.stringify({ error: `upstream ${r.status}` }), { status: 502 });
    }
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    const stamps: number[] = result?.timestamp ?? [];
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];

    const t: string[] = [];
    const c: number[] = [];
    stamps.forEach((s, i) => {
      const v = closes[i];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        t.push(new Date(s * 1000).toISOString().slice(0, 10));
        c.push(Math.round(v * 10000) / 10000);
      }
    });
    if (t.length === 0) {
      return new Response(JSON.stringify({ error: 'no data' }), { status: 404 });
    }

    const body = JSON.stringify({ t, c });
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
      // Private: this sits behind auth. Daily bars only change once a day, but
      // an open trade's last bar moves intraday — 30 min is a fair middle.
      'Cache-Control': 'private, max-age=1800',
    },
  });
}
