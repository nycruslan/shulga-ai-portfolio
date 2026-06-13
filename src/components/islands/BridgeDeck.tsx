import { useEffect, useState } from 'react';
import type { BridgeFeedPayload } from '../../lib/bridge/feed';
import type { BridgeEvent } from '../../lib/bridge/persistence/events';

// The Operations Deck: the visual heart of the bridge and the honest successor
// to the old Substrate canvas. Five station consoles, each with a live readout
// of what that agent is actually doing, around a central viewscreen that types
// out the single most recent real event. Consoles "power up" only when their
// agent genuinely acts; otherwise they show ambient "powered console" motion
// (a radar sweep, a waveform, a blinking caret) that reads as on-watch, never
// as fabricated work. Fully static under prefers-reduced-motion.

type Crew = BridgeFeedPayload['crew'][number];

type Props = {
  crew: BridgeFeedPayload['crew'];
  /** Channel-visible events (already filtered for replay), oldest..newest. */
  events: BridgeEvent[];
  spend: BridgeFeedPayload['spend'];
  shipped: BridgeFeedPayload['shipped'];
  live: boolean;
  replay: boolean;
  nowMs: number;
};

const ACTOR_LABEL: Record<string, { name: string; station: string }> = {
  engine: { name: 'System', station: 'Core' },
  narrator: { name: 'Narrator', station: 'Voice' },
};

function relTime(iso: string, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function useReducedMotion(): boolean {
  const [reduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  return reduced;
}

// Types the headline on, character by character, when the event id changes.
// Parent keys this by event id so each new headline remounts and retypes; the
// only setState happens inside the interval callback (async), never in the
// effect body.
function Viewline({ text, reduced }: { text: string; reduced: boolean }) {
  const [shown, setShown] = useState(() => (reduced ? text : ''));
  useEffect(() => {
    if (reduced) return;
    let i = 0;
    const interval = window.setInterval(() => {
      i += 2;
      setShown(text.slice(0, i));
      if (i >= text.length) window.clearInterval(interval);
    }, 18);
    return () => window.clearInterval(interval);
  }, [text, reduced]);
  const typing = !reduced && shown.length < text.length;
  return (
    <>
      {shown}
      {typing && (
        <span className="deck-caret" style={{ color: 'var(--color-accent)' }}>
          ▋
        </span>
      )}
    </>
  );
}

function StationViz({
  id,
  active,
  spend,
  shipped,
}: {
  id: string;
  active: boolean;
  spend: Props['spend'];
  shipped: Props['shipped'];
}) {
  const hot = active ? 'var(--color-accent)' : 'var(--color-accent-dim)';

  if (id === 'scout') {
    return (
      <div className="relative h-12 w-12">
        <svg viewBox="0 0 48 48" className="absolute inset-0 h-12 w-12">
          <circle cx="24" cy="24" r="21" fill="none" stroke="var(--color-border-strong)" />
          <circle cx="24" cy="24" r="12" fill="none" stroke="var(--color-border)" />
          <line x1="3" y1="24" x2="45" y2="24" stroke="var(--color-border)" strokeWidth="0.5" />
          <line x1="24" y1="3" x2="24" y2="45" stroke="var(--color-border)" strokeWidth="0.5" />
          {shipped && <circle cx="33" cy="17" r="1.6" fill={hot} />}
        </svg>
        <div
          className="deck-sweep absolute inset-0 rounded-full"
          style={{
            background: `conic-gradient(from 0deg, color-mix(in srgb, ${hot} 38%, transparent), transparent 70deg)`,
            WebkitMaskImage: 'radial-gradient(circle, #000 64%, transparent 70%)',
            maskImage: 'radial-gradient(circle, #000 64%, transparent 70%)',
          }}
        />
      </div>
    );
  }

  if (id === 'envoy') {
    return (
      <div className="flex h-12 items-end gap-[3px]">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            className="deck-wave-bar w-[3px] rounded-full"
            style={{
              height: 30,
              background: hot,
              animationDelay: `${i * 0.11}s`,
              opacity: active ? 0.95 : 0.6,
            }}
          />
        ))}
      </div>
    );
  }

  if (id === 'critic') {
    const frac = Math.min(1, spend.cap > 0 ? spend.calls / spend.cap : 0);
    return (
      <div className="flex h-12 w-full flex-col justify-center gap-1.5 px-1">
        <div className="flex justify-between font-mono text-[9px]" style={{ color: hot }}>
          <span>BUDGET</span>
          <span>
            {spend.calls}/{spend.cap}
          </span>
        </div>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full"
          style={{ background: 'var(--color-border)' }}
        >
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${Math.max(3, frac * 100)}%`, background: hot }}
          />
        </div>
        <div className="font-mono text-[9px]" style={{ color: 'var(--color-text-subtle)' }}>
          ${spend.costUsd.toFixed(2)} today
        </div>
      </div>
    );
  }

  if (id === 'curator') {
    return (
      <div className="flex h-12 w-full flex-col justify-center gap-[5px] px-1">
        {[16, 11, 14].map((w, i) => (
          <div
            key={i}
            className="h-[3px] rounded-full"
            style={{
              width: `${w * 6}%`,
              background: i === 2 ? 'transparent' : 'var(--color-border-strong)',
            }}
          >
            {i === 2 && (
              <span className="flex items-center gap-1">
                <span
                  className="h-[3px] rounded-full"
                  style={{ width: `${w * 5}%`, background: hot }}
                />
                <span
                  className="deck-caret inline-block h-3 w-[2px]"
                  style={{ background: 'var(--color-accent)' }}
                />
              </span>
            )}
          </div>
        ))}
      </div>
    );
  }

  // archivist: a small ledger meter
  const bars = [7, 12, 9, 16, 11, 14, 8];
  return (
    <div className="flex h-12 items-end gap-[3px]">
      {bars.map((h, i) => (
        <div
          key={i}
          className="w-[3px] rounded-sm"
          style={{
            height: h * 2,
            background: i === bars.length - 1 ? hot : 'var(--color-border-strong)',
          }}
        />
      ))}
    </div>
  );
}

function Console({
  member,
  active,
  live,
  spend,
  shipped,
}: {
  member: Crew;
  active: boolean;
  live: boolean;
  spend: Props['spend'];
  shipped: Props['shipped'];
}) {
  const accent = active
    ? 'var(--color-accent)'
    : member.online
      ? 'var(--color-text)'
      : 'var(--color-text-subtle)';
  return (
    <div
      className="relative overflow-hidden rounded-md p-2.5 transition-[border-color,box-shadow] duration-200"
      style={{
        background: active
          ? 'color-mix(in srgb, var(--color-accent) 6%, var(--color-bg))'
          : 'var(--color-bg)',
        border: `1px solid ${active ? 'var(--color-accent-dim)' : 'var(--color-border)'}`,
        boxShadow: active && live ? '0 0 18px -6px var(--color-accent)' : 'none',
      }}
    >
      {active && live && (
        <span
          aria-hidden="true"
          className="deck-scanline pointer-events-none absolute inset-x-0 top-0 h-8"
          style={{
            background:
              'linear-gradient(to bottom, transparent, color-mix(in srgb, var(--color-accent) 14%, transparent), transparent)',
          }}
        />
      )}
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs" style={{ color: accent }}>
          {member.name}
        </span>
        <span
          aria-hidden="true"
          className={active && live ? 'deck-led-live' : ''}
          style={{
            width: 7,
            height: 7,
            borderRadius: 9999,
            background: active
              ? 'var(--color-accent)'
              : member.online
                ? 'var(--color-accent-dim)'
                : 'var(--color-text-subtle)',
            boxShadow: active ? '0 0 6px var(--color-accent)' : 'none',
          }}
        />
      </div>
      <div className="mt-2.5 flex h-12 items-center justify-center">
        <StationViz id={member.id} active={active} spend={spend} shipped={shipped} />
      </div>
      <p
        className="mt-2 line-clamp-2 text-[11px] leading-snug"
        style={{
          color: active ? 'var(--color-text-muted)' : 'var(--color-text-subtle)',
          minHeight: 28,
        }}
      >
        {member.status}
      </p>
      <p
        className="mt-1.5 font-mono text-[9px] tracking-widest uppercase"
        style={{ color: 'var(--color-text-subtle)' }}
      >
        {member.online ? member.station : `${member.station} · offline`}
      </p>
    </div>
  );
}

export default function BridgeDeck({ crew, events, spend, shipped, live, replay, nowMs }: Props) {
  const reduced = useReducedMotion();
  const headline = events.at(-1);
  const activeActor = headline?.actor;
  const onlineCount = crew.filter((m) => m.online).length;

  const actorMeta =
    crew.find((m) => m.id === activeActor) ?? (activeActor ? ACTOR_LABEL[activeActor] : undefined);
  const monogram = (actorMeta?.name ?? 'BR').slice(0, 2).toUpperCase();

  const stateLabel = replay ? 'REPLAY' : live ? 'LIVE' : 'STANDBY';
  const stateColor = replay ? '#e2a04a' : live ? 'var(--color-accent)' : 'var(--color-text-subtle)';

  return (
    <div
      className="relative overflow-hidden rounded-lg p-4 md:p-5"
      style={{
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        backgroundImage:
          'linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(90deg, var(--color-border) 1px, transparent 1px)',
        backgroundSize: '32px 32px',
        backgroundPosition: 'center',
      }}
      aria-label="Operations deck: live crew status"
    >
      {/* vignette so the grid fades at the edges */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 90% at 50% 30%, transparent 30%, var(--color-bg-elevated) 92%)',
        }}
      />

      <div className="relative">
        <div className="mb-3 flex items-center justify-between font-mono text-[10px] tracking-widest uppercase">
          <span style={{ color: 'var(--color-text-subtle)' }}>Operations deck</span>
          <span style={{ color: 'var(--color-text-subtle)' }}>
            {crew.length} stations · {onlineCount} online
          </span>
        </div>

        {/* Viewscreen: the single biggest thing on the page is a plain sentence
            describing what an agent just did. */}
        <div
          className="relative mb-4 overflow-hidden rounded-md px-4 py-5 md:px-6 md:py-7"
          style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
        >
          <span
            aria-hidden="true"
            className="font-display pointer-events-none absolute -top-3 right-2 select-none text-[88px] leading-none"
            style={{ color: 'color-mix(in srgb, var(--color-accent) 7%, transparent)' }}
          >
            {monogram}
          </span>
          <div className="relative">
            <p className="font-mono text-[11px] tracking-widest uppercase">
              <span style={{ color: stateColor }}>● {stateLabel}</span>
              {actorMeta && (
                <span style={{ color: 'var(--color-text-subtle)' }}>
                  {' '}
                  · {actorMeta.name} · {actorMeta.station}
                </span>
              )}
            </p>
            <p
              className="mt-2 max-w-3xl text-lg leading-snug md:text-xl"
              style={{ color: 'var(--color-text)', minHeight: '2.4em' }}
            >
              {headline ? (
                <Viewline key={headline.id} text={headline.summary} reduced={reduced} />
              ) : (
                <span style={{ color: 'var(--color-text-subtle)' }}>
                  Crew on watch. The next heartbeat or your next message wakes the channel.
                </span>
              )}
            </p>
            {headline && (
              <p className="mt-2 flex items-center gap-3 font-mono text-[11px]">
                <span style={{ color: 'var(--color-text-subtle)' }}>
                  {relTime(headline.createdAt, nowMs)}
                </span>
                {headline.link && (
                  <a
                    href={headline.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline-offset-4 hover:underline"
                    style={{ color: 'var(--color-accent)' }}
                  >
                    open artifact ↗
                  </a>
                )}
              </p>
            )}
          </div>
        </div>

        {/* Station consoles */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
          {crew.map((m) => (
            <Console
              key={m.id}
              member={m}
              active={m.id === activeActor}
              live={live && !replay}
              spend={spend}
              shipped={shipped}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
