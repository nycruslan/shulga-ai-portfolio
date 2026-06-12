import type { Agent, GardenEvent, GardenInteraction, GardenState, Memory, Plant, Project, ProjectKind, Season, Vec } from './types';
import { GARDEN_CONFIG } from './types';

// The deterministic ecosystem. Runs free on every tick: the clock turns, plants
// grow and wilt, agents age, move, spend energy, and choose what to do next by
// cheap rules. It also detects when two agents meet and opens a conversation
// shell. It never calls an LLM. The society layer (society.ts) spends the single
// per-tick Haiku call filling conversation turns with words.

const C = GARDEN_CONFIG;
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const clamp01 = (n: number) => Math.max(0.04, Math.min(0.96, n));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const irand = (lo: number, hi: number) => Math.floor(rand(lo, hi + 1));
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
const SEASONS: Season[] = ['spring', 'summer', 'fall', 'winter'];

function nextId(state: GardenState): number {
  return state.seq++;
}

export function addEvent(state: GardenState, kind: GardenEvent['kind'], text: string, agentId: string | null = null) {
  state.events.unshift({ id: nextId(state), tick: state.world.tick, kind, text, agentId });
  if (state.events.length > C.eventCap) state.events.length = C.eventCap;
}

export function addMemory(state: GardenState, agentId: string, kind: Memory['kind'], text: string, importance: number) {
  state.memories.push({
    id: `m${nextId(state)}`,
    agentId,
    kind,
    text,
    importance: clamp(importance, 1, 10),
    createdTick: state.world.tick,
    lastAccessTick: state.world.tick,
  });
  // Cap per agent (cheap version of summarize-and-forget; real version in phase 3).
  const mine = state.memories.filter((m) => m.agentId === agentId);
  if (mine.length > C.memoryCap) {
    const drop = mine
      .slice()
      .sort((a, b) => a.importance - b.importance || a.createdTick - b.createdTick)
      .slice(0, mine.length - C.memoryCap)
      .map((m) => m.id);
    state.memories = state.memories.filter((m) => !drop.includes(m.id));
  }
}

const byId = (state: GardenState, id: string) => state.agents.find((a) => a.id === id);

export function speak(agent: Agent, emoji: string, text: string, ttl = 3) {
  agent.say = `${emoji} ${text}`.trim();
  agent.sayTtl = ttl;
}

function relationship(state: GardenState, a: string, b: string) {
  const [x, y] = [a, b].sort();
  let r = state.relationships.find((e) => e.a === x && e.b === y);
  if (!r) {
    r = { a: x, b: y, affinity: 0, note: '' };
    state.relationships.push(r);
  }
  return r;
}

export function bumpAffinity(state: GardenState, a: string, b: string, delta: number, note: string) {
  const r = relationship(state, a, b);
  const before = r.affinity;
  r.affinity = clamp(r.affinity + delta, -100, 100);
  if (note) r.note = note;
  const A = byId(state, a);
  const B = byId(state, b);
  if (A && B) {
    if (before < 45 && r.affinity >= 45) addEvent(state, 'bonded', `${A.name} and ${B.name} have grown close.`, a);
    if (before > -35 && r.affinity <= -35) addEvent(state, 'rift', `${A.name} and ${B.name} are at odds.`, a);
  }
}

// ── Plants ────────────────────────────────────────────────────────────────────
function growPlants(state: GardenState) {
  const w = state.world;
  const seasonGrow = w.season === 'spring' ? 1.3 : w.season === 'summer' ? 1.0 : w.season === 'fall' ? 0.5 : 0.15;
  const daylight = Math.max(0, Math.sin(w.timeOfDay * Math.PI)); // 0 at night, 1 at noon
  for (const p of state.plants) {
    p.age += 1;
    const watered = w.water > 25;
    if (watered && p.health > 35) p.growth = clamp(p.growth + rand(0.6, 1.8) * seasonGrow * (0.4 + daylight));
    // Health drifts with conditions. Dryness hurts, but gently, so an unattended
    // garden frays rather than collapses.
    p.health = clamp(p.health + (watered ? rand(-0.3, 0.9) : rand(-1.3, -0.3)) + (w.season === 'winter' ? -0.4 : 0));
    if (p.growth >= 100 && p.health > 40 && Math.random() < 0.06) {
      p.growth = 60;
      addEvent(state, 'bloom', `A plant at ${bedLabel(state, p.bedId)} burst into bloom.`);
      // A bloom can drop a seedling nearby.
      if (state.plants.length < 60 && Math.random() < 0.5) spawnPlant(state, p.bedId, p.pos);
    }
  }
  // Wilting / death.
  for (const p of state.plants) {
    if (p.health <= 14 && Math.random() < 0.12) addEvent(state, 'wilt', `A plant at ${bedLabel(state, p.bedId)} is wilting.`);
  }
  const before = state.plants.length;
  state.plants = state.plants.filter((p) => p.health > 1);
  if (state.plants.length < before) addEvent(state, 'wilt', `${before - state.plants.length} plant(s) returned to the soil.`);

  // A thin garden recovers on its own: volunteer seedlings drift in and take root,
  // so it can never stay barren.
  if (state.plants.length < 6 && Math.random() < 0.2) {
    const bed = pick(state.beds);
    spawnPlant(state, bed.id, bed.pos);
    addEvent(state, 'seed', 'A volunteer seedling takes root.');
  }

  // Weather. Rain passes over now and then (more in the growing seasons), so the
  // garden waters itself and stays alive with no visitors at all. Water also
  // drains with the garden's size and seeps back slowly, settling at a healthy
  // band rather than depleting to nothing.
  const rainChance = w.season === 'spring' ? 0.06 : w.season === 'summer' ? 0.045 : w.season === 'fall' ? 0.03 : 0.02;
  if (Math.random() < rainChance) {
    w.water = clamp(w.water + rand(8, 16));
    if (w.water < 50 && Math.random() < 0.5) addEvent(state, 'note', 'Rain drums softly on the leaves.');
  }
  w.water = clamp(w.water - state.plants.length * 0.035 + 0.4);
}

function bedLabel(state: GardenState, bedId: string) {
  return state.beds.find((b) => b.id === bedId)?.label ?? 'the garden';
}

function spawnPlant(state: GardenState, bedId: string, near: Vec) {
  const bed = state.beds.find((b) => b.id === bedId);
  const base = bed ? bed.pos : near;
  state.plants.push({
    id: `p${nextId(state)}`,
    bedId,
    pos: { x: clamp01(base.x + rand(-0.07, 0.07)), y: clamp01(base.y + rand(-0.07, 0.07)) },
    glyph: pick(['🌱', '🌿', '☘️', '🌾']),
    growth: 6,
    health: 70,
    age: 0,
  });
}

// ── Agent options (cheap, deterministic choice) ───────────────────────────────
function nearestPlant(state: GardenState, pos: Vec, predicate: (p: Plant) => boolean): Plant | null {
  let best: Plant | null = null;
  let bestD = Infinity;
  for (const p of state.plants) {
    if (!predicate(p)) continue;
    const d = dist(pos, p.pos);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function chooseOption(state: GardenState, a: Agent) {
  const tick = state.world.tick;
  const dur = irand(C.optionMinTicks, C.optionMaxTicks);
  const expires = tick + dur;

  if (a.energy < 28) {
    a.option = { kind: 'rest', targetId: null, target: { ...a.pos }, expiresTick: expires, note: 'resting in the shade' };
    a.mood = 'weary';
    return;
  }

  if (a.role === 'gardener' || a.role === 'keeper') {
    const ailing = nearestPlant(state, a.pos, (p) => p.health < 65 || p.growth < 40);
    if (ailing && Math.random() < 0.8) {
      a.option = { kind: 'tend', targetId: ailing.id, target: { ...ailing.pos }, expiresTick: expires, note: `tending ${bedLabel(state, ailing.bedId)}` };
      a.mood = 'attentive';
      return;
    }
  }

  if (a.role === 'forager' && Math.random() < 0.7) {
    const bed = pick(state.beds);
    a.option = { kind: 'forage', targetId: null, target: { x: clamp01(bed.pos.x + rand(-0.1, 0.1)), y: clamp01(bed.pos.y + rand(-0.1, 0.1)) }, expiresTick: expires, note: `foraging near ${bed.label}` };
    a.mood = 'searching';
    return;
  }

  // Default: wander somewhere new.
  a.option = { kind: 'wander', targetId: null, target: { x: clamp01(rand(0.1, 0.9)), y: clamp01(rand(0.1, 0.9)) }, expiresTick: expires, note: 'wandering the garden' };
  a.mood = pick(['easy', 'thoughtful', 'curious', 'content']);
}

function stepAgent(state: GardenState, a: Agent) {
  a.age += 1;
  if (a.talkCooldown > 0) a.talkCooldown -= 1;
  if (a.sayTtl > 0) {
    a.sayTtl -= 1;
    if (a.sayTtl === 0) a.say = null;
  }

  const inConversation = state.conversations.some((c) => c.status === 'open' && c.participants.includes(a.id));
  // While talking, the agent holds position; the society layer drives its words.
  if (inConversation) {
    a.energy = clamp(a.energy - 0.2);
    return;
  }

  // Energy by activity.
  if (a.option.kind === 'rest') a.energy = clamp(a.energy + rand(2, 4));
  else if (a.option.kind === 'tend') a.energy = clamp(a.energy - rand(0.6, 1.4));
  else a.energy = clamp(a.energy - rand(0.3, 1.0));
  a.energy = Math.max(6, a.energy); // no death in phase 1

  // Move toward the option target by easing a fixed fraction each tick.
  if (a.option.target && a.option.kind !== 'rest') {
    a.pos = {
      x: clamp01(a.pos.x + (a.option.target.x - a.pos.x) * 0.22),
      y: clamp01(a.pos.y + (a.option.target.y - a.pos.y) * 0.22),
    };
  }

  // Tending heals the targeted plant.
  if (a.option.kind === 'tend' && a.option.targetId) {
    const p = state.plants.find((x) => x.id === a.option.targetId);
    if (p && dist(a.pos, p.pos) < 0.06) {
      p.health = clamp(p.health + rand(1.5, 3.5));
      p.growth = clamp(p.growth + rand(0.5, 1.5));
    }
  }

  // Crew members are steered by the project; everyone else picks their own way.
  const managed = state.project?.crew.includes(a.id) ?? false;
  if (!managed && (state.world.tick >= a.option.expiresTick || (a.option.target && dist(a.pos, a.option.target) < 0.02 && a.option.kind !== 'rest'))) {
    chooseOption(state, a);
    if (a.sayTtl <= 0 && Math.random() < 0.55) statusSay(a);
  }
}

// ── Meetings → conversation shells ────────────────────────────────────────────
function openConversations(state: GardenState): number {
  return state.conversations.filter((c) => c.status === 'open').length;
}

function detectMeetings(state: GardenState) {
  if (openConversations(state) >= C.maxOpenConversations) return;
  const free = state.agents.filter(
    (a) =>
      a.alive &&
      a.talkCooldown === 0 &&
      !(state.project?.crew.includes(a.id) ?? false) &&
      !state.conversations.some((c) => c.status === 'open' && c.participants.includes(a.id))
  );
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      const a = free[i];
      const b = free[j];
      if (dist(a.pos, b.pos) <= C.proximity) {
        const mid = { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 };
        const topic = meetingTopic(state, a, b);
        state.conversations.push({
          id: `c${nextId(state)}`,
          kind: 'chat',
          topic,
          participants: [a.id, b.id],
          turnCount: 0,
          maxTurns: C.convMaxTurns,
          status: 'open',
          openedTick: state.world.tick,
          lastTurnTick: state.world.tick - 1,
          pos: mid,
        });
        // Both stop and face each other.
        for (const who of [a, b]) {
          who.option = { kind: 'talk', targetId: who === a ? b.id : a.id, target: { ...mid }, expiresTick: state.world.tick + C.convMaxTurns + 2, note: `talking with ${(who === a ? b : a).name}` };
        }
        addEvent(state, 'met', `${a.name} and ${b.name} stopped to talk.`, a.id);
        return; // at most one new meeting per tick
      }
    }
  }
}

// ── Group decisions: a failing bed convenes the gardeners ─────────────────────
function bedHealth(state: GardenState, bedId: string): { avg: number; count: number } {
  const ps = state.plants.filter((p) => p.bedId === bedId);
  if (!ps.length) return { avg: 100, count: 0 };
  return { avg: ps.reduce((s, p) => s + p.health, 0) / ps.length, count: ps.length };
}

// ── Births: two close creatures raise a new one ───────────────────────────────
export function eligibleBirthPair(state: GardenState): [Agent, Agent] | null {
  if (state.agents.filter((a) => a.alive).length >= C.maxAgents) return null;
  const ranked = [...state.relationships].sort((p, q) => q.affinity - p.affinity);
  for (const r of ranked) {
    if (r.affinity < C.birthAffinity) break;
    const a = byId(state, r.a);
    const b = byId(state, r.b);
    if (!a || !b || !a.alive || !b.alive) continue;
    if (a.energy < C.birthEnergy || b.energy < C.birthEnergy) continue;
    if (a.age < C.birthCooldownTicks || b.age < C.birthCooldownTicks) continue;
    if (state.conversations.some((c) => c.status === 'open' && (c.participants.includes(a.id) || c.participants.includes(b.id)))) continue;
    return [a, b];
  }
  return null;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'sprout';

export function createChild(state: GardenState, a: Agent, b: Agent, persona: { name: string; glyph: string; role: Agent['role']; persona: string }): Agent {
  let id = slugify(persona.name);
  if (state.agents.some((x) => x.id === id)) id = `${id}-${nextId(state)}`;
  const mid = { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 };
  const child: Agent = {
    id,
    name: persona.name.slice(0, 18),
    glyph: persona.glyph.slice(0, 4) || '🌟',
    role: persona.role,
    persona: persona.persona.slice(0, 120),
    pos: { x: clamp01(mid.x + rand(-0.04, 0.04)), y: clamp01(mid.y + rand(-0.04, 0.04)) },
    energy: 72,
    age: 0,
    mood: 'newborn',
    option: { kind: 'wander', targetId: null, target: { x: clamp01(mid.x), y: clamp01(mid.y) }, expiresTick: state.world.tick + 3, note: 'blinking at the world' },
    say: 'oh, hello',
    sayTtl: 5,
    generation: Math.max(a.generation, b.generation) + 1,
    parents: [a.id, b.id],
    bornTick: state.world.tick,
    alive: true,
    talkCooldown: 5,
    lastReflectTick: state.world.tick,
  };
  state.agents.push(child);
  a.energy = clamp(a.energy - C.birthEnergyCost);
  b.energy = clamp(b.energy - C.birthEnergyCost);
  addMemory(state, child.id, 'observe', `I woke in the soil between ${a.name} and ${b.name}.`, 9);
  addMemory(state, a.id, 'observe', `${child.name} came into the world. I helped raise them.`, 8);
  addMemory(state, b.id, 'observe', `${child.name} came into the world. I helped raise them.`, 8);
  bumpAffinity(state, child.id, a.id, 35, 'my parent');
  bumpAffinity(state, child.id, b.id, 35, 'my parent');
  addEvent(state, 'born', `${child.name} (${child.glyph}) was raised by ${a.name} and ${b.name}.`, child.id);
  return child;
}

function meetingTopic(state: GardenState, a: Agent, b: Agent): string {
  const w = state.world;
  const time = w.timeOfDay < 0.25 ? 'before dawn' : w.timeOfDay < 0.5 ? 'in the morning' : w.timeOfDay < 0.75 ? 'in the afternoon' : 'at dusk';
  const nearPlant = nearestPlant(state, a.pos, () => true);
  const where = nearPlant ? bedLabel(state, nearPlant.bedId) : 'the garden';
  return `${a.name} and ${b.name} cross paths near ${where}, ${time} in ${w.season}`;
}

// A conversation that hasn't advanced in a while (e.g. the model budget is spent
// for the day) is closed so its creatures never freeze mid-talk; they part and
// move on. The rich close (memories, bonds) happens in society.ts when the model
// is available; this is just the safety release.
function closeStaleConversations(state: GardenState) {
  const tick = state.world.tick;
  let changed = false;
  for (const c of state.conversations) {
    if (c.status !== 'open' || tick - c.lastTurnTick <= 5) continue;
    changed = true;
    for (const id of c.participants) {
      const a = byId(state, id);
      if (!a) continue;
      a.talkCooldown = C.talkCooldownTicks;
      a.option = { kind: 'wander', targetId: null, target: { x: clamp01(a.pos.x + (Math.random() - 0.5) * 0.3), y: clamp01(a.pos.y + (Math.random() - 0.5) * 0.3) }, expiresTick: tick + 1, note: 'drifting off' };
    }
  }
  if (changed) state.conversations = state.conversations.filter((c) => c.status === 'open' && tick - c.lastTurnTick <= 5);
}

// ── The crew: one shared mission at a time ────────────────────────────────────
// The crew picks a goal, gathers at the site, works it together (free, templated
// chatter so the garden is always busy), and on completion visibly changes the
// world. Meanwhile the creatures not on the job wander and have real conversations.

const STATUS: Record<string, string[]> = {
  tend: ['tucking in the seedlings', 'coaxing the roots along', 'patting down the soil', 'fussing over a sprout'],
  forage: ['sniffing out something good', 'hunting for ripe seeds', 'gathering what fell'],
  rest: ['catching a breath', 'watching the light move', 'a quiet moment in the shade'],
  wander: ['following the breeze', 'taking the long way round', 'lost in a small thought'],
};
const CREW_LINE: Record<ProjectKind, string[]> = {
  grow: ['this grove is coming along', 'one more sprout here', 'give it room to reach the light', 'good soil, good roots'],
  revive: ['steady, it will hold', 'more water on the dry side', 'we can save this bed', 'careful with the weak ones'],
  raise: ['gather close, it is almost time', 'pour your warmth in', 'something new is stirring', 'hold the circle'],
};
const CHILD_NAMES = ['Vesper', 'Tarn', 'Wisp', 'Cinder', 'Brook', 'Hazel', 'Sorrel', 'Lumen', 'Fennel', 'Briar', 'Reed', 'Aspen', 'Cress', 'Mlint', 'Dewy', 'Pim'];
const CHILD_PERSONA = ['quiet and watchful', 'quick and bright, always first to the work', 'tender with the smallest things', 'bold, drawn to the far corners', 'a slow dreamer who speaks rarely', 'warm, gathers everyone in'];

function hash01(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}
function inConv(state: GardenState, id: string): boolean {
  return state.conversations.some((c) => c.status === 'open' && c.participants.includes(id));
}
function avgEnergy(state: GardenState): number {
  const live = state.agents.filter((a) => a.alive);
  return live.length ? live.reduce((s, a) => s + a.energy, 0) / live.length : 0;
}

// A free creature shows what it's up to, so the garden is always visibly busy.
function statusSay(a: Agent) {
  speak(a, '', pick(STATUS[a.option.kind] ?? STATUS.wander), 3);
}

function chooseProject(state: GardenState) {
  const free = state.agents.filter((a) => a.alive && a.talkCooldown === 0 && !inConv(state, a.id));
  if (free.length < 2) return;
  const tick = state.world.tick;

  let pr: Project;
  const failing = state.beds
    .map((b) => ({ b, h: bedHealth(state, b.id) }))
    .filter((x) => x.h.count >= 2 && x.h.avg < 50)
    .sort((p, q) => p.h.avg - q.h.avg)[0];
  if (failing) {
    pr = { kind: 'revive', bedId: failing.b.id, site: { ...failing.b.pos }, title: `nursing ${failing.b.label} back to health`, goal: 9, progress: 0, crew: [], startedTick: tick };
  } else if (state.agents.filter((a) => a.alive).length < C.maxAgents && avgEnergy(state) > 52 && Math.random() < 0.5) {
    pr = { kind: 'raise', bedId: null, site: { x: 0.5, y: 0.52 }, title: 'raising a new sprite', goal: 12, progress: 0, crew: [], startedTick: tick };
  } else {
    const bed = pick(state.beds);
    pr = { kind: 'grow', bedId: bed.id, site: { ...bed.pos }, title: `growing a new grove at ${bed.label}`, goal: 10, progress: 0, crew: [], startedTick: tick };
  }
  pr.crew = free.sort((a, b) => dist(a.pos, pr.site) - dist(b.pos, pr.site)).slice(0, C.projectCrew).map((a) => a.id);
  state.project = pr;
  addEvent(state, 'note', `The crew set out: ${pr.title}.`);
}

function roleNote(a: Agent, pr: Project): string {
  if (pr.kind === 'raise') return 'lending warmth to the new one';
  if (a.role === 'forager') return 'carrying water to the bed';
  return pr.kind === 'revive' ? 'nursing the bed back' : 'planting at the grove';
}

function advanceProject(state: GardenState) {
  const pr = state.project;
  if (!pr) return;
  pr.crew = pr.crew.filter((id) => byId(state, id)?.alive);
  if (pr.crew.length < C.projectCrew) {
    const more = state.agents
      .filter((a) => a.alive && !pr.crew.includes(a.id) && a.talkCooldown === 0 && !inConv(state, a.id))
      .sort((a, b) => dist(a.pos, pr.site) - dist(b.pos, pr.site));
    for (const a of more) {
      if (pr.crew.length >= C.projectCrew) break;
      pr.crew.push(a.id);
    }
  }

  let workers = 0;
  for (const id of pr.crew) {
    const a = byId(state, id);
    if (!a || !a.alive || inConv(state, a.id)) continue;
    const off = { x: clamp01(pr.site.x + (hash01(a.id) - 0.5) * 0.18), y: clamp01(pr.site.y + (hash01(a.id + 'y') - 0.5) * 0.18) };
    a.option = { kind: 'tend', targetId: null, target: off, expiresTick: state.world.tick + 2, note: roleNote(a, pr) };
    if (dist(a.pos, pr.site) < 0.18) {
      workers += 1;
      if (a.sayTtl <= 0 && Math.random() < 0.4) speak(a, '', Math.random() < 0.5 ? pick(CREW_LINE[pr.kind]) : roleNote(a, pr), 3);
    }
  }

  if (workers > 0) {
    pr.progress += workers * rand(0.6, 1.2);
    if (pr.kind === 'revive' && pr.bedId) for (const p of state.plants.filter((x) => x.bedId === pr.bedId)) p.health = clamp(p.health + 0.5 * workers);
    if (pr.kind === 'grow' && pr.bedId && state.plants.length < 60 && Math.random() < 0.25) spawnPlant(state, pr.bedId, pr.site);
  }
  if (pr.progress >= pr.goal) resolveProject(state, pr);
}

function resolveProject(state: GardenState, pr: Project) {
  if (pr.kind === 'grow' && pr.bedId) {
    const n = 3 + irand(0, 2);
    for (let i = 0; i < n && state.plants.length < 60; i++) spawnPlant(state, pr.bedId, pr.site);
    addEvent(state, 'bloom', `The crew grew a fresh grove at ${bedLabel(state, pr.bedId)}.`);
  } else if (pr.kind === 'revive' && pr.bedId) {
    for (const p of state.plants.filter((x) => x.bedId === pr.bedId)) p.health = clamp(Math.max(p.health, 78));
    addEvent(state, 'note', `The crew nursed ${bedLabel(state, pr.bedId)} back to life.`);
  } else if (pr.kind === 'raise') {
    raiseNewCreature(state, pr);
  }
  for (const id of pr.crew) {
    const a = byId(state, id);
    if (a) speak(a, '', pick(['we did it', 'look at that', 'good work, all of you']), 3);
  }
  for (let i = 0; i < pr.crew.length; i++) for (let j = i + 1; j < pr.crew.length; j++) bumpAffinity(state, pr.crew[i], pr.crew[j], 3, 'we built it together');
  state.project = null;
}

// The crew raises a new creature. Deterministic (a templated soul), so a new one
// reliably appears; the weekly LLM birth still adds richer newcomers on top.
function raiseNewCreature(state: GardenState, pr: Project) {
  if (state.agents.filter((a) => a.alive).length >= C.maxAgents) return;
  const parents = pr.crew.map((id) => byId(state, id)).filter((a): a is Agent => !!a && a.alive);
  if (parents.length < 2) return;
  const used = new Set(state.agents.map((a) => a.name));
  const name = CHILD_NAMES.find((n) => !used.has(n)) ?? `Sprout ${state.world.tick}`;
  const roles: Agent['role'][] = ['gardener', 'forager', 'storyteller', 'wanderer', 'keeper'];
  const r = hash01(name + state.world.tick);
  createChild(state, parents[0], parents[1], { name, glyph: '', role: roles[Math.floor(r * roles.length)], persona: CHILD_PERSONA[Math.floor(hash01(name) * CHILD_PERSONA.length)] });
}

// ── Interactions ──────────────────────────────────────────────────────────────
function nearestAgent(state: GardenState, pos: Vec): Agent | null {
  let best: Agent | null = null;
  let bestD = Infinity;
  for (const a of state.agents) {
    if (!a.alive) continue;
    const d = dist(pos, a.pos);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

function applyInteractions(state: GardenState, interactions: GardenInteraction[]) {
  for (const it of interactions) {
    if (it.kind === 'rain') {
      state.world.water = clamp(state.world.water + 28);
      addEvent(state, 'note', 'A visitor sent rain. The soil drinks deeply.');
      // The crew feels it and the work goes faster.
      for (const a of state.agents.filter((x) => x.alive).slice(0, 4)) speak(a, '', pick(['rain, at last', 'drink up, everyone', 'i love this', 'good, the beds were dry']), 3);
      if (state.project) state.project.progress += 2;
    } else if (it.kind === 'seed') {
      const bed = it.pos
        ? state.beds.reduce((c, b) => (dist(it.pos!, b.pos) < dist(it.pos!, c.pos) ? b : c))
        : pick(state.beds);
      spawnPlant(state, bed.id, it.pos ?? bed.pos);
      addEvent(state, 'seed', `A visitor planted a seed near ${bed.label}.`);
      const near = nearestAgent(state, it.pos ?? bed.pos);
      if (near) {
        speak(near, '', pick(['a gift, a seed', 'let me help this grow', 'thank you, friend', 'ooh, what will it be?']), 3);
        if (!state.project?.crew.includes(near.id)) near.option = { kind: 'tend', targetId: null, target: it.pos ?? bed.pos, expiresTick: state.world.tick + 5, note: 'settling the new seed in' };
      }
      if (state.project?.kind === 'grow') state.project.progress += 1.5;
    } else if (it.kind === 'whisper' && it.text) {
      // A whisper becomes a memory the nearest creature mulls over, and it reacts
      // out loud. It never enters a system prompt; it's just an observation.
      const target = state.agents.find((a) => a.alive) ?? null;
      if (target) {
        addMemory(state, target.id, 'observe', `A voice from beyond the garden said: "${it.text.slice(0, 80)}"`, 6);
        speak(target, '', pick(['a voice, from beyond', 'did you hear that?', 'i heard you', 'the garden is listening']), 4);
        addEvent(state, 'note', `A whisper drifts through. ${target.name} pauses to listen.`, target.id);
      }
    }
  }
}

// ── The deterministic step ────────────────────────────────────────────────────
export function step(state: GardenState, interactions: GardenInteraction[] = []) {
  const w = state.world;
  w.tick += 1;
  w.timeOfDay = (w.tick % C.ticksPerDay) / C.ticksPerDay;
  if (w.tick % C.ticksPerDay === 0) {
    w.day += 1;
    if (w.day % 8 === 1 && w.day > 1) {
      const idx = (SEASONS.indexOf(w.season) + 1) % 4;
      w.season = SEASONS[idx];
      addEvent(state, 'season', `${capitalize(w.season)} settles over the garden.`);
    }
  }

  applyInteractions(state, interactions);
  growPlants(state);
  closeStaleConversations(state);

  // The crew's shared mission: pick one, work it, finish it, repeat.
  if (!state.project) chooseProject(state);
  if (state.project) advanceProject(state);

  for (const a of state.agents) if (a.alive) stepAgent(state, a);
  detectMeetings(state); // only the off-duty creatures meet and chat

  // Trim the transcript window.
  if (state.messages.length > C.messageCap) state.messages = state.messages.slice(-C.messageCap);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Compact context for the conversation prompt: an agent's strongest recent
// memories (recency + importance, the cheap two-factor version without
// embeddings), plus how it feels about its partner.
export function recallFor(state: GardenState, agentId: string, k = 3): string[] {
  const tick = state.world.tick;
  return state.memories
    .filter((m) => m.agentId === agentId)
    .map((m) => {
      const recency = Math.pow(0.995, Math.max(0, tick - m.lastAccessTick));
      return { m, score: recency + m.importance / 10 };
    })
    .sort((p, q) => q.score - p.score)
    .slice(0, k)
    .map((x) => x.m.text);
}

export function affinityBetween(state: GardenState, a: string, b: string): number {
  const [x, y] = [a, b].sort();
  return state.relationships.find((e) => e.a === x && e.b === y)?.affinity ?? 0;
}
