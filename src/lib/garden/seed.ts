import type { Agent, Bed, GardenState, Plant, Role, Vec } from './types';

// The garden at genesis: a handful of glyph-creatures with distinct temperaments,
// a few planting beds, and seedlings just breaking ground. Everything grows from
// here. Seed agents are generation 0; the society raises the rest itself.

type Seed = { id: string; name: string; glyph: string; role: Role; persona: string; pos: Vec };

const SEED_AGENTS: Seed[] = [
  { id: 'moss', name: 'Moss', glyph: '🌿', role: 'gardener', persona: 'gentle, fusses over every seedling', pos: { x: 0.32, y: 0.4 } },
  { id: 'fern', name: 'Fern', glyph: '🌱', role: 'forager', persona: 'curious, always wandering off to look', pos: { x: 0.62, y: 0.34 } },
  { id: 'spore', name: 'Spore', glyph: '🍄', role: 'storyteller', persona: 'dramatic, loves a good rumor', pos: { x: 0.5, y: 0.6 } },
  { id: 'thorn', name: 'Thorn', glyph: '🌵', role: 'keeper', persona: 'prickly, guards the beds, slow to trust', pos: { x: 0.74, y: 0.62 } },
  { id: 'petal', name: 'Petal', glyph: '🌸', role: 'wanderer', persona: 'dreamy, drifts wherever the breeze goes', pos: { x: 0.28, y: 0.68 } },
  { id: 'root', name: 'Root', glyph: '🪵', role: 'gardener', persona: 'stubborn, thinks deep and speaks rarely', pos: { x: 0.5, y: 0.22 } },
];

const BEDS: Bed[] = [
  { id: 'east', pos: { x: 0.72, y: 0.42 }, label: 'the east bed' },
  { id: 'west', pos: { x: 0.24, y: 0.5 }, label: 'the west bed' },
  { id: 'pond', pos: { x: 0.5, y: 0.78 }, label: 'the pond edge' },
];

const PLANT_GLYPHS = ['🌱', '🌿', '☘️', '🌾'];

// Deterministic scatter so genesis is identical on every re-seed (no Math.random
// at seed time keeps reseeds stable).
function bedPlants(bed: Bed, startId: number): Plant[] {
  const plants: Plant[] = [];
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    plants.push({
      id: `p${startId + i}`,
      bedId: bed.id,
      pos: { x: clamp01(bed.pos.x + Math.cos(angle) * 0.06), y: clamp01(bed.pos.y + Math.sin(angle) * 0.06) },
      glyph: PLANT_GLYPHS[(startId + i) % PLANT_GLYPHS.length],
      growth: 10 + ((startId + i) % 3) * 6,
      health: 78 + ((startId + i) % 4) * 4,
      age: 0,
    });
  }
  return plants;
}

const clamp01 = (n: number) => Math.max(0.04, Math.min(0.96, n));

export function buildInitialGarden(nowIso: string): GardenState {
  const agents: Agent[] = SEED_AGENTS.map((s) => ({
    id: s.id,
    name: s.name,
    glyph: s.glyph,
    role: s.role,
    persona: s.persona,
    pos: { ...s.pos },
    energy: 90,
    age: 0,
    mood: 'settling in',
    option: { kind: 'wander', targetId: null, target: null, expiresTick: 2, note: 'finding their feet' },
    say: null,
    sayTtl: 0,
    generation: 0,
    parents: [],
    bornTick: 0,
    alive: true,
    talkCooldown: 0,
    lastReflectTick: 0,
  }));

  let pid = 0;
  const plants: Plant[] = BEDS.flatMap((bed) => {
    const ps = bedPlants(bed, pid);
    pid += ps.length;
    return ps;
  });

  return {
    world: { tick: 0, day: 1, timeOfDay: 0.25, season: 'spring', water: 70, startedAt: nowIso },
    beds: BEDS,
    agents,
    plants,
    conversations: [],
    relationships: [],
    memories: [],
    messages: [],
    events: [{ id: 1, tick: 0, kind: 'note', text: 'The garden wakes. Six small souls stir in the dark soil.', agentId: null }],
    project: null,
    seq: 2,
  };
}
