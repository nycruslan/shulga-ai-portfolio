// THE GARDEN — a living society of AI agents in a dark glass garden. A
// deterministic ecosystem engine runs free every tick (plants grow, seasons
// turn, agents move and meet). At most one Haiku call per tick is spent on the
// society's visible drama: the next line of a conversation, or an opener when two
// agents meet. State lives entirely in Turso so any visitor tick resumes the
// world. Architecture distilled from Generative Agents (Smallville), Lyfe Agents
// (option commitment, cheap), and AI Town (input-queue consistency).

export type Season = 'spring' | 'summer' | 'fall' | 'winter';

export type Vec = { x: number; y: number }; // normalized garden space, 0..1

// An option is an activity an agent commits to for many ticks (Lyfe Agents), so
// most ticks are free: the agent just keeps executing it. The LLM is only
// consulted for talking, not for plumbing.
export type OptionKind = 'wander' | 'tend' | 'forage' | 'rest' | 'talk';

export type AgentOption = {
  kind: OptionKind;
  targetId: string | null; // a plant (tend) or an agent (talk)
  target: Vec | null; // where the agent is walking
  expiresTick: number; // when the agent must choose again
  note: string; // short human-readable label, e.g. "tending the east bed"
};

export type Role = 'gardener' | 'forager' | 'storyteller' | 'wanderer' | 'keeper';

export type Agent = {
  id: string;
  name: string;
  glyph: string; // the creature, a single emoji or character
  role: Role;
  persona: string; // a few words of character
  pos: Vec;
  energy: number; // 0..100, drops with activity, rises with rest
  age: number; // ticks lived
  mood: string; // short word, set when it acts/talks
  option: AgentOption;
  say: string | null; // current speech-bubble text (emoji + few words)
  sayTtl: number; // ticks the bubble lingers
  generation: number; // 0 = seed agents
  parents: string[]; // lineage
  bornTick: number;
  alive: boolean;
  talkCooldown: number; // ticks until this agent will start another conversation
  lastReflectTick: number; // when this agent last formed a higher-level thought
};

export type Plant = {
  id: string;
  bedId: string;
  pos: Vec;
  glyph: string; // rendered species mark
  growth: number; // 0..100, drives size
  health: number; // 0..100
  age: number;
};

export type Bed = { id: string; pos: Vec; label: string };

export type Memory = {
  id: string;
  agentId: string;
  kind: 'observe' | 'talk' | 'reflect';
  text: string;
  importance: number; // 1..10 (Generative Agents poignancy)
  createdTick: number;
  lastAccessTick: number;
};

export type Conversation = {
  id: string;
  kind: 'chat' | 'decision';
  topic: string;
  participants: string[]; // agent ids
  turnCount: number;
  maxTurns: number;
  status: 'open' | 'closed';
  openedTick: number;
  lastTurnTick: number;
  pos: Vec; // where it's happening, for the camera/bubbles
  bedId?: string; // for 'decision' conversations: the bed under discussion
};

export type Message = {
  id: string;
  convId: string;
  agentId: string;
  emoji: string; // the Smallville glyph for the action/feeling
  text: string; // a few words
  turnIndex: number;
  createdTick: number;
};

export type Relationship = { a: string; b: string; affinity: number; note: string };

export type GardenEvent = {
  id: number;
  tick: number;
  kind: 'born' | 'met' | 'bonded' | 'rift' | 'bloom' | 'wilt' | 'died' | 'season' | 'seed' | 'reflect' | 'note';
  text: string;
  agentId: string | null;
};

// The crew's shared mission right now. They converge on the site and work it
// together until it's done, then it visibly changes the world (a new grove, a
// revived bed, a newborn creature).
export type ProjectKind = 'grow' | 'revive' | 'raise';
export type Project = {
  kind: ProjectKind;
  title: string; // plain-language goal, shown to the visitor
  bedId: string | null;
  site: Vec;
  goal: number;
  progress: number;
  crew: string[]; // creature ids on the job
  startedTick: number;
};

export type World = {
  tick: number;
  day: number;
  timeOfDay: number; // 0..1, 0=midnight, .5=noon
  season: Season;
  water: number; // 0..100 shared resource pool
  startedAt: string;
};

// The whole mutable world, persisted as one JSON blob in Turso (atomic single-row
// write under a lease lock, like the Substrate). Everything is capped so the blob
// stays bounded. The engine loads it, mutates it, writes it back.
export type GardenState = {
  world: World;
  beds: Bed[];
  agents: Agent[];
  plants: Plant[];
  conversations: Conversation[];
  relationships: Relationship[];
  memories: Memory[]; // all agents, capped per agent
  messages: Message[]; // transcript window
  events: GardenEvent[];
  project: Project | null; // the crew's current shared mission
  seq: number; // monotonic id source for memories/messages/etc
};

// What the renderer/transcript consumes. A plain JSON snapshot drives the thin
// view (the AI Town pattern: state out, renderer paints).
export type GardenSnapshot = {
  configured: true;
  version: number;
  tickedAt: string;
  staleMs: number;
  world: World;
  agents: Agent[];
  plants: Plant[];
  recentMessages: Message[]; // for the transcript
  relationships: Relationship[];
  events: GardenEvent[];
  project: Project | null;
  stats: GardenStats;
};

export type GardenStats = {
  population: number;
  plants: number;
  bonds: number; // positive relationships
  day: number;
  births: number;
};

export type GardenSnapshotResponse = GardenSnapshot | { configured: false };

// A visitor action, queued and consumed on the next tick (never a synchronous
// model call), exactly like the Substrate's interaction queue.
export type GardenInteractionKind = 'seed' | 'rain' | 'whisper';
export type GardenInteraction = {
  kind: GardenInteractionKind;
  text?: string; // whisper content (sanitized) or seed location hint
  pos?: Vec;
};

// ── Tuning. All cadence/cost/ecology knobs in one place. ──────────────────────
export const GARDEN_CONFIG = {
  tickIntervalMs: 3_800, // world advances at most this often when watched — brisk and lively
  pollIntervalMs: 2_000, // client read cadence (CDN-cached)
  projectCrew: 3, // creatures on the shared job at once
  lockTtlMs: 25_000,
  dailyLlmCap: 200, // hard ceiling on Haiku calls/day (~$1-2 worst case)
  ticksPerDay: 48, // a full day/night every 48 ticks
  proximity: 0.14, // how close two agents must be to start talking
  talkCooldownTicks: 14, // before an agent will start another conversation
  convMaxTurns: 6, // hard cap so there are no goodbye loops
  optionMinTicks: 3,
  optionMaxTicks: 9,
  maxAgents: 14, // safety ceiling; population also self-limits via energy
  maxOpenConversations: 2, // bounds concurrent LLM work
  memoryCap: 40, // per agent, before the oldest low-importance ones are forgotten
  eventCap: 60,
  messageCap: 60, // transcript window
  interactionsPerMinute: 8,
  whispersPerHour: 6,
  // Society depth (phases 3-4).
  reflectImportance: 16, // sum of new-memory importance that triggers a reflection
  reflectCooldownTicks: 20,
  bedFailHealth: 38, // average bed health that convenes a group decision
  birthAffinity: 55, // mutual affinity two creatures need to raise a new one
  birthEnergy: 64, // energy each parent needs
  birthEnergyCost: 34, // energy each parent spends (so they can't immediately re-birth)
  birthCooldownTicks: 60,
} as const;
