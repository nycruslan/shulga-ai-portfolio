import type { Agent, AgentRole, Stage, Vec, World } from './types';

// Fixed stations inside the vessel cross-section (normalized space).
export const STATIONS: Record<string, Vec> = {
  HELM: { x: 0.5, y: 0.14 }, // orchestrator
  MEMORY: { x: 0.16, y: 0.5 }, // retrieval / hybrid RAG
  ANALYSIS: { x: 0.5, y: 0.48 }, // reasoning
  GATEWAY: { x: 0.84, y: 0.5 }, // MCP tool calls
  FORGE: { x: 0.5, y: 0.82 }, // build / ship
  EVAL: { x: 0.73, y: 0.72 }, // eval harness
  AIRLOCK: { x: 0.11, y: 0.85 }, // quarantine
};

// Which station a task stage routes its assignee to.
export const STAGE_STATION: Partial<Record<Stage, keyof typeof STATIONS>> = {
  retrieve: 'MEMORY',
  analyze: 'ANALYSIS',
  build: 'FORGE',
  gateway: 'GATEWAY',
  judge: 'EVAL',
};

type CrewSeed = { id: string; callsign: string; role: AgentRole; home: Vec };

// The crew is an AI platform, read as a ship's company. Each role is a real
// piece of the stack so the sim doubles as a work sample.
export const CREW: CrewSeed[] = [
  { id: 'helm', callsign: 'HELM', role: 'orchestrator', home: { x: 0.5, y: 0.19 } },
  { id: 'idx-1', callsign: 'IDX-1', role: 'retriever', home: { x: 0.27, y: 0.4 } },
  { id: 'idx-2', callsign: 'IDX-2', role: 'retriever', home: { x: 0.27, y: 0.6 } },
  { id: 'oracle', callsign: 'ORACLE', role: 'analyst', home: { x: 0.5, y: 0.45 } },
  { id: 'forge', callsign: 'FORGE', role: 'builder', home: { x: 0.5, y: 0.74 } },
  { id: 'gateway', callsign: 'GATEWAY', role: 'gateway', home: { x: 0.76, y: 0.44 } },
  { id: 'arbiter', callsign: 'ARBITER', role: 'judge', home: { x: 0.71, y: 0.64 } },
  { id: 'warden', callsign: 'WARDEN', role: 'supervisor', home: { x: 0.22, y: 0.77 } },
  { id: 'relay', callsign: 'RELAY', role: 'worker', home: { x: 0.64, y: 0.28 } },
];

// One-line role briefs, surfaced in the UI legend and fed to the LLM for voice.
export const ROLE_BRIEF: Record<AgentRole, string> = {
  orchestrator: 'Assigns and routes work across the crew.',
  retriever: 'Pulls context from the Memory Core (hybrid retrieval).',
  analyst: 'Reasons over retrieved context.',
  builder: 'Turns decisions into shipped output.',
  gateway: 'Calls external tools through MCP.',
  judge: 'Scores every output against the eval rules.',
  supervisor: 'Quarantines and restarts agents that fail.',
  worker: 'Picks up overflow wherever the crew is stretched.',
};

function agentFromSeed(s: CrewSeed): Agent {
  return {
    ...s,
    pos: { ...s.home },
    status: 'idle',
    health: 100,
    taskId: null,
    say: null,
    sayTtl: 0,
    quarantineFor: 0,
  };
}

export function buildInitialWorld(nowIso: string): World {
  return {
    tick: 0,
    startedAt: nowIso,
    agents: CREW.map(agentFromSeed),
    tasks: [],
    edges: [],
    memory: [],
    log: [{ tick: 0, kind: 'boot', text: 'Substrate online. Crew at stations.' }],
    directive: null,
    integrity: 100,
    stats: { completed: 0, failed: 0, quarantines: 0 },
  };
}
