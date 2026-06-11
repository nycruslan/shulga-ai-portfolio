// THE SUBSTRATE — a live, watchable rendering of an AI platform as a crewed
// vessel. A deterministic simulation drives a real agentic pipeline (orchestrate
// → retrieve → analyze → build → judge), with a supervisor that quarantines
// failing agents. Claude only adds in-character speech, gated by budget, so the
// world is fully alive at $0 and the LLM is enhancement, not a dependency.

export type AgentRole =
  | 'orchestrator'
  | 'retriever'
  | 'analyst'
  | 'builder'
  | 'gateway'
  | 'judge'
  | 'supervisor'
  | 'worker';

export type AgentStatus = 'idle' | 'working' | 'quarantined' | 'restarting';

// Pipeline stages a task flows through. Maps to the real stack:
// retrieve = hybrid RAG, gateway = MCP tool call, judge = eval harness.
export type Stage = 'queued' | 'retrieve' | 'analyze' | 'build' | 'gateway' | 'judge' | 'done' | 'failed';

export type Vec = { x: number; y: number }; // normalized vessel space, 0..1

export type Agent = {
  id: string;
  callsign: string;
  role: AgentRole;
  home: Vec; // station the agent idles at
  pos: Vec; // server-side target position; the client eases toward it
  status: AgentStatus;
  health: number; // 0..100 "integrity" / eval score
  taskId: string | null;
  say: string | null; // transient speech bubble
  sayTtl: number; // ticks the speech persists
  quarantineFor: number; // ticks remaining in the airlock
};

export type Task = {
  id: string;
  label: string;
  stage: Stage;
  assignedTo: string | null;
  builtBy: string | null; // agent that ran the build stage — judged + dinged on fail
  score: number | null; // judge score 0..100
  origin: 'system' | 'directive' | 'anomaly';
  createdTick: number;
};

export type Edge = { a: string; b: string; trust: number }; // relationship graph

export type LogLine = { tick: number; kind: string; text: string; agentId?: string };

export type World = {
  tick: number;
  startedAt: string;
  agents: Agent[];
  tasks: Task[];
  edges: Edge[];
  memory: LogLine[]; // capped store of notable events — the Memory Core
  log: LogLine[]; // capped recent feed for the ship's log
  directive: string | null; // current crew goal from a visitor
  integrity: number; // overall vessel integrity 0..100
  stats: { completed: number; failed: number; quarantines: number };
};

// A visitor action, queued and consumed on the next paid tick (never triggers a
// synchronous LLM call).
export type InteractionKind = 'anomaly' | 'directive' | 'question';
export type Interaction = {
  kind: InteractionKind;
  text?: string; // directive text or question
  agentId?: string; // question target
};

// What the client renders. Snapshot = world + freshness metadata.
export type Snapshot = {
  configured: true;
  version: number;
  tickedAt: string; // ISO of last advance
  staleMs: number; // server-computed age, so clients know when to trigger a tick
  world: World;
};

export type SnapshotResponse = Snapshot | { configured: false };

// ── Tuning. All cost/cadence knobs in one place. ──────────────────────────────
export const CONFIG = {
  tickIntervalMs: 12_000, // world advances at most this often, even when watched
  pollIntervalMs: 2_000, // client read cadence (CDN-cached)
  lockTtlMs: 25_000, // single-writer lock lease
  llmHeartbeatTicks: 5, // ~60s of active watching → one LLM narration pass
  dailyLlmCap: 150, // hard ceiling on LLM ticks/day (~$1/day worst case)
  maxTasks: 6, // active tasks cap, for readability
  logCap: 40,
  memoryCap: 24,
  edgeCap: 40,
  questionsPerHour: 4, // per-IP ask-an-officer limit
  actionsPerMinute: 8, // per-IP interaction limit
} as const;
