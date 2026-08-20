import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { BridgeFeedPayload } from '../../lib/bridge/feed';
import { LIVE_WINDOW_MS } from '../../lib/bridge/feed';
import type { BridgeEvent } from '../../lib/bridge/persistence/events';
import EnvoyComms from './EnvoyComms';
import curated from '../../data/curated.json';

// The maintenance crew's public dashboard. Receipts first: what shipped, what
// the crew spent, whether CI is green. The work log shows real actions only
// (pushes, ship notes, audits, missions, CI changes); ambient heartbeat
// chatter is still recorded but lives in the full log, where it belongs.
// Honesty rules hold: LIVE vs OFF DUTY is computed from timestamps, never
// asserted, and every number on screen arrives from the database.

const POLL_MS = 4000;

/** Kinds that represent real crew work. Everything else is ambient. */
const WORK_KINDS = new Set(['github', 'ship', 'audit', 'ci', 'mission', 'brief']);

const KIND_LABEL: Record<string, string> = {
  github: 'push',
  ship: 'ship note',
  audit: 'audit',
  ci: 'ci',
  mission: 'mission',
  brief: 'briefing',
};

const ACTOR_LABEL: Record<string, string> = {
  engine: 'Engine',
  narrator: 'Narrator',
};

function relTime(iso: string, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function utcClock(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(11, 19) + 'Z';
}

const PIPELINE_STEPS: Array<{ title: string; body: string }> = [
  {
    title: 'Heartbeat',
    body: 'A GitHub Actions cron wakes the crew every 3 hours. A visitor arriving wakes it too, behind a 90-second cadence gate.',
  },
  {
    title: 'Lock',
    body: 'Each run takes a lease lock in Turso with owner-checked writes, so overlapping runs cannot clobber the world state.',
  },
  {
    title: 'Sense',
    body: 'Scout sweeps my real GitHub feed and checks CI on watched branches. A network failure becomes an honest status line, never a fake event.',
  },
  {
    title: 'Audit',
    body: "Critic lints the site's copy daily against my own writing rules. Findings become missions for Curator to fix.",
  },
  {
    title: 'Approve',
    body: "Curator's draft passes Critic's review, then waits for my explicit approval from my phone. Nothing ships unsupervised.",
  },
  {
    title: 'Ship',
    body: 'Approved changes land as real commits through the same pipeline as my own pushes, with a drift check before apply.',
  },
];

type Props = { initial: BridgeFeedPayload };

export default function BridgeView({ initial }: Props) {
  const [feed, setFeed] = useState<BridgeFeedPayload>(initial);
  const [events, setEvents] = useState<BridgeEvent[]>(initial.events);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [showFullLog, setShowFullLog] = useState(false);
  // Replay: when set, the logs show history up to this event id, honestly badged.
  const [replayCutoff, setReplayCutoff] = useState<number | null>(null);
  // "Since your last visit" recap, computed once from real work events (lazy
  // initializer: the island is client-only, so localStorage is available).
  const [recap, setRecap] = useState<{ since: string; actions: number } | null>(() => {
    try {
      const lastSeen = localStorage.getItem('bridge-last-seen');
      if (!lastSeen || Date.now() - Date.parse(lastSeen) < 3600_000) return null;
      const actions = initial.events.filter(
        (e) => e.createdAt > lastSeen && WORK_KINDS.has(e.kind),
      ).length;
      return actions > 0 ? { since: lastSeen, actions } : null;
    } catch {
      return null;
    }
  });
  const cursorRef = useRef(initial.cursor);

  // One clock for the whole screen; cheap and keeps timestamps coherent.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Wake the crew: a visitor arriving IS the tick trigger. Then start polling.
  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/bridge/feed.json?after=${cursorRef.current}`);
      if (!res.ok) return;
      const next = (await res.json()) as BridgeFeedPayload;
      if (!next.configured) return;
      setFeed(next);
      if (next.events.length) {
        cursorRef.current = next.cursor;
        setEvents((prev) => {
          const known = new Set(prev.map((e) => e.id));
          const fresh = next.events.filter((e) => !known.has(e.id));
          return fresh.length ? [...prev, ...fresh].slice(-200) : prev;
        });
      }
    } catch {
      /* transient network failure; next poll retries */
    }
  }, []);

  useEffect(() => {
    let pollId: number | undefined;
    const start = () => {
      if (pollId === undefined) pollId = window.setInterval(poll, POLL_MS);
    };
    const stop = () => {
      if (pollId !== undefined) {
        window.clearInterval(pollId);
        pollId = undefined;
      }
    };
    fetch('/api/bridge/tick', { method: 'POST' })
      .catch(() => {
        /* cadence-gated or rate-limited; the feed is still readable */
      })
      .finally(() => {
        void poll();
        start();
      });
    const onVisibility = () => (document.hidden ? stop() : (void poll(), start()));
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stamp the visit AFTER the recap initializer has read the previous value.
  useEffect(() => {
    try {
      localStorage.setItem('bridge-last-seen', new Date().toISOString());
    } catch {
      /* storage unavailable */
    }
  }, []);

  const replayed = useMemo(
    () => (replayCutoff === null ? events : events.filter((e) => e.id <= replayCutoff)),
    [events, replayCutoff],
  );
  // Newest first: this is a changelog, not a chat.
  const workEvents = useMemo(
    () => replayed.filter((e) => WORK_KINDS.has(e.kind)).reverse(),
    [replayed],
  );

  const live = nowMs - Date.parse(feed.watch.lastActivityAt) <= LIVE_WINDOW_MS;
  const replaying = replayCutoff !== null;
  // A real CI failure outranks liveness: the site's condition matters more
  // than its pulse. Replay outranks both (you are scrubbing history).
  const alerting = feed.alert !== null && !replaying;
  const lastWorker = workEvents[0]?.actor;

  const crewName = (id: string) =>
    feed.crew.find((m) => m.id === id)?.name ?? ACTOR_LABEL[id] ?? id;

  const badgeColor = replaying
    ? 'var(--color-warning)'
    : alerting
      ? 'var(--color-danger)'
      : live
        ? 'var(--color-accent)'
        : 'var(--color-text-subtle)';
  const badgeLabel = replaying ? 'REPLAY' : alerting ? 'CI RED' : live ? 'LIVE' : 'OFF DUTY';

  const card: CSSProperties = {
    background: 'var(--color-bg-elevated)',
    border: '1px solid var(--color-border)',
  };
  const microLabel = 'mb-3 font-mono text-[10px] tracking-widest uppercase';

  return (
    <div className="space-y-4" data-testid="bridge-view">
      {/* Watch bar */}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg px-4 py-3 font-mono text-xs"
        style={card}
      >
        <span className="flex items-center gap-2" data-testid="liveness">
          <span
            aria-hidden="true"
            className={live && !replaying ? 'motion-safe:animate-pulse' : ''}
            style={{
              width: 8,
              height: 8,
              borderRadius: 9999,
              background: badgeColor,
              boxShadow: live && !replaying ? `0 0 8px ${badgeColor}` : 'none',
            }}
          />
          <span style={{ color: badgeColor }}>{badgeLabel}</span>
        </span>
        <span style={{ color: 'var(--color-text-muted)' }}>
          {live
            ? `watch tick ${feed.watch.tick}`
            : `last activity ${relTime(feed.watch.lastActivityAt, nowMs)} · next heartbeat within 3h`}
        </span>
        <span className="ml-auto tabular-nums" style={{ color: 'var(--color-text-subtle)' }}>
          {utcClock(nowMs)}
        </span>
      </div>

      {/* CI alert: the one loud thing on the page, and only when it's true. */}
      {alerting && feed.alert && (
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-4 py-3 font-mono text-xs"
          style={{
            border: '1px solid var(--color-danger-dim)',
            background: 'color-mix(in srgb, var(--color-danger) 7%, var(--color-bg-elevated))',
          }}
        >
          <span style={{ color: 'var(--color-danger)' }}>
            ▲ CI failing on {feed.alert.repo.split('/')[1] ?? feed.alert.repo}
          </span>
          {feed.alert.since && (
            <span style={{ color: 'var(--color-text-muted)' }}>
              red for {relTime(feed.alert.since, nowMs).replace(' ago', '')}
            </span>
          )}
          <a
            href={feed.alert.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-4 hover:underline"
            style={{ color: 'var(--color-danger)' }}
          >
            view failing run ↗
          </a>
        </div>
      )}

      {/* Proof row: three claims, each with its receipt. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg p-4" style={card}>
          <p className={microLabel} style={{ color: 'var(--color-text-subtle)' }}>
            Last shipped
          </p>
          {feed.shipped ? (
            <>
              <p className="text-sm leading-snug" style={{ color: 'var(--color-text)' }}>
                {feed.shipped.title}
              </p>
              <p className="mt-2 font-mono text-[11px]">
                <span style={{ color: 'var(--color-text-subtle)' }}>
                  {relTime(feed.shipped.at, nowMs)} ·{' '}
                </span>
                <a
                  href={feed.shipped.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline-offset-4 hover:underline"
                  style={{ color: 'var(--color-accent)' }}
                >
                  view commit ↗
                </a>
              </p>
            </>
          ) : (
            <p className="text-sm" style={{ color: 'var(--color-text-subtle)' }}>
              No pushes filed yet. Scout sweeps on each heartbeat.
            </p>
          )}
        </div>

        <div className="rounded-lg p-4" style={card}>
          <p className={microLabel} style={{ color: 'var(--color-text-subtle)' }}>
            CI watch
          </p>
          {feed.alert ? (
            <>
              <p className="text-sm leading-snug" style={{ color: 'var(--color-danger)' }}>
                {feed.alert.workflow} failing on {feed.alert.repo.split('/')[1]}
              </p>
              <p className="mt-2 font-mono text-[11px]">
                <a
                  href={feed.alert.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline-offset-4 hover:underline"
                  style={{ color: 'var(--color-danger)' }}
                >
                  view failing run ↗
                </a>
              </p>
            </>
          ) : (
            <>
              <p className="text-sm leading-snug" style={{ color: 'var(--color-text)' }}>
                All watched branches green.
              </p>
              <p
                className="mt-2 font-mono text-[11px]"
                style={{ color: 'var(--color-text-subtle)' }}
              >
                checked on every Scout sweep
              </p>
            </>
          )}
        </div>

        <div className="rounded-lg p-4" style={card}>
          <p className={microLabel} style={{ color: 'var(--color-text-subtle)' }}>
            Model budget
          </p>
          <p
            className="text-sm leading-snug tabular-nums"
            style={{ color: 'var(--color-text)' }}
            data-testid="spend-meter"
          >
            ${feed.spend.costUsd.toFixed(2)} today · {feed.spend.calls}{' '}
            {feed.spend.calls === 1 ? 'call' : 'calls'} of {feed.spend.cap}
          </p>
          <p className="mt-2 font-mono text-[11px]" style={{ color: 'var(--color-text-subtle)' }}>
            hard daily cap; idle costs $0
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* Work log: real actions only, newest first, receipts attached. */}
        <section className="rounded-lg p-4 lg:col-span-3" style={card} aria-label="Crew work log">
          <div className="flex items-baseline justify-between">
            <p className={microLabel} style={{ color: 'var(--color-text-subtle)' }}>
              Work log — real actions only
            </p>
            {replaying && (
              <button
                type="button"
                onClick={() => setReplayCutoff(null)}
                className="font-mono text-[11px] underline-offset-4 hover:underline"
                style={{ color: 'var(--color-warning)' }}
              >
                replaying history · back to live
              </button>
            )}
          </div>

          {recap && (
            <p
              className="mb-3 rounded-md p-3 font-mono text-xs"
              style={{ border: '1px dashed var(--color-border-strong)' }}
            >
              <span style={{ color: 'var(--color-accent)' }}>Since your last visit:</span>{' '}
              <span style={{ color: 'var(--color-text-muted)' }}>
                {recap.actions} {recap.actions === 1 ? 'action' : 'actions'} since{' '}
                {recap.since.slice(5, 16).replace('T', ' ')}Z.
              </span>{' '}
              <button
                type="button"
                onClick={() => setRecap(null)}
                className="underline-offset-4 hover:underline"
                style={{ color: 'var(--color-text-subtle)' }}
              >
                dismiss
              </button>
            </p>
          )}

          <ol
            className="themed-scroll max-h-[440px] space-y-3 overflow-y-auto pr-1"
            data-lenis-prevent
          >
            {workEvents.length === 0 && (
              <li className="text-sm leading-relaxed" style={{ color: 'var(--color-text-subtle)' }}>
                No maintenance actions in the recent log. The crew acts when there is real work: a
                push to file, a copy fix to draft, a CI failure to flag. Heartbeats are recorded in
                the full log below.
              </li>
            )}
            {workEvents.map((e) => (
              <li key={e.id} className="flex gap-3" style={{ contain: 'layout style' }}>
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded font-mono text-[10px]"
                  style={{
                    background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
                    color: 'var(--color-accent)',
                    border: '1px solid var(--color-border)',
                  }}
                >
                  {crewName(e.actor).slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <span className="mr-2 font-mono text-xs" style={{ color: 'var(--color-text)' }}>
                    {crewName(e.actor)}
                  </span>
                  <span
                    className="mr-2 font-mono text-[10px] tracking-widest uppercase"
                    style={{ color: 'var(--color-text-subtle)' }}
                  >
                    {KIND_LABEL[e.kind] ?? e.kind}
                  </span>
                  <time
                    className="font-mono text-[10px] tabular-nums"
                    style={{ color: 'var(--color-text-subtle)' }}
                    dateTime={e.createdAt}
                    title={e.createdAt}
                  >
                    {relTime(e.createdAt, nowMs)}
                  </time>
                  <p
                    className="text-sm leading-relaxed"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {e.summary}
                    {e.link && (
                      <a
                        href={e.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 font-mono text-xs whitespace-nowrap underline-offset-4 hover:underline"
                        style={{ color: 'var(--color-accent)' }}
                      >
                        receipt ↗
                      </a>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--color-border)' }}>
            <p className={microLabel} style={{ color: 'var(--color-text-subtle)' }}>
              Ask about my work — answers cite real case studies
            </p>
            <EnvoyComms online={feed.commsOnline} />
          </div>
        </section>

        {/* The crew */}
        <section className="rounded-lg p-4 lg:col-span-2" style={card} aria-label="The crew">
          <p className={microLabel} style={{ color: 'var(--color-text-subtle)' }}>
            The crew — five agents, five real jobs
          </p>
          <ul className="space-y-2">
            {feed.crew.map((m) => {
              const working = m.id === lastWorker;
              return (
                <li
                  key={m.id}
                  className="rounded-md p-3 transition-[border-color] duration-200"
                  style={{
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: working ? 'var(--color-accent-dim)' : 'var(--color-border)',
                  }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className="font-mono text-sm"
                      style={{ color: working ? 'var(--color-accent)' : 'var(--color-text)' }}
                    >
                      {m.name}
                    </span>
                    <span
                      className="font-mono text-[10px] tracking-widest uppercase"
                      style={{
                        color: m.online ? 'var(--color-text-muted)' : 'var(--color-text-subtle)',
                      }}
                    >
                      {m.online ? m.station : `${m.station} · offline`}
                    </span>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--color-text-subtle)' }}>
                    {m.role}
                  </p>
                  <p
                    className="mt-1.5 text-xs leading-relaxed"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {m.status}
                  </p>
                </li>
              );
            })}
          </ul>

          <p className={`${microLabel} mt-6`} style={{ color: 'var(--color-text-subtle)' }}>
            How a change ships
          </p>
          <ol className="space-y-2">
            {PIPELINE_STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-3 text-xs leading-relaxed">
                <span
                  className="font-mono tabular-nums"
                  style={{ color: 'var(--color-accent-dim)' }}
                >
                  {i + 1}
                </span>
                <span style={{ color: 'var(--color-text-muted)' }}>
                  <span style={{ color: 'var(--color-text)' }}>{step.title}.</span> {step.body}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {/* Footer strip: missions, build history, the full unfiltered log. */}
      <div className="rounded-lg p-4" style={card}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-xs">
          {/* Crew-owned copy: Critic audits it, Curator edits it, Ruslan signs off. */}
          <span style={{ color: 'var(--color-text-subtle)' }}>{curated.crew_motto}</span>
          {events.length > 2 && (
            <span className="flex items-center gap-2">
              <label htmlFor="replay-scrub" style={{ color: 'var(--color-text-subtle)' }}>
                replay
              </label>
              <input
                id="replay-scrub"
                type="range"
                min={0}
                max={events.length - 1}
                value={
                  replayCutoff === null
                    ? events.length - 1
                    : Math.max(
                        0,
                        events.findIndex((e) => e.id === replayCutoff),
                      )
                }
                onChange={(e) => {
                  const idx = Number(e.target.value);
                  setReplayCutoff(idx >= events.length - 1 ? null : events[idx].id);
                }}
                className="w-28 accent-[var(--color-accent)]"
                aria-label="Scrub through the log history"
              />
              {replaying && (
                <button
                  type="button"
                  onClick={() => setReplayCutoff(null)}
                  className="underline-offset-4 hover:underline"
                  style={{ color: 'var(--color-accent)' }}
                >
                  back to live
                </button>
              )}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowFullLog((v) => !v)}
            className="ml-auto underline-offset-4 hover:underline"
            style={{ color: 'var(--color-accent)' }}
            aria-expanded={showFullLog}
          >
            {showFullLog ? 'close full log' : 'full log, heartbeats included →'}
          </button>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            {feed.missions.length > 0 && (
              <>
                <p
                  className={microLabel.replace('mb-3', 'mb-2')}
                  style={{ color: 'var(--color-text-subtle)' }}
                >
                  Missions — dispatched by visitors and audits
                </p>
                <ul className="mb-4 space-y-1.5">
                  {feed.missions.map((m) => (
                    <li key={m.id} className="flex items-baseline gap-2 font-mono text-[11px]">
                      <span
                        className="uppercase"
                        style={{
                          color:
                            m.status === 'done'
                              ? 'var(--color-accent)'
                              : m.status === 'failed'
                                ? 'var(--color-warning)'
                                : 'var(--color-text)',
                        }}
                      >
                        #{m.id} {m.status}
                      </span>
                      <span style={{ color: 'var(--color-text-muted)' }}>
                        → {m.assignee ?? 'crew'}: {m.title.slice(0, 70)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p
              className={microLabel.replace('mb-3', 'mb-2')}
              style={{ color: 'var(--color-text-subtle)' }}
            >
              Build history — how this system got here
            </p>
            <ul className="space-y-1.5">
              {feed.roadmap.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-xs">
                  <span
                    className="font-mono text-[10px] uppercase"
                    style={{
                      color:
                        m.status === 'done'
                          ? 'var(--color-accent)'
                          : m.status === 'active'
                            ? 'var(--color-text)'
                            : 'var(--color-text-subtle)',
                    }}
                  >
                    {m.status === 'done' ? '✓' : m.status === 'active' ? '▸' : '·'}
                  </span>
                  <span
                    style={{
                      color:
                        m.status === 'queued'
                          ? 'var(--color-text-subtle)'
                          : 'var(--color-text-muted)',
                    }}
                  >
                    {m.title}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {showFullLog && (
            <div>
              <p
                className={microLabel.replace('mb-3', 'mb-2')}
                style={{ color: 'var(--color-text-subtle)' }}
              >
                Full log — every entry, including the boring ones
              </p>
              <ol
                className="themed-scroll max-h-[280px] space-y-2 overflow-y-auto pr-1"
                data-lenis-prevent
              >
                {[...replayed].reverse().map((e) => (
                  <li key={e.id} className="font-mono text-[11px] leading-relaxed">
                    <span style={{ color: 'var(--color-text-subtle)' }} title={e.createdAt}>
                      {e.createdAt.slice(11, 19)}Z
                    </span>{' '}
                    <span style={{ color: 'var(--color-accent-dim)' }}>{crewName(e.actor)}</span>{' '}
                    <span style={{ color: 'var(--color-text-muted)' }}>{e.summary}</span>
                    {e.link && (
                      <a
                        href={e.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-1 underline-offset-4 hover:underline"
                        style={{ color: 'var(--color-accent)' }}
                      >
                        ↗
                      </a>
                    )}
                    {e.detail != null && (
                      <details className="ml-2 inline-block align-top">
                        <summary
                          className="cursor-pointer select-none"
                          style={{ color: 'var(--color-text-subtle)' }}
                        >
                          trace
                        </summary>
                        <pre
                          className="mt-1 max-w-full overflow-x-auto rounded p-2 text-[10px]"
                          style={{
                            background: 'var(--color-bg)',
                            color: 'var(--color-text-subtle)',
                          }}
                        >
                          {JSON.stringify(e.detail, null, 2)}
                        </pre>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
