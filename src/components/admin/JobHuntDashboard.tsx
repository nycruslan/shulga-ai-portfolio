import { useCallback, useEffect, useRef, useState } from 'react';
import AdminTables from './AdminTables.tsx';
import { relativeTime } from '../../lib/relative-time';

// Client-safe mirror of the Snapshot in lib/turso.ts (which imports server-only
// env, so this island can't import it). Same shape, kept in sync by hand.
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
export type Snapshot = {
  generated_at: string;
  pipeline: Record<string, number>;
  funnel: { applied_total: number; responded: number; response_rate: number; offers: number };
  today: Job[];
  matches: Job[];
  matches_total: number;
  applications: Application[];
  followups: Array<{ company: string; title: string; applied_days_ago: number }>;
};

const POLL_MS = 45_000;

const STATUS_ORDER = [
  'new',
  'reviewed',
  'drafted',
  'applied',
  'screen',
  'onsite',
  'offer',
  'rejected',
  'withdrawn',
] as const;

// The post-application funnel, in order, with the same hues as the status badges.
const FUNNEL_STAGES: ReadonlyArray<readonly [string, string]> = [
  ['applied', 'bg-sky-400'],
  ['screen', 'bg-amber-400'],
  ['onsite', 'bg-violet-400'],
  ['offer', 'bg-emerald-400'],
  ['rejected', 'bg-rose-400'],
];

function Kpis({ funnel }: { funnel: Snapshot['funnel'] }) {
  const cards: ReadonlyArray<readonly [string, string | number, string]> = [
    ['Applied', funnel.applied_total, ''],
    ['Responses', funnel.responded, ''],
    ['Response rate', `${funnel.response_rate}%`, ''],
    ['Offers', funnel.offers, funnel.offers ? 'text-emerald-300' : ''],
  ];
  return (
    <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map(([label, value, tone]) => (
        <div key={label} className="border-border bg-bg-elevated/40 rounded-xl border p-4">
          <div className={'text-2xl font-medium tabular-nums ' + tone}>{value}</div>
          <div className="text-text-subtle mt-1 font-mono text-[11px] tracking-wider uppercase">
            {label}
          </div>
        </div>
      ))}
    </section>
  );
}

function FunnelBar({ pipeline }: { pipeline: Record<string, number> }) {
  const segs = FUNNEL_STAGES.map(
    ([key, color]) => [key, pipeline[key] ?? 0, color] as const,
  ).filter(([, n]) => n > 0);
  const total = segs.reduce((sum, [, n]) => sum + n, 0);
  if (total === 0) return null;
  return (
    <section className="mt-4">
      <div
        className="border-border bg-bg-elevated/40 flex h-2 overflow-hidden rounded-full border"
        role="img"
        aria-label={'Application funnel: ' + segs.map(([k, n]) => `${n} ${k}`).join(', ')}
      >
        {segs.map(([key, n, color]) => (
          <div key={key} className={color} style={{ width: `${(n / total) * 100}%` }} />
        ))}
      </div>
      <div className="text-text-subtle mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
        {segs.map(([key, n, color]) => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <span className={'inline-block h-2 w-2 rounded-sm ' + color} aria-hidden="true" />
            <b className="text-text-muted tabular-nums">{n}</b> {key}
          </span>
        ))}
      </div>
    </section>
  );
}

export default function JobHuntDashboard({ initial }: { initial: Snapshot }) {
  const [snap, setSnap] = useState<Snapshot>(initial);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const genRef = useRef(initial.generated_at);

  // One ticking clock so "updated 12s ago" stays live without re-fetching.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const poll = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/admin/jobhunt-snapshot.json', {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return;
      const next = (await res.json()) as Snapshot | null;
      if (next && next.generated_at !== genRef.current) {
        genRef.current = next.generated_at;
        setSnap(next);
      }
    } catch {
      /* transient network failure; the next poll retries */
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Poll on an interval, pausing while the tab is hidden to save work, and
  // re-checking immediately when it becomes visible again.
  useEffect(() => {
    let id: number | undefined;
    const start = () => {
      if (id === undefined) id = window.setInterval(poll, POLL_MS);
    };
    const stop = () => {
      if (id !== undefined) {
        window.clearInterval(id);
        id = undefined;
      }
    };
    const onVisibility = () => (document.hidden ? stop() : (void poll(), start()));
    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll]);

  const pipeline = STATUS_ORDER.filter((s) => snap.pipeline[s]).map(
    (s) => [s, snap.pipeline[s]] as const,
  );

  return (
    <>
      {/* Live freshness bar */}
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="text-text-subtle flex items-center gap-2 text-xs">
          <span
            className="live-dot bg-accent inline-block h-1.5 w-1.5 rounded-full"
            aria-hidden="true"
          />
          <span>
            Live <span className="text-text-muted">·</span> updated{' '}
            {relativeTime(snap.generated_at, nowMs)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void poll()}
          disabled={refreshing}
          className="border-border-strong text-text-muted hover:text-text rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-white/[0.04] disabled:opacity-50"
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <Kpis funnel={snap.funnel} />
      <FunnelBar pipeline={snap.pipeline} />

      {/* Pipeline chips — every status with a count */}
      <section className="mt-4 flex flex-wrap gap-2">
        {pipeline.map(([s, n]) => (
          <span
            key={s}
            className="border-border bg-bg-elevated/40 text-text-muted inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs"
          >
            <b className="text-text tabular-nums">{n}</b> {s}
          </span>
        ))}
      </section>

      <AdminTables
        today={snap.today}
        matches={snap.matches ?? []}
        matchesTotal={snap.matches_total ?? 0}
        applications={snap.applications}
      />

      {snap.followups.length > 0 && (
        <>
          <h2 className="text-text-subtle mt-9 mb-2.5 font-mono text-[11px] tracking-wider uppercase">
            Follow-ups due · {snap.followups.length}
          </h2>
          <ul className="space-y-1.5 text-sm">
            {snap.followups.map((f, i) => (
              <li
                key={f.company + f.title + i}
                className="border-border bg-bg-elevated/40 flex items-baseline justify-between gap-3 rounded-lg border px-4 py-2.5"
              >
                <span>
                  {f.company} <span className="text-text-muted">· {f.title}</span>
                </span>
                <span className="text-text-subtle shrink-0 font-mono text-xs">
                  {f.applied_days_ago}d ago
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
