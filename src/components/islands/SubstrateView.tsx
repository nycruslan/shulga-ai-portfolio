import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CREW, ROLE_BRIEF, STATIONS } from '../../lib/substrate/crew';
import { CONFIG } from '../../lib/substrate/types';
import type { Agent, SnapshotResponse, World } from '../../lib/substrate/types';

// THE SUBSTRATE — client. Polls the shared world (CDN-cached), eases agents
// between snapshots at 60fps, draws the vessel + relationship mesh on a canvas,
// and triggers a server tick when the world goes stale. The canvas is purely
// decorative; the vitals panel and ship's log are the accessible representation.

const STATION_MEANING: Record<string, string> = {
  HELM: 'orchestrator',
  MEMORY: 'hybrid RAG',
  ANALYSIS: 'reasoning',
  GATEWAY: 'MCP tools',
  FORGE: 'build · ship',
  EVAL: 'eval harness',
  AIRLOCK: 'quarantine',
};

const COLORS = {
  bg: '#08090a',
  hull: 'rgba(255,255,255,0.06)',
  station: 'rgba(255,255,255,0.14)',
  stationText: '#5e6469',
  accent: '#7af2a0',
  accentDim: '#3a8f58',
  warn: '#f5b14c',
  bad: '#f87171',
  idle: '#9aa0a8',
  text: '#e6e7e8',
};

type RenderAgent = { x: number; y: number; trail: Array<{ x: number; y: number }> };

function agentColor(a: Agent): string {
  if (a.status === 'quarantined') return COLORS.bad;
  if (a.status === 'restarting') return COLORS.warn;
  if (a.health < 55) return COLORS.warn;
  if (a.status === 'working') return COLORS.accent;
  return COLORS.idle;
}

export default function SubstrateView() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [snap, setSnap] = useState<SnapshotResponse | null>(null);
  const [labels, setLabels] = useState(true);
  const [notice, setNotice] = useState('');
  const [askAgent, setAskAgent] = useState<string>('helm');
  const [directive, setDirective] = useState('');
  const [question, setQuestion] = useState('');

  const reduced = useRef(false);
  const targetsRef = useRef<World | null>(null);
  const renderRef = useRef<Map<string, RenderAgent>>(new Map());
  const tickingRef = useRef(false);
  const lastTickTry = useRef(0);

  const world = snap && snap.configured ? snap.world : null;
  const configured = !snap || snap.configured;

  // ── Fetch + tick orchestration ──────────────────────────────────────────────
  const poll = useCallback(async () => {
    if (document.hidden) return; // sleep when unobserved
    try {
      const res = await fetch('/api/substrate/world.json', { cache: 'no-store' });
      const data: SnapshotResponse = await res.json();
      setSnap(data);
      if (data.configured) {
        targetsRef.current = data.world;
        // Trigger a tick if the world is stale — throttled locally; the server
        // lock dedupes across all watchers so cost stays bounded.
        const now = Date.now();
        if (
          data.staleMs > CONFIG.tickIntervalMs &&
          !tickingRef.current &&
          now - lastTickTry.current > 4000
        ) {
          tickingRef.current = true;
          lastTickTry.current = now;
          fetch('/api/substrate/tick', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
            .catch(() => {})
            .finally(() => {
              tickingRef.current = false;
            });
        }
      }
    } catch {
      /* transient — keep last snapshot */
    }
  }, []);

  useEffect(() => {
    reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    poll();
    const id = window.setInterval(poll, CONFIG.pollIntervalMs);
    const onVis = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [poll]);

  // ── Canvas render loop ───────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let w = 0;
    let h = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = stage.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(stage);

    const pad = 26;
    const toPx = (nx: number, ny: number) => ({ x: pad + nx * (w - pad * 2), y: pad + ny * (h - pad * 2) });

    const drawVessel = () => {
      ctx.clearRect(0, 0, w, h);
      // hull
      ctx.strokeStyle = COLORS.hull;
      ctx.lineWidth = 1;
      roundRect(ctx, 8, 8, w - 16, h - 16, 18);
      ctx.stroke();
      // faint internal dividers for the cross-section feel
      ctx.beginPath();
      ctx.moveTo(w * 0.5, 14);
      ctx.lineTo(w * 0.5, h - 14);
      ctx.moveTo(14, h * 0.66);
      ctx.lineTo(w - 14, h * 0.66);
      ctx.stroke();
      // stations
      for (const [name, v] of Object.entries(STATIONS)) {
        const p = toPx(v.x, v.y);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
        ctx.strokeStyle = name === 'AIRLOCK' ? 'rgba(248,113,113,0.25)' : COLORS.station;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = COLORS.stationText;
        ctx.font = '9px var(--font-mono, monospace)';
        ctx.textAlign = 'center';
        ctx.fillText(name, p.x, p.y - 22);
        if (labels) {
          ctx.fillStyle = 'rgba(94,100,105,0.7)';
          ctx.fillText(STATION_MEANING[name] ?? '', p.x, p.y + 30);
        }
      }
    };

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    const draw = () => {
      const world = targetsRef.current;
      drawVessel();
      if (!world) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const ease = reduced.current ? 1 : 0.12;
      const map = renderRef.current;

      // relationship mesh — the emergent org graph
      for (const e of world.edges) {
        const a = world.agents.find((x) => x.id === e.a);
        const b = world.agents.find((x) => x.id === e.b);
        if (!a || !b) continue;
        const ra = map.get(a.id);
        const rb = map.get(b.id);
        if (!ra || !rb) continue;
        ctx.beginPath();
        ctx.moveTo(ra.x, ra.y);
        ctx.lineTo(rb.x, rb.y);
        ctx.strokeStyle = `rgba(122,242,160,${0.04 + (e.trust / 100) * 0.14})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      const t = performance.now() / 1000;
      for (const a of world.agents) {
        const target = toPx(a.pos.x, a.pos.y);
        let r = map.get(a.id);
        if (!r) {
          r = { x: target.x, y: target.y, trail: [] };
          map.set(a.id, r);
        }
        r.x = lerp(r.x, target.x, ease);
        r.y = lerp(r.y, target.y, ease);
        if (!reduced.current) {
          r.trail.push({ x: r.x, y: r.y });
          if (r.trail.length > 14) r.trail.shift();
        }

        const color = agentColor(a);
        // trail
        if (!reduced.current && r.trail.length > 1) {
          ctx.beginPath();
          ctx.moveTo(r.trail[0].x, r.trail[0].y);
          for (const pt of r.trail) ctx.lineTo(pt.x, pt.y);
          ctx.strokeStyle = hexToRgba(color, 0.1);
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        // glow
        const pulse = a.status === 'working' && !reduced.current ? 1 + Math.sin(t * 3 + r.x) * 0.18 : 1;
        const grd = ctx.createRadialGradient(r.x, r.y, 0, r.x, r.y, 22 * pulse);
        grd.addColorStop(0, hexToRgba(color, 0.5));
        grd.addColorStop(1, hexToRgba(color, 0));
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 22 * pulse, 0, Math.PI * 2);
        ctx.fill();
        // core
        ctx.beginPath();
        ctx.arc(r.x, r.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        // label
        if (labels) {
          ctx.fillStyle = COLORS.text;
          ctx.font = '9px var(--font-mono, monospace)';
          ctx.textAlign = 'center';
          ctx.fillText(a.callsign, r.x, r.y + 18);
        }
        // speech
        if (a.say) {
          drawBubble(ctx, r.x, r.y - 16, a.say);
        }
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [labels]);

  // ── Interaction ──────────────────────────────────────────────────────────────
  const act = useCallback(
    async (body: Record<string, unknown>, ok: string) => {
      try {
        const res = await fetch('/api/substrate/interact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        setNotice(res.ok ? ok : data.error || 'Something went wrong.');
      } catch {
        setNotice('Network hiccup. Try again.');
      }
      setTimeout(() => setNotice(''), 4000);
    },
    []
  );

  const agentsSorted = useMemo(
    () => (world ? [...world.agents] : []),
    [world]
  );

  if (!configured) {
    return (
      <div className="rounded-2xl border p-10 text-center" style={{ borderColor: 'var(--color-border)' }}>
        <p className="font-mono text-sm" style={{ color: 'var(--color-text-muted)' }}>
          The Substrate is dormant. The shared world wakes when its datastore is connected.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Stage */}
        <div
          ref={stageRef}
          className="relative aspect-[16/11] overflow-hidden rounded-2xl border"
          style={{ borderColor: 'var(--color-border)', background: 'radial-gradient(120% 90% at 50% 0%, rgba(122,242,160,0.04), transparent 60%), var(--color-bg)' }}
        >
          <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0" />
          {/* HUD */}
          <div className="pointer-events-none absolute left-4 top-4 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px]" style={{ color: 'var(--color-text-subtle)' }}>
            <span>tick <b style={{ color: 'var(--color-text)' }}>{world?.tick ?? 0}</b></span>
            <span>integrity <b style={{ color: (world?.integrity ?? 100) > 70 ? 'var(--color-accent)' : COLORS.warn }}>{Math.round(world?.integrity ?? 100)}%</b></span>
            <span>shipped <b style={{ color: 'var(--color-text)' }}>{world?.stats.completed ?? 0}</b></span>
            <span>failed <b style={{ color: 'var(--color-text)' }}>{world?.stats.failed ?? 0}</b></span>
            <span>quarantines <b style={{ color: 'var(--color-text)' }}>{world?.stats.quarantines ?? 0}</b></span>
          </div>
          <button
            type="button"
            onClick={() => setLabels((v) => !v)}
            className="absolute right-3 top-3 rounded-md border px-2 py-1 font-mono text-[10px] transition-colors hover:[color:var(--color-text)]"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-subtle)' }}
          >
            {labels ? 'hide labels' : 'show labels'}
          </button>
          {world?.directive && (
            <div className="absolute bottom-3 left-4 right-4 truncate font-mono text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
              directive: <span style={{ color: 'var(--color-text)' }}>{world.directive}</span>
            </div>
          )}
          <p className="sr-only">
            Live agent crew. {world?.agents.filter((a) => a.status === 'working').length ?? 0} working,
            {' '}{world?.agents.filter((a) => a.status === 'quarantined').length ?? 0} quarantined. Integrity {Math.round(world?.integrity ?? 100)} percent.
          </p>
        </div>

        {/* Vitals + log */}
        <aside className="flex flex-col gap-4">
          <div className="rounded-2xl border p-4" style={{ borderColor: 'var(--color-border)' }}>
            <div className="mb-3 font-mono text-[11px] uppercase tracking-wider" style={{ color: 'var(--color-text-subtle)' }}>Crew vitals</div>
            <ul className="space-y-2">
              {agentsSorted.map((a) => (
                <li key={a.id} className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="inline-block size-1.5 shrink-0 rounded-full" style={{ background: agentColor(a) }} />
                  <span className="w-16 shrink-0" style={{ color: 'var(--color-text)' }}>{a.callsign}</span>
                  <span className="h-1 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--color-border)' }}>
                    <span className="block h-full rounded-full" style={{ width: `${Math.round(a.health)}%`, background: agentColor(a) }} />
                  </span>
                  <span className="w-16 shrink-0 text-right" style={{ color: 'var(--color-text-subtle)' }}>{a.status}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="min-h-0 flex-1 rounded-2xl border p-4" style={{ borderColor: 'var(--color-border)' }}>
            <div className="mb-3 font-mono text-[11px] uppercase tracking-wider" style={{ color: 'var(--color-text-subtle)' }}>Ship's log</div>
            <ul className="max-h-64 space-y-1.5 overflow-auto themed-scroll font-mono text-[11px] leading-relaxed">
              {(world?.log ?? []).slice(0, 18).map((l, i) => (
                <li key={`${l.tick}-${i}`} style={{ color: i === 0 ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
                  <span style={{ color: logColor(l.kind) }}>{l.kind}</span> · {l.text}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      {/* Interaction */}
      <div className="mt-4 grid gap-3 rounded-2xl border p-4 md:grid-cols-3" style={{ borderColor: 'var(--color-border)' }}>
        <div>
          <div className="mb-2 font-mono text-[11px] uppercase tracking-wider" style={{ color: 'var(--color-text-subtle)' }}>Perturb</div>
          <button
            type="button"
            onClick={() => act({ kind: 'anomaly' }, 'Anomaly injected. Watch the crew contain it.')}
            className="w-full rounded-lg border px-3 py-2 font-mono text-xs transition-colors hover:[color:var(--color-text)]"
            style={{ borderColor: 'var(--color-border-strong)', color: 'var(--color-text-muted)' }}
          >
            ⚠ inject anomaly
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!directive.trim()) return;
            act({ kind: 'directive', text: directive.trim() }, 'Directive queued. HELM will distribute it.');
            setDirective('');
          }}
        >
          <div className="mb-2 font-mono text-[11px] uppercase tracking-wider" style={{ color: 'var(--color-text-subtle)' }}>Set directive</div>
          <input
            name="directive"
            value={directive}
            onChange={(e) => setDirective(e.target.value)}
            maxLength={120}
            placeholder="e.g. prioritize the backlog"
            className="w-full rounded-lg border bg-white/[0.03] px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-text/40"
            style={{ borderColor: 'var(--color-border-strong)', color: 'var(--color-text)' }}
          />
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!question.trim()) return;
            act({ kind: 'question', agentId: askAgent, text: question.trim() }, 'Question queued. The officer answers next tick.');
            setQuestion('');
          }}
        >
          <div className="mb-2 font-mono text-[11px] uppercase tracking-wider" style={{ color: 'var(--color-text-subtle)' }}>Ask an officer</div>
          <div className="flex gap-2">
            <select
              name="officer"
              value={askAgent}
              onChange={(e) => setAskAgent(e.target.value)}
              aria-label="Officer"
              className="rounded-lg border bg-white/[0.03] px-2 py-2 font-mono text-xs outline-none"
              style={{ borderColor: 'var(--color-border-strong)', color: 'var(--color-text)' }}
            >
              {CREW.map((c) => (
                <option key={c.id} value={c.id}>{c.callsign}</option>
              ))}
            </select>
            <input
              name="question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={160}
              placeholder="ask…"
              className="w-full rounded-lg border bg-white/[0.03] px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-text/40"
              style={{ borderColor: 'var(--color-border-strong)', color: 'var(--color-text)' }}
            />
          </div>
        </form>
      </div>
      <p className="mt-2 min-h-[1.25rem] font-mono text-[11px]" aria-live="polite" style={{ color: 'var(--color-accent)' }}>
        {notice}
      </p>
      <p className="mt-1 font-mono text-[11px]" style={{ color: 'var(--color-text-subtle)' }}>
        Roles: {CREW.map((c) => `${c.callsign} ${ROLE_BRIEF[c.role].toLowerCase().replace(/\.$/, '')}`).slice(0, 3).join(' · ')} … and more.
      </p>
    </div>
  );
}

// ── canvas helpers ────────────────────────────────────────────────────────────
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
  const t = text.length > 30 ? text.slice(0, 29) + '…' : text;
  ctx.font = '10px var(--font-mono, monospace)';
  const tw = ctx.measureText(t).width;
  const pad = 6;
  const bw = tw + pad * 2;
  const bh = 18;
  const bx = x - bw / 2;
  const by = y - bh - 6;
  ctx.fillStyle = 'rgba(14,16,17,0.92)';
  ctx.strokeStyle = 'rgba(122,242,160,0.25)';
  ctx.lineWidth = 1;
  roundRect(ctx, bx, by, bw, bh, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#cdd2d8';
  ctx.textAlign = 'center';
  ctx.fillText(t, x, by + 12);
}

function hexToRgba(hex: string, alpha: number): string {
  if (hex.startsWith('rgb')) return hex;
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function logColor(kind: string): string {
  if (kind === 'done') return COLORS.accent;
  if (kind === 'failed' || kind === 'quarantine' || kind === 'anomaly') return COLORS.bad;
  if (kind === 'restore' || kind === 'retry') return COLORS.warn;
  if (kind === 'directive' || kind === 'ask') return '#8a8f98';
  return '#5e6469';
}
