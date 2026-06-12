import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, GardenSnapshot, ProjectKind } from '../../lib/garden/types';
import { GARDEN_CONFIG } from '../../lib/garden/types';
import { Creature, Plant, creatureGlow } from './garden-critters';
import {
  CloudRain, Sprout, MessageCircle, Share2, Users, Leaf, Heart, CalendarDays,
  Sunrise, Sun, Sunset, Moon, Sparkles, Handshake, Zap, Flower2, Wind, Lightbulb,
  Droplets, MousePointerClick, X, HeartPulse, Trees, Baby, type LucideIcon,
} from 'lucide-react';

// Map the world's coordinates (0..1) into a safe band of the stage so a creature
// near an edge stays fully on screen (its body and name tag included).
const sxn = (x: number) => 6 + x * 88;
const syn = (y: number) => 13 + y * 71; // headroom for filaments above and the name tag below
const sx = (x: number) => `${sxn(x)}%`;
const sy = (y: number) => `${syn(y)}%`;

// Belt-and-suspenders: strip any stray emoji from displayed creature speech, so
// even legacy lines render as the clean plain text the society now produces.
const stripEmoji = (s: string) =>
  s
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

// The living garden, rendered as a warm, atmospheric diorama: the creatures are
// the controls (tap one to meet it), they breathe and react, the sky drifts from
// dawn to night, fireflies drift at dusk, and every action lands with a little
// burst of feedback. A plain per-tick JSON snapshot drives it all (state out,
// view paints). Big readable type, soft springs, and a wordless invitation, so a
// child gets it in a glance; reduced-motion strips the movement but keeps meaning.

type Snap = GardenSnapshot;

const SEEN_KEY = 'garden-onboard-v1';

// ── Sky: a continuous dawn → noon → dusk → night colour cycle ──────────────────
type Rgb = [number, number, number];
const SKY: Array<{ t: number; top: Rgb; bot: Rgb }> = [
  { t: 0.0, top: [11, 18, 38], bot: [5, 7, 13] }, // deep night
  { t: 0.2, top: [36, 31, 51], bot: [17, 16, 28] }, // pre-dawn indigo
  { t: 0.28, top: [74, 47, 56], bot: [30, 22, 32] }, // dawn rose
  { t: 0.42, top: [42, 63, 48], bot: [18, 32, 23] }, // morning green
  { t: 0.5, top: [36, 63, 48], bot: [16, 31, 23] }, // midday
  { t: 0.66, top: [52, 56, 31], bot: [24, 28, 14] }, // afternoon gold
  { t: 0.76, top: [74, 46, 38], bot: [31, 20, 17] }, // dusk amber
  { t: 0.85, top: [36, 31, 51], bot: [17, 16, 28] }, // twilight
  { t: 1.0, top: [11, 18, 38], bot: [5, 7, 13] }, // night
];
const lerp = (a: number, b: number, k: number) => Math.round(a + (b - a) * k);
const mix = (a: Rgb, b: Rgb, k: number): Rgb => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const rgb = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`;
function skyAt(t: number): { top: string; bot: string } {
  let lo = SKY[0];
  let hi = SKY[SKY.length - 1];
  for (let i = 0; i < SKY.length - 1; i++) {
    if (t >= SKY[i].t && t <= SKY[i + 1].t) {
      lo = SKY[i];
      hi = SKY[i + 1];
      break;
    }
  }
  const k = hi.t === lo.t ? 0 : (t - lo.t) / (hi.t - lo.t);
  return { top: rgb(mix(lo.top, hi.top, k)), bot: rgb(mix(lo.bot, hi.bot, k)) };
}

const STYLE = `
.gd-stage { position: relative; width: 100%; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 22px;
  border: 1px solid var(--color-border); background: linear-gradient(180deg, var(--sky-top), var(--sky-bot));
  transition: background 4s linear; touch-action: manipulation; user-select: none; }
.gd-ground { position: absolute; inset: 62% 0 0 0; pointer-events: none;
  background: radial-gradient(120% 80% at 50% 120%, color-mix(in srgb, #0c2417 80%, transparent), transparent 70%); }
.gd-vignette { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(75% 65% at 50% 42%, transparent 55%, rgba(0,0,0,0.45) 100%); }
.gd-fly { position: absolute; width: 5px; height: 5px; border-radius: 999px; pointer-events: none; }

.gd-node { position: absolute; transform: translate(-50%, -50%); transition: left 2.4s ease-out, top 2.4s ease-out; will-change: left, top; }
.gd-creature { position: relative; display: grid; place-items: center; background: none; border: 0; padding: 14px; cursor: pointer; }
.gd-pool { position: absolute; width: 80px; height: 80px; border-radius: 999px; filter: blur(12px); opacity: 0.5; pointer-events: none; }
.cr-svg { position: relative; }
.gd-tag { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); margin-top: 4px; white-space: nowrap;
  padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; pointer-events: none;
  background: color-mix(in srgb, var(--color-bg) 72%, transparent); color: var(--color-text); }
.gd-plant { position: absolute; transform: translate(-50%, -50%); line-height: 1; pointer-events: none; transition: left 2.4s ease-out, top 2.4s ease-out; }

.gd-bubble { position: absolute; bottom: calc(100% - 4px); left: 50%; white-space: normal; pointer-events: none; z-index: 6;
  width: max-content; max-width: 200px; padding: 7px 11px; border-radius: 14px; font-size: 15px; line-height: 1.35; font-weight: 450;
  background: #f6f1e7; color: #20242a; box-shadow: 0 6px 20px -6px rgba(0,0,0,0.6); transform-origin: bottom center; }
.gd-bubble::after { content: ''; position: absolute; top: 100%; left: 22px; border: 6px solid transparent; border-top-color: #f6f1e7; }

/* effects */
.gd-fx { position: absolute; transform: translate(-50%, -50%); pointer-events: none; z-index: 7; }
.gd-ripple { width: 14px; height: 14px; border-radius: 999px; border: 2px solid var(--color-accent); }
.gd-spark { position: absolute; width: 6px; height: 6px; border-radius: 999px; background: var(--color-accent); }
.gd-heart { font-size: 22px; }
.gd-rain { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 5; }
.gd-drop { position: absolute; top: -12%; width: 2px; height: 16px; border-radius: 2px; background: linear-gradient(180deg, transparent, #9fc7f2); opacity: 0.7; }

@media (prefers-reduced-motion: no-preference) {
  /* creature life: desynced breathe, blink, glance (via inherited --d) */
  @keyframes cr-breathe { 0%,100% { transform: translateY(0) scaleY(1); } 50% { transform: translateY(-1px) scaleY(1.04); } }
  .cr-body { transform-box: fill-box; transform-origin: 50% 100%; animation-name: cr-breathe; animation-duration: 3.7s; animation-timing-function: ease-in-out; animation-iteration-count: infinite; animation-delay: var(--d, 0s); }
  @keyframes cr-blink { 0%,93%,100% { transform: scaleY(1); } 96.5% { transform: scaleY(0.08); } }
  .cr-eyes { transform-box: fill-box; transform-origin: center; animation-name: cr-blink; animation-duration: 5.6s; animation-timing-function: ease-in-out; animation-iteration-count: infinite; animation-delay: var(--d, 0s); }
  @keyframes cr-glance { 0%,45%,100% { transform: translate(0,0); } 58% { transform: translate(2.4px,0.6px); } 78% { transform: translate(-2px,1px); } }
  .cr-pupils { transform-box: fill-box; animation-name: cr-glance; animation-duration: 7.2s; animation-timing-function: ease-in-out; animation-iteration-count: infinite; animation-delay: var(--d, 0s); }
  @keyframes cr-sway { 0%,100% { transform: rotate(-3deg); } 50% { transform: rotate(3deg); } }
  .cr-sway { transform-box: fill-box; transform-origin: 50% 100%; animation-name: cr-sway; animation-duration: 6s; animation-timing-function: ease-in-out; animation-iteration-count: infinite; animation-delay: var(--d, 0s); }
  @keyframes gd-pop { 0% { transform: translateX(-50%) scale(0.6); opacity: 0; } 60% { transform: translateX(-50%) scale(1.06); opacity: 1; } 100% { transform: translateX(-50%) scale(1); opacity: 1; } }
  .gd-bubble { left: 50%; transform: translateX(-50%); animation: gd-pop 0.34s cubic-bezier(.34,1.56,.64,1) both; }
  @keyframes gd-select { 0% { transform: scale(1); } 40% { transform: scale(1.2); } 100% { transform: scale(1); } }
  .gd-selected .cr-svg { animation: gd-select 0.42s cubic-bezier(.34,1.56,.64,1); }
  @keyframes gd-drift { 0% { transform: translate(0,0); } 50% { transform: translate(14px,-20px); } 100% { transform: translate(0,0); } }
  .gd-fly { animation: gd-drift var(--dur) ease-in-out var(--del) infinite; }
  @keyframes gd-ripple { 0% { transform: scale(0.3); opacity: 0.9; } 100% { transform: scale(3.4); opacity: 0; } }
  .gd-ripple { animation: gd-ripple 0.7s ease-out forwards; }
  @keyframes gd-spark { to { transform: translate(var(--dx), var(--dy)); opacity: 0; } }
  .gd-spark { animation: gd-spark 0.7s ease-out forwards; }
  @keyframes gd-heart { 0% { transform: translateY(0) scale(0.6); opacity: 0; } 30% { opacity: 1; } 100% { transform: translateY(-46px) scale(1.1); opacity: 0; } }
  .gd-heart { animation: gd-heart 1.2s ease-out forwards; }
  @keyframes gd-fall { to { transform: translateY(120cqh); } }
  .gd-drop { animation: gd-fall linear forwards; }
}
@media (prefers-reduced-motion: reduce) {
  .gd-node, .gd-plant, .gd-stage { transition: none; }
  .gd-bubble { left: 50%; transform: translateX(-50%); }
  .gd-fly, .gd-rain { display: none; }
}
.gd-stage { container-type: size; }
.gd-btn { display: inline-flex; align-items: center; gap: 8px; min-height: 48px; padding: 10px 18px; border-radius: 14px;
  font-size: 15px; font-weight: 500; border: 1px solid var(--color-border-strong); color: var(--color-text);
  background: var(--color-bg-elevated); transition: transform 0.12s cubic-bezier(.34,1.56,.64,1), border-color 0.15s; }
.gd-btn:hover { border-color: var(--color-accent); }
.gd-btn:active { transform: scale(0.94); }
`;

type Fx = { id: number; kind: 'sparkle' | 'heart'; x: number; y: number; tint: string };

export default function GardenView({ initial }: { initial: Snap }) {
  const [snap, setSnap] = useState<Snap>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [whisper, setWhisper] = useState('');
  const [showWhisper, setShowWhisper] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [greets, setGreets] = useState<Record<string, string>>({}); // instant client-side reactions to a tap
  const [fx, setFx] = useState<Fx[]>([]);
  const [raining, setRaining] = useState(false);
  const [onboard, setOnboard] = useState(false);
  const transcriptRef = useRef<HTMLOListElement>(null);
  const tickingRef = useRef(false);
  const fxId = useRef(0);
  const lastEventId = useRef<number>(initial.events[0]?.id ?? 0);

  const sky = useMemo(() => skyAt(snap.world.timeOfDay), [snap.world.timeOfDay]);
  const daylight = useMemo(() => Math.max(0, Math.sin(snap.world.timeOfDay * Math.PI)), [snap.world.timeOfDay]);

  useEffect(() => {
    try {
      setOnboard(!localStorage.getItem(SEEN_KEY));
    } catch {
      setOnboard(true);
    }
  }, []);

  const dismissOnboard = useCallback(() => {
    setOnboard(false);
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* fine */
    }
  }, []);

  const addFx = useCallback((kind: Fx['kind'], x: number, y: number, tint = 'var(--color-accent)') => {
    const id = ++fxId.current;
    setFx((f) => [...f.slice(-18), { id, kind, x, y, tint }]);
    setTimeout(() => setFx((f) => f.filter((i) => i.id !== id)), kind === 'heart' ? 1300 : 800);
  }, []);

  // Poll the snapshot; nudge a tick when stale and visible; burst on new bonds/births.
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/garden/world.json', { headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const next = (await res.json()) as Snap & { configured: boolean };
      if (!next.configured) return;

      // Celebrate fresh social moments with a little burst at the creature.
      const fresh = next.events.filter((e) => e.id > lastEventId.current);
      lastEventId.current = next.events[0]?.id ?? lastEventId.current;
      for (const e of fresh.slice(0, 4)) {
        if (e.kind !== 'bonded' && e.kind !== 'born') continue;
        const who = next.agents.find((a) => a.id === e.agentId);
        if (who) addFx(e.kind === 'bonded' ? 'heart' : 'sparkle', sxn(who.pos.x), syn(who.pos.y), creatureGlow(who.id));
      }

      setSnap(next);
      if (next.staleMs > GARDEN_CONFIG.tickIntervalMs && !tickingRef.current && document.visibilityState === 'visible') {
        tickingRef.current = true;
        fetch('/api/garden/tick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .catch(() => {})
          .finally(() => {
            tickingRef.current = false;
          });
      }
    } catch {
      /* transient */
    }
  }, [addFx]);

  useEffect(() => {
    refresh();
    const id = setInterval(() => document.visibilityState === 'visible' && refresh(), GARDEN_CONFIG.pollIntervalMs);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap.recentMessages.length]);

  // An instant, free reaction when you tap a creature: it greets you right away.
  const GREETINGS = ['oh, hello', 'you found me', 'yes? i am listening', 'hello, friend', 'what is it?', 'oh, a visitor'];
  const greet = useCallback((id: string) => {
    const text = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    setGreets((g) => ({ ...g, [id]: text }));
    setTimeout(() => setGreets((g) => { const n = { ...g }; delete n[id]; return n; }), 3000);
  }, []);

  const act = useCallback((body: Record<string, unknown>) => {
    fetch('/api/garden/interact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  }, []);

  const sendRain = useCallback(() => {
    dismissOnboard();
    act({ kind: 'rain' });
    setRaining(true);
    setTimeout(() => setRaining(false), 2200);
  }, [act, dismissOnboard]);

  const onStageClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      dismissOnboard();
      const r = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      addFx('sparkle', x * 100, y * 100, 'var(--color-accent)');
      act({ kind: 'seed', x, y });
    },
    [act, addFx, dismissOnboard]
  );

  const agentName = (id: string) => snap.agents.find((a) => a.id === id)?.name ?? 'someone';
  const sel = selected ? snap.agents.find((a) => a.id === selected) ?? null : null;
  const alive = snap.agents.filter((a) => a.alive);

  return (
    <div>
      <style>{STYLE}</style>

      {/* The world */}
      <div
        className="gd-stage"
        style={{ ['--sky-top' as string]: sky.top, ['--sky-bot' as string]: sky.bot }}
        onClick={onStageClick}
        role="img"
        aria-label={`A garden of ${alive.length} creatures and ${snap.plants.length} plants, day ${snap.world.day}, ${snap.world.season}.`}
      >
        {/* fireflies / pollen */}
        {FLIES.map((p, i) => (
          <span
            key={i}
            className="gd-fly"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              ['--dur' as string]: `${p.dur}s`,
              ['--del' as string]: `${p.del}s`,
              background: daylight > 0.5 ? 'rgba(255,255,255,0.5)' : '#ffe79a',
              boxShadow: daylight > 0.5 ? 'none' : '0 0 8px 2px rgba(255,231,154,0.55)',
              opacity: daylight > 0.5 ? 0.25 : 0.85,
            }}
          />
        ))}

        <div className="gd-ground" />

        {/* plants */}
        {snap.plants.map((p) => (
          <span
            key={p.id}
            className="gd-plant"
            aria-hidden
            style={{ left: sx(p.pos.x), top: sy(p.pos.y), filter: 'drop-shadow(0 0 5px rgba(122,242,160,0.22))' }}
          >
            <Plant id={p.id} growth={p.growth} health={p.health} />
          </span>
        ))}

        {/* creatures — the controls */}
        {alive.map((a) => {
          const tint = creatureGlow(a.id);
          const say = greets[a.id] ?? a.say;
          const bubble = say ? stripEmoji(say) : '';
          return (
            <button
              key={a.id}
              type="button"
              className={'gd-node gd-creature' + (selected === a.id ? ' gd-selected' : '')}
              style={{ left: sx(a.pos.x), top: sy(a.pos.y) }}
              onClick={(e) => {
                e.stopPropagation();
                dismissOnboard();
                setSelected(a.id === selected ? null : a.id);
                greet(a.id);
                addFx('sparkle', sxn(a.pos.x), syn(a.pos.y), tint);
              }}
              aria-label={`${a.name}, ${a.option.note}${bubble ? `. Saying: ${bubble}` : ''}`}
            >
              {bubble && <span key={bubble} className="gd-bubble">{bubble}</span>}
              <span className="gd-pool" style={{ background: `radial-gradient(circle, ${tint}, transparent 70%)` }} />
              <Creature id={a.id} />
              <span className="gd-tag">{a.name}</span>
            </button>
          );
        })}

        {/* effects */}
        {fx.map((f) => (
          <span key={f.id} className="gd-fx" style={{ left: `${f.x}%`, top: `${f.y}%` }}>
            {f.kind === 'heart' ? (
              <span className="gd-heart" aria-hidden style={{ color: f.tint }}>
                <Heart size={20} fill={f.tint} strokeWidth={0} />
              </span>
            ) : (
              <Sparkle tint={f.tint} />
            )}
          </span>
        ))}

        {raining && (
          <div className="gd-rain" aria-hidden>
            {RAIN.map((d, i) => (
              <span key={i} className="gd-drop" style={{ left: `${d.x}%`, animationDuration: `${d.dur}s`, animationDelay: `${d.del}s` }} />
            ))}
          </div>
        )}

        <div className="gd-vignette" />

        {/* floating time-of-day chip */}
        <div
          className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm"
          style={{ background: 'color-mix(in srgb, var(--color-bg) 60%, transparent)', color: 'var(--color-text)', backdropFilter: 'blur(6px)' }}
        >
          <TimeIcon t={snap.world.timeOfDay} />
          <span className="capitalize">{snap.world.season}</span>
          <span style={{ color: 'var(--color-text-muted)' }}>· day {snap.world.day}</span>
        </div>

        {/* wordless invitation */}
        {onboard && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
            <div className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-base" style={{ background: 'color-mix(in srgb, var(--color-bg) 70%, transparent)', color: 'var(--color-text)', backdropFilter: 'blur(6px)' }}>
              <MousePointerClick size={17} aria-hidden /> Click a creature to meet it, or anywhere to plant a seed
            </div>
          </div>
        )}
      </div>

      {/* What the crew is working on right now */}
      <ProjectBanner snap={snap} />

      {/* Controls — big and friendly */}
      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <button type="button" className="gd-btn" onClick={sendRain}><CloudRain size={17} aria-hidden /> Send rain</button>
        <button type="button" className="gd-btn" onClick={() => { dismissOnboard(); act({ kind: 'seed' }); addFx('sparkle', 50, 74); }}><Sprout size={17} aria-hidden /> Plant a seed</button>
        <button type="button" className="gd-btn" onClick={() => setShowWhisper((s) => !s)}><MessageCircle size={17} aria-hidden /> Whisper</button>
        <button type="button" className="gd-btn" style={showGraph ? { borderColor: 'var(--color-accent)' } : undefined} onClick={() => setShowGraph((s) => !s)}><Share2 size={17} aria-hidden /> {showGraph ? 'Back to garden' : 'Who knows whom'}</button>
      </div>
      {showWhisper && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <input
            value={whisper}
            onChange={(e) => setWhisper(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && whisper.trim()) {
                act({ kind: 'whisper', text: whisper.trim() });
                setWhisper('');
                setShowWhisper(false);
              }
            }}
            maxLength={80}
            placeholder="say something to the garden, it will mull it over"
            className="min-w-0 flex-1 rounded-xl border bg-transparent px-3.5 py-2.5 text-base outline-none focus:border-[color:var(--color-accent)]"
            style={{ borderColor: 'var(--color-border-strong)', color: 'var(--color-text)' }}
          />
          <button
            type="button"
            className="rounded-xl px-4 py-2.5 text-base font-medium"
            style={{ background: 'var(--color-text)', color: 'var(--color-bg)' }}
            onClick={() => {
              if (whisper.trim()) {
                act({ kind: 'whisper', text: whisper.trim() });
                setWhisper('');
                setShowWhisper(false);
              }
            }}
          >
            Whisper →
          </button>
        </div>
      )}

      {/* Playful stat row */}
      <Counters snap={snap} />

      {showGraph && <Constellation snap={snap} />}

      {/* Transcript + selected creature */}
      <div className={'mt-6 grid gap-4 lg:grid-cols-2' + (showGraph ? ' hidden' : '')}>
        <div className="rounded-2xl border p-4" style={{ borderColor: 'var(--color-border)', background: 'rgba(255,255,255,0.015)' }}>
          <h2 className="text-sm font-medium uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
            What they're saying
          </h2>
          <ol ref={transcriptRef} className="mt-3 max-h-64 space-y-2 overflow-y-auto">
            {snap.recentMessages.length === 0 ? (
              <li className="text-base" style={{ color: 'var(--color-text-muted)' }}>The garden is quiet. Someone will speak soon.</li>
            ) : (
              snap.recentMessages.map((m) => (
                <li key={m.id} className="text-base leading-snug">
                  <b style={{ color: 'var(--color-accent)' }}>{agentName(m.agentId)}</b>{' '}
                  <span style={{ color: 'var(--color-text)' }}>{stripEmoji(m.text)}</span>
                </li>
              ))
            )}
          </ol>
        </div>
        {sel ? (
          <CreatureCard agent={sel} snap={snap} onClose={() => setSelected(null)} />
        ) : (
          <div className="grid place-items-center rounded-2xl border p-6 text-center" style={{ borderColor: 'var(--color-border)', background: 'rgba(255,255,255,0.015)' }}>
            <p className="text-base" style={{ color: 'var(--color-text-muted)' }}>Tap a creature in the garden to read its mind.</p>
          </div>
        )}
      </div>

      <EventFeed snap={snap} />
    </div>
  );
}

function Sparkle({ tint }: { tint: string }) {
  return (
    <>
      <span className="gd-ripple" style={{ borderColor: tint }} />
      {SPARK_DIRS.map((d, i) => (
        <span key={i} className="gd-spark" style={{ background: tint, ['--dx' as string]: `${d.x}px`, ['--dy' as string]: `${d.y}px` }} />
      ))}
    </>
  );
}

const SPARK_DIRS = Array.from({ length: 7 }, (_, i) => {
  const a = (i / 7) * Math.PI * 2;
  return { x: Math.round(Math.cos(a) * 22), y: Math.round(Math.sin(a) * 22) };
});
// Stable ambient layouts (no Math.random in render → no hydration drift).
const FLIES = Array.from({ length: 16 }, (_, i) => ({ x: (i * 61) % 100, y: (i * 37 + 8) % 60, dur: 7 + (i % 5) * 2, del: -(i % 7) }));
const RAIN = Array.from({ length: 26 }, (_, i) => ({ x: (i * 53) % 100, dur: 0.6 + (i % 4) * 0.12, del: (i % 9) * 0.12 }));

function TimeIcon({ t }: { t: number }) {
  const I = t < 0.2 || t > 0.85 ? Moon : t < 0.3 ? Sunrise : t < 0.7 ? Sun : Sunset;
  return <I size={16} aria-hidden />;
}

function Counters({ snap }: { snap: Snap }) {
  const cells: Array<{ icon: LucideIcon; label: string; value: number }> = [
    { icon: Users, label: 'creatures', value: snap.stats.population },
    { icon: Leaf, label: 'plants', value: snap.stats.plants },
    { icon: Heart, label: 'bonds', value: snap.stats.bonds },
    { icon: CalendarDays, label: 'day', value: snap.world.day },
  ];
  return (
    <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label} className="flex items-center gap-3 rounded-2xl border px-4 py-3" style={{ borderColor: 'var(--color-border)', background: 'rgba(255,255,255,0.015)' }}>
          <c.icon size={22} aria-hidden style={{ color: 'var(--color-text-muted)' }} />
          <div>
            <div className="font-display text-2xl font-medium leading-none tabular-nums" style={{ color: 'var(--color-text)' }}>{c.value}</div>
            <div className="mt-0.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>{c.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function CreatureCard({ agent, snap, onClose }: { agent: Agent; snap: Snap; onClose: () => void }) {
  const bonds = snap.relationships
    .filter((r) => r.a === agent.id || r.b === agent.id)
    .map((r) => ({ other: r.a === agent.id ? r.b : r.a, aff: r.affinity }))
    .sort((p, q) => q.aff - p.aff)
    .slice(0, 4);
  const name = (id: string) => snap.agents.find((a) => a.id === id)?.name ?? '?';
  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: creatureGlow(agent.id), background: `color-mix(in srgb, ${creatureGlow(agent.id)} 7%, transparent)` }}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Creature id={agent.id} size={52} />
          <div>
            <div className="font-display text-xl font-medium" style={{ color: 'var(--color-text)' }}>{agent.name}</div>
            <div className="text-sm capitalize" style={{ color: 'var(--color-text-muted)' }}>{agent.role} · feeling {agent.mood}</div>
          </div>
        </div>
        <button type="button" onClick={onClose} style={{ color: 'var(--color-text-muted)' }} aria-label="Close"><X size={18} /></button>
      </div>
      <p className="mt-3 text-base leading-snug" style={{ color: 'var(--color-text)' }}>{agent.persona}.</p>
      {agent.say && stripEmoji(agent.say) && <p className="mt-2 text-base" style={{ color: 'var(--color-text-muted)' }}>Right now: {stripEmoji(agent.say)}</p>}
      <div className="mt-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>{agent.option.note}</div>
      {bonds.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {bonds.map((b) => (
            <span key={b.other} className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}>
              {name(b.other)}
              {b.aff >= 0 ? <Heart size={13} aria-hidden /> : <Zap size={13} aria-hidden style={{ color: '#f0a0a0' }} />}
              {Math.abs(Math.round(b.aff))}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Constellation({ snap }: { snap: Snap }) {
  const agents = snap.agents.filter((a) => a.alive);
  const n = agents.length;
  const idx = new Map(agents.map((a, i) => [a.id, i]));
  const node = (i: number) => {
    const ang = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
    return { x: 50 + Math.cos(ang) * 36, y: 50 + Math.sin(ang) * 36 };
  };
  const edges = snap.relationships.filter((r) => idx.has(r.a) && idx.has(r.b) && Math.abs(r.affinity) >= 6);
  return (
    <div className="mt-5 rounded-2xl border p-4" style={{ borderColor: 'var(--color-border)', background: 'rgba(255,255,255,0.015)' }}>
      <h2 className="text-sm font-medium" style={{ color: 'var(--color-text-muted)' }}>Who knows whom · green is fondness, red is friction</h2>
      <div className="mx-auto mt-2 max-w-md">
        <svg viewBox="0 0 100 100" className="w-full" role="img" aria-label="A graph of the creatures' relationships.">
          {edges.map((r) => {
            const p = node(idx.get(r.a)!);
            const q = node(idx.get(r.b)!);
            return (
              <line key={`${r.a}-${r.b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={r.affinity >= 0 ? 'var(--color-accent)' : '#e06b6b'} strokeOpacity={0.18 + (Math.abs(r.affinity) / 100) * 0.6} strokeWidth={0.3 + (Math.abs(r.affinity) / 100) * 1.6} />
            );
          })}
          {agents.map((a, i) => {
            const p = node(i);
            return (
              <g key={a.id}>
                <circle cx={p.x} cy={p.y} r={4} fill={creatureGlow(a.id)} />
                <circle cx={p.x - 1.1} cy={p.y - 1.1} r={1.2} fill="#fff" opacity={0.85} />
                <text x={p.x} y={p.y + 8.5} textAnchor="middle" fontSize={3.2} fill="var(--color-text-muted)">{a.name}</text>
              </g>
            );
          })}
        </svg>
      </div>
      {edges.length === 0 && <p className="text-center text-base" style={{ color: 'var(--color-text-muted)' }}>No bonds yet. Give them time to meet.</p>}
    </div>
  );
}

const PROJECT_ICON: Record<ProjectKind, LucideIcon> = { grow: Trees, revive: HeartPulse, raise: Baby };
function ProjectBanner({ snap }: { snap: Snap }) {
  const pr = snap.project;
  if (!pr) {
    return (
      <div className="mt-4 rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: 'var(--color-border)', background: 'rgba(255,255,255,0.015)', color: 'var(--color-text-muted)' }}>
        The crew is between projects, looking for what to do next.
      </div>
    );
  }
  const I = PROJECT_ICON[pr.kind];
  const pct = Math.min(100, Math.round((pr.progress / pr.goal) * 100));
  const names = pr.crew.map((id) => snap.agents.find((a) => a.id === id)?.name).filter(Boolean).join(', ');
  return (
    <div className="mt-4 rounded-2xl border p-4" style={{ borderColor: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 7%, transparent)' }}>
      <div className="flex items-center gap-3">
        <I size={22} aria-hidden style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>The crew is working on</div>
          <div className="font-display text-lg font-medium" style={{ color: 'var(--color-text)' }}>{pr.title.charAt(0).toUpperCase() + pr.title.slice(1)}</div>
        </div>
        <span className="font-display text-xl font-medium tabular-nums" style={{ color: 'var(--color-text)' }}>{pct}%</span>
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--color-border)' }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--color-accent)', transition: 'width 0.6s ease-out' }} />
      </div>
      {names && <div className="mt-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>on it: {names}</div>}
    </div>
  );
}

const EVENT_ICON: Record<string, LucideIcon> = {
  born: Sparkles, met: Handshake, bonded: Heart, rift: Zap, bloom: Flower2, wilt: Leaf, died: Leaf, season: Wind, seed: Sprout, reflect: Lightbulb, note: Droplets,
};
function EventFeed({ snap }: { snap: Snap }) {
  if (!snap.events.length) return null;
  return (
    <section className="mt-10">
      <h2 className="text-sm font-medium uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>The garden's diary</h2>
      <ol className="mt-3 space-y-2.5">
        {snap.events.slice(0, 14).map((e) => {
          const I = EVENT_ICON[e.kind] ?? Droplets;
          return (
            <li key={e.id} className="flex items-start gap-2.5 text-base">
              <I size={17} aria-hidden style={{ marginTop: 3, color: 'var(--color-text-muted)', flexShrink: 0 }} />
              <span style={{ color: 'var(--color-text)' }}>{e.text}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
