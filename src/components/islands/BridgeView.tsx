import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BridgeFeedPayload } from '../../lib/bridge/feed';
import { LIVE_WINDOW_MS } from '../../lib/bridge/feed';
import type { BridgeEvent } from '../../lib/bridge/persistence/events';
import EnvoyComms from './EnvoyComms';
import BridgeDeck from './BridgeDeck';
import curated from '../../data/curated.json';

// The Viewscreen. Crew channel center-left (the narrative spine), roster rail
// right (the cast), watch bar on top, receipts strip below. Everything
// rendered here is real: events from the append-only log, spend from the
// budget table, liveness from actual timestamps. Honesty rules: LIVE vs OFF
// DUTY is computed, never asserted; idle is shown as idle, not faked over.

const POLL_MS = 4000;
const CHANNEL_KINDS = new Set(['channel', 'visitor', 'github', 'brief', 'mission', 'audit']);

type Props = { initial: BridgeFeedPayload };

function relTime(iso: string, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function utcClock(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(11, 19) + 'Z';
}

const ACTOR_LABEL: Record<string, string> = {
  engine: 'ENGINE',
  narrator: 'NARRATOR',
};

export default function BridgeView({ initial }: Props) {
  const [feed, setFeed] = useState<BridgeFeedPayload>(initial);
  const [events, setEvents] = useState<BridgeEvent[]>(initial.events);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pinned, setPinned] = useState(true); // user is at the channel bottom
  const [unseen, setUnseen] = useState(0);
  const [showLog, setShowLog] = useState(false);
  // Replay: when set, the channel shows history up to this event id, honestly badged.
  const [replayCutoff, setReplayCutoff] = useState<number | null>(null);
  // "Since your last visit" recap, computed once from real events (lazy
  // initializer: the island is client-only, so localStorage is available).
  const [recap, setRecap] = useState<{ since: string; events: number; missions: number } | null>(
    () => {
      try {
        const lastSeen = localStorage.getItem('bridge-last-seen');
        if (!lastSeen || Date.now() - Date.parse(lastSeen) < 3600_000) return null;
        const since = initial.events.filter((e) => e.createdAt > lastSeen);
        if (since.length === 0) return null;
        return {
          since: lastSeen,
          events: since.length,
          missions: since.filter((e) => e.kind === 'mission' && e.summary.includes('complete'))
            .length,
        };
      } catch {
        return null;
      }
    },
  );
  const cursorRef = useRef(initial.cursor);
  const channelRef = useRef<HTMLOListElement>(null);

  // One clock for the whole screen; cheap and keeps timestamps coherent.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Wake the crew: a visitor arriving IS the tick trigger (and Envoy's hail,
  // when one fires, is therefore a real event). Then start polling.
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
          if (fresh.length && !pinned) setUnseen((n) => n + fresh.length);
          return fresh.length ? [...prev, ...fresh].slice(-200) : prev;
        });
      }
    } catch {
      /* transient network failure; next poll retries */
    }
  }, [pinned]);

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

  const channelEvents = useMemo(() => {
    const visible = events.filter((e) => CHANNEL_KINDS.has(e.kind));
    return replayCutoff === null ? visible : visible.filter((e) => e.id <= replayCutoff);
  }, [events, replayCutoff]);

  // Auto-follow only while the reader is at the bottom; otherwise offer a
  // pill. Pure DOM sync: unseen is reset at the pin points themselves
  // (scroll-to-bottom and the pill click), and never increments while pinned.
  useEffect(() => {
    const el = channelRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [channelEvents, pinned]);

  const onChannelScroll = () => {
    const el = channelRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setPinned(atBottom);
    if (atBottom) setUnseen(0);
  };

  const live = nowMs - Date.parse(feed.watch.lastActivityAt) <= LIVE_WINDOW_MS;
  const lastSpeaker = channelEvents.at(-1)?.actor;

  const crewName = (id: string) =>
    feed.crew.find((m) => m.id === id)?.name ?? ACTOR_LABEL[id] ?? id;

  return (
    <div className="space-y-4" data-testid="bridge-view">
      {/* Watch bar */}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg px-4 py-3 font-mono text-xs"
        style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
      >
        <span className="flex items-center gap-2" data-testid="liveness">
          <span
            aria-hidden="true"
            className={live && replayCutoff === null ? 'motion-safe:animate-pulse' : ''}
            style={{
              width: 8,
              height: 8,
              borderRadius: 9999,
              background:
                replayCutoff !== null
                  ? 'var(--color-warning)'
                  : live
                    ? 'var(--color-accent)'
                    : 'var(--color-text-subtle)',
              boxShadow: live && replayCutoff === null ? '0 0 8px var(--color-accent)' : 'none',
            }}
          />
          <span
            style={{
              color:
                replayCutoff !== null
                  ? 'var(--color-warning)'
                  : live
                    ? 'var(--color-accent)'
                    : 'var(--color-text-subtle)',
            }}
          >
            {replayCutoff !== null ? 'REPLAY' : live ? 'LIVE' : 'OFF DUTY'}
          </span>
        </span>
        <span style={{ color: 'var(--color-text-muted)' }}>
          {live
            ? `watch tick ${feed.watch.tick}`
            : `last activity ${relTime(feed.watch.lastActivityAt, nowMs)} ago · heartbeat every 3h`}
        </span>
        {feed.shipped && (
          <a
            href={feed.shipped.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-4 hover:underline"
            style={{ color: 'var(--color-text-muted)' }}
            title={feed.shipped.title}
          >
            shipped {relTime(feed.shipped.at, nowMs)} ago →{' '}
            <span style={{ color: 'var(--color-accent)' }}>view commit</span>
          </a>
        )}
        <span className="ml-auto tabular-nums" style={{ color: 'var(--color-text-subtle)' }}>
          {utcClock(nowMs)}
        </span>
      </div>

      {/* The Operations Deck: the spectacle. Stations power up only on real
          activity; the viewscreen types out the latest real event. */}
      <BridgeDeck
        crew={feed.crew}
        events={channelEvents}
        spend={feed.spend}
        shipped={feed.shipped}
        live={live}
        replay={replayCutoff !== null}
        nowMs={nowMs}
      />

      <div className="grid gap-4 lg:grid-cols-5">
        {/* Crew channel */}
        <section
          className="lg:col-span-3 rounded-lg p-4"
          style={{
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
          }}
          aria-label="Crew channel, agents coordinating live"
        >
          <p
            className="mb-3 font-mono text-[10px] tracking-widest uppercase"
            style={{ color: 'var(--color-text-subtle)' }}
          >
            Crew channel — agents coordinating live
          </p>
          <div className="relative">
            <ol
              ref={channelRef}
              onScroll={onChannelScroll}
              aria-live="polite"
              aria-atomic="false"
              className="max-h-[420px] min-h-[280px] space-y-3 overflow-y-auto pr-1"
              data-lenis-prevent
            >
              {recap && (
                <li
                  className="rounded-md p-3 font-mono text-xs"
                  style={{ border: '1px dashed var(--color-border-strong)' }}
                >
                  <span style={{ color: 'var(--color-accent)' }}>Since your last visit:</span>{' '}
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {recap.events} log {recap.events === 1 ? 'entry' : 'entries'}
                    {recap.missions > 0 &&
                      `, ${recap.missions} ${recap.missions === 1 ? 'mission' : 'missions'} completed`}
                    {' since '}
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
                </li>
              )}
              {channelEvents.length === 0 && (
                <li className="text-sm" style={{ color: 'var(--color-text-subtle)' }}>
                  Quiet channel. The crew speaks on each watch tick; your arrival just triggered
                  one.
                </li>
              )}
              {channelEvents.map((e) => (
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
            {unseen > 0 && (
              <button
                type="button"
                onClick={() => {
                  setPinned(true);
                  setUnseen(0);
                  const el = channelRef.current;
                  if (el) el.scrollTop = el.scrollHeight;
                }}
                className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 font-mono text-[10px]"
                style={{
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border-strong)',
                  color: 'var(--color-accent)',
                }}
              >
                {unseen} new {unseen === 1 ? 'message' : 'messages'} ↓
              </button>
            )}
          </div>

          <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--color-border)' }}>
            <p
              className="mb-3 font-mono text-[10px] tracking-widest uppercase"
              style={{ color: 'var(--color-text-subtle)' }}
            >
              Comms — hail the bridge, dispatch a mission
            </p>
            <EnvoyComms online={feed.commsOnline} />
          </div>
        </section>

        {/* Roster rail */}
        <section
          className="lg:col-span-2 rounded-lg p-4"
          style={{
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
          }}
          aria-label="Crew roster"
        >
          <p
            className="mb-3 font-mono text-[10px] tracking-widest uppercase"
            style={{ color: 'var(--color-text-subtle)' }}
          >
            Roster — five agents, five real jobs
          </p>
          <ul className="space-y-2">
            {feed.crew.map((m) => {
              const speaking = m.id === lastSpeaker;
              return (
                <li
                  key={m.id}
                  className="rounded-md p-3 transition-[opacity,border-color] duration-200"
                  style={{
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: speaking ? 'var(--color-accent-dim)' : 'var(--color-border)',
                    opacity: speaking || !lastSpeaker ? 1 : 0.62,
                  }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className="font-mono text-sm"
                      style={{ color: speaking ? 'var(--color-accent)' : 'var(--color-text)' }}
                    >
                      {m.name}
                    </span>
                    {/* Neutral micro-label: rations the green (active state owns
                        it) and keeps small text above AA contrast. */}
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
        </section>
      </div>

      {/* Receipts strip: real spend, the roadmap, and the full log */}
      <div
        className="rounded-lg p-4"
        style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-xs">
          <span
            className="tabular-nums"
            style={{ color: 'var(--color-text-muted)' }}
            data-testid="spend-meter"
          >
            today: {feed.spend.calls} model {feed.spend.calls === 1 ? 'call' : 'calls'} · $
            {feed.spend.costUsd.toFixed(2)} of thinking · cap {feed.spend.cap}
          </span>
          {/* Crew-owned copy: Critic audits it, Curator edits it, Ruslan signs off. */}
          <span style={{ color: 'var(--color-text-subtle)' }}>{curated.crew_motto}</span>
          {/* Replay scrubber: scrub the real log; the badge flips to REPLAY. */}
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
                aria-label="Scrub through the ship's log history"
              />
              {replayCutoff !== null && (
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
            onClick={() => setShowLog((v) => !v)}
            className="ml-auto underline-offset-4 hover:underline"
            style={{ color: 'var(--color-accent)' }}
            aria-expanded={showLog}
          >
            {showLog ? "close ship's log" : "ship's log →"}
          </button>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            {feed.missions.length > 0 && (
              <>
                <p
                  className="mb-2 font-mono text-[10px] tracking-widest uppercase"
                  style={{ color: 'var(--color-text-subtle)' }}
                >
                  Missions — dispatched by visitors like you
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
              className="mb-2 font-mono text-[10px] tracking-widest uppercase"
              style={{ color: 'var(--color-text-subtle)' }}
            >
              Mission board — how this deck was built
            </p>
            {feed.roadmap.every((m) => m.status === 'done') && (
              <p className="mb-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Season 1 complete. The crew keeps the watch; visitor missions land above.
              </p>
            )}
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

          {showLog && (
            <div>
              <p
                className="mb-2 font-mono text-[10px] tracking-widest uppercase"
                style={{ color: 'var(--color-text-subtle)' }}
              >
                Ship's log — every entry, including the boring ones
              </p>
              <ol className="max-h-[280px] space-y-2 overflow-y-auto pr-1" data-lenis-prevent>
                {[...events].reverse().map((e) => (
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
