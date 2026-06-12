// Generative SVG creatures and plants for the Garden. Each is drawn from its id:
// djb2 hash → mulberry32 PRNG → deterministic parameters. So every creature the
// society ever raises gets its own unique-but-cohesive look automatically,
// consistent on every device, and built to come alive with CSS (it breathes,
// blinks, drifts). The aesthetic is elegant, not cute: luminous garden spirits, a
// softly-glowing translucent body in a muted jewel hue, small calm eyes, and a
// few delicate filaments with glowing tips, like something bioluminescent. Plants
// share the same DNA so the whole world reads as one designed thing.
//
// Pure functions of the id, so server and client render identically (no
// hydration drift), and nothing here uses Math.random.

function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
  return h >>> 0;
}
function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rngFor = (id: string) => mulberry32(djb2(id));

// A smooth closed blob: n points around a circle with jittered radii, joined with
// a Catmull-Rom spline expressed as cubic béziers.
function blobPath(rng: () => number, n: number, R: number, yScale: number): string {
  const p: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = R * (0.86 + rng() * 0.14);
    p.push([Math.cos(a) * rr, Math.sin(a) * rr * yScale]);
  }
  const f = (x: number) => x.toFixed(1);
  let d = `M${f(p[0][0])},${f(p[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n];
    const p1 = p[i];
    const p2 = p[(i + 1) % n];
    const p3 = p[(i + 2) % n];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])}`;
  }
  return d + 'Z';
}

const LEAF = 'M0,0C-0.5,-0.45 -0.32,-1 0,-1C0.32,-1 0.5,-0.45 0,0Z';

// Muted, slightly desaturated jewel hues that glow quietly on near-black.
const HUES = [158, 184, 205, 250, 286, 330, 42];

export function creatureGlow(id: string): string {
  const r = rngFor(id);
  return `hsl(${HUES[Math.floor(r() * HUES.length)]} 48% 56%)`;
}

type Filament = { x0: number; cx: number; cy: number; tx: number; ty: number };
type CreatureParams = {
  hue: number;
  body: string;
  bodyTop: number;
  eyeR: number;
  eyeSx: number;
  eyeY: number;
  filaments: Filament[];
  delay: number;
};

function creatureParams(id: string): CreatureParams {
  const r = rngFor(id);
  const hue = HUES[Math.floor(r() * HUES.length)];
  const n = 6 + Math.floor(r() * 3);
  const yScale = 1.0 + r() * 0.24; // a touch taller than wide — more spirit, less ball
  const R = 36;
  const body = blobPath(r, n, R, yScale);
  const bodyTop = -R * yScale * 0.86;
  const eyeR = 4.4 + r() * 1.6; // small and calm
  const eyeSx = 8.5 + r() * 4;
  const eyeY = 2 + r() * 5;
  const count = 1 + Math.floor(r() * 3);
  const filaments: Filament[] = Array.from({ length: count }, (_, i) => {
    const side = count === 1 ? (r() - 0.5) * 0.6 : (i / (count - 1) - 0.5) * 1.8;
    const len = 20 + r() * 16;
    const x0 = side * 8;
    const tx = side * (10 + r() * 8);
    const ty = bodyTop - len;
    return { x0, cx: x0 + side * 6, cy: bodyTop - len * 0.5, tx, ty };
  });
  return { hue, body, bodyTop, eyeR, eyeSx, eyeY, filaments, delay: -(r() * 5) };
}

export function Creature({ id, size = 76 }: { id: string; size?: number }) {
  const p = creatureParams(id);
  const gid = `cg-${id}`;
  const core = `hsl(${p.hue} 42% 66%)`;
  const edge = `hsl(${p.hue} 44% 38%)`;
  const glow = `hsl(${p.hue} 52% 54%)`;
  const tip = `hsl(${p.hue} 62% 68%)`;
  const eyes: number[] = [-p.eyeSx, p.eyeSx];
  return (
    <svg
      className="cr-svg"
      width={size}
      height={size * 1.18}
      viewBox="-58 -76 116 140"
      style={{ ['--d' as string]: `${p.delay}s`, filter: `drop-shadow(0 2px 10px ${glow})`, overflow: 'visible' }}
      aria-hidden
    >
      <defs>
        <radialGradient id={gid} cx="42%" cy="30%" r="80%">
          <stop offset="0%" stopColor={core} />
          <stop offset="100%" stopColor={edge} />
        </radialGradient>
      </defs>
      <g className="cr-body">
        {/* filaments, behind the body */}
        <g className="cr-fil">
          {p.filaments.map((fl, i) => (
            <g key={i}>
              <path d={`M${fl.x0},${p.bodyTop} Q${fl.cx},${fl.cy} ${fl.tx},${fl.ty}`} stroke={glow} strokeWidth={1.4} fill="none" strokeLinecap="round" opacity={0.7} />
              <circle cx={fl.tx} cy={fl.ty} r={2.1} fill={tip} />
            </g>
          ))}
        </g>
        <path d={p.body} fill={`url(#${gid})`} fillOpacity={0.94} />
        {/* a soft inner sheen for translucency */}
        <ellipse cx={-6} cy={p.bodyTop * 0.45} rx={14} ry={9} fill="#ffffff" opacity={0.08} />
        <g className="cr-eyes">
          {eyes.map((ex, i) => (
            <g key={i}>
              <ellipse cx={ex} cy={p.eyeY} rx={p.eyeR} ry={p.eyeR * 1.25} fill="#11151c" />
              <circle cx={ex - p.eyeR * 0.3} cy={p.eyeY - p.eyeR * 0.45} r={p.eyeR * 0.34} fill="#fff" opacity={0.92} />
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}

// ── Plants: the same DNA, fewer parts ─────────────────────────────────────────
type PlantParams = { lean: number; leaves: { y: number; rot: number; s: number }[]; bud: boolean; budHue: number; hue: number; delay: number };
function plantParams(id: string): PlantParams {
  const r = rngFor(id);
  const lean = (r() - 0.5) * 16;
  const count = 1 + Math.floor(r() * 3);
  const leaves = Array.from({ length: count }, (_, i) => ({
    y: -16 - i * 13 - r() * 4,
    rot: (i % 2 === 0 ? 1 : -1) * (30 + r() * 22),
    s: 11 - i * 1.4,
  }));
  return { lean, leaves, bud: r() < 0.4, budHue: HUES[Math.floor(r() * HUES.length)], hue: 150 + r() * 22, delay: -(r() * 6) };
}

export function Plant({ id, growth, health }: { id: string; growth: number; health: number }) {
  const p = plantParams(id);
  const scale = 0.55 + (growth / 100) * 0.85;
  const w = Math.round(40 * scale);
  const stem = `hsl(${p.hue} 38% ${34 + (health / 100) * 14}%)`;
  const leaf = `hsl(${p.hue} 44% ${42 + (health / 100) * 14}%)`;
  const topY = Math.min(...p.leaves.map((l) => l.y), -16) - 6;
  return (
    <svg width={w} height={w * 1.5} viewBox="-22 -64 44 70" style={{ ['--d' as string]: `${p.delay}s`, overflow: 'visible' }} aria-hidden>
      <g className="cr-sway">
        <path d={`M0,2 Q${p.lean * 0.3},${topY / 2} ${p.lean},${topY}`} stroke={stem} strokeWidth={3} fill="none" strokeLinecap="round" />
        {p.leaves.map((l, i) => (
          <path key={i} d={LEAF} transform={`translate(${p.lean * (l.y / topY)} ${l.y}) rotate(${l.rot}) scale(${l.s})`} fill={leaf} />
        ))}
        {p.bud && <circle cx={p.lean} cy={topY} r={4} fill={`hsl(${p.budHue} 50% 62%)`} />}
      </g>
    </svg>
  );
}
