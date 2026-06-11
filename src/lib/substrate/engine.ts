import type { Agent, Interaction, Stage, Task, World } from './types';
import { CONFIG } from './types';
import { ROLE_BRIEF, STAGE_STATION, STATIONS } from './crew';

// Pure-ish deterministic step. No I/O, no LLM. Advances the task pipeline one
// stage, runs the supervisor's failover loop, updates relationships and
// integrity, and applies queued visitor interactions. The world is fully alive
// on this alone; Claude only adds voice on top (see narrate.ts).

const JUDGE_THRESHOLD = 55;
const QUARANTINE_AT = 38;
const QUARANTINE_TICKS = 3;
const NEVER_QUARANTINE = new Set(['helm', 'warden']); // orchestrator + supervisor stay up

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const pick = <T>(arr: T[]): T | undefined => arr[Math.floor(Math.random() * arr.length)];

let taskSeq = 0;
const newTaskId = (tick: number) => `t${tick}-${(taskSeq++).toString(36)}`;

const TASK_LABELS = [
  'compliance pass on Q3 filings',
  'reconcile customer ledger',
  'summarize incident report',
  'index new policy docs',
  'draft risk memo',
  'classify support tickets',
  'extract terms from contract',
  'enrich entity graph',
];

function log(world: World, kind: string, text: string, agentId?: string) {
  const line = { tick: world.tick, kind, text, agentId };
  world.log.unshift(line);
  if (world.log.length > CONFIG.logCap) world.log.length = CONFIG.logCap;
  if (['done', 'failed', 'quarantine', 'anomaly', 'directive', 'restore'].includes(kind)) {
    world.memory.unshift(line);
    if (world.memory.length > CONFIG.memoryCap) world.memory.length = CONFIG.memoryCap;
  }
}

function speak(agent: Agent, text: string, ttl = 2) {
  agent.say = text;
  agent.sayTtl = ttl;
}

function strengthenEdge(world: World, a: string, b: string, delta = 6) {
  if (a === b) return;
  const [x, y] = [a, b].sort();
  let edge = world.edges.find((e) => e.a === x && e.b === y);
  if (!edge) {
    edge = { a: x, b: y, trust: 0 };
    world.edges.push(edge);
  }
  edge.trust = clamp(edge.trust + delta);
  world.edges.sort((p, q) => q.trust - p.trust);
  if (world.edges.length > CONFIG.edgeCap) world.edges.length = CONFIG.edgeCap;
}

const byId = (world: World, id: string) => world.agents.find((a) => a.id === id);

// Find a free agent for a stage: preferred role first, then a free worker.
function claimAgent(world: World, stage: Stage): Agent | null {
  const roleFor: Partial<Record<Stage, Agent['role']>> = {
    retrieve: 'retriever',
    analyze: 'analyst',
    gateway: 'gateway',
    build: 'builder',
    judge: 'judge',
  };
  const wanted = roleFor[stage];
  const free = (a: Agent) => a.status === 'idle' && a.taskId === null && a.quarantineFor === 0;
  const preferred = world.agents.filter((a) => a.role === wanted && free(a));
  const candidate = pick(preferred) ?? world.agents.find((a) => a.role === 'worker' && free(a)) ?? null;
  return candidate;
}

function releaseAgent(world: World, agentId: string | null) {
  if (!agentId) return;
  const a = byId(world, agentId);
  if (a && a.status !== 'quarantined') {
    a.taskId = null;
    a.status = 'idle';
    a.pos = { ...a.home };
  }
}

const NEXT_STAGE: Record<Stage, Stage> = {
  queued: 'retrieve',
  retrieve: 'analyze',
  analyze: 'build', // gateway is an occasional detour, inserted below
  gateway: 'build',
  build: 'judge',
  judge: 'done',
  done: 'done',
  failed: 'failed',
};

function moveToStage(world: World, task: Task) {
  const prevAgent = task.assignedTo;
  let next = NEXT_STAGE[task.stage];
  // Occasionally route analysis through an external tool call (MCP) before build.
  if (task.stage === 'analyze' && Math.random() < 0.35) next = 'gateway';

  if (next === 'done' || next === 'failed') return; // judged separately
  const agent = claimAgent(world, next);
  if (!agent) return; // no one free this tick — hold the task where it is

  releaseAgent(world, prevAgent);
  if (prevAgent && prevAgent !== agent.id) strengthenEdge(world, prevAgent, agent.id);

  task.stage = next;
  task.assignedTo = agent.id;
  if (next === 'build') task.builtBy = agent.id; // judged + accountable on failure
  agent.taskId = task.id;
  agent.status = 'working';
  const station = STAGE_STATION[next];
  if (station) agent.pos = { ...STATIONS[station] };

  if (next === 'retrieve') speak(agent, 'querying memory core…');
  else if (next === 'gateway') speak(agent, 'calling external tool…');
  else if (next === 'judge') speak(agent, 'scoring output…');
}

function spawnTask(world: World, origin: Task['origin'], label?: string) {
  if (world.tasks.filter((t) => t.stage !== 'done' && t.stage !== 'failed').length >= CONFIG.maxTasks) {
    return null;
  }
  const task: Task = {
    id: newTaskId(world.tick),
    label: label ?? pick(TASK_LABELS)!,
    stage: 'queued',
    assignedTo: null,
    builtBy: null,
    score: null,
    origin,
    createdTick: world.tick,
  };
  world.tasks.push(task);
  return task;
}

function difficultyOf(task: Task): number {
  return task.origin === 'anomaly' ? 22 : task.origin === 'directive' ? 10 : 0;
}

function judgeTask(world: World, task: Task) {
  const judge = task.assignedTo ? byId(world, task.assignedTo) : null;
  const builder = task.builtBy ? byId(world, task.builtBy) : world.agents.find((a) => a.role === 'builder');
  // Real spread of outcomes: a meaningful failure rate even at full health, so
  // the supervisor/quarantine loop actually fires and stays watchable.
  const base = 50 + ((builder?.health ?? 70) - 70) * 0.35 + rand(-30, 34) - difficultyOf(task);
  const score = Math.round(clamp(base));
  task.score = score;

  if (score >= JUDGE_THRESHOLD) {
    task.stage = 'done';
    world.stats.completed += 1;
    world.integrity = clamp(world.integrity + 2);
    if (judge) speak(judge, `pass · ${score}`);
    log(world, 'done', `${task.label} shipped at ${score}/100.`, builder?.id);
    if (builder) builder.health = clamp(builder.health + 3);
  } else {
    task.stage = 'failed';
    world.stats.failed += 1;
    world.integrity = clamp(world.integrity - 3);
    if (judge) speak(judge, `fail · ${score}`);
    log(world, 'failed', `${task.label} failed eval (${score}/100). ${builder?.callsign ?? 'builder'} integrity hit.`, builder?.id);
    if (builder && !NEVER_QUARANTINE.has(builder.id)) builder.health = clamp(builder.health - 24);
  }
  releaseAgent(world, task.assignedTo);
  task.assignedTo = null;
}

function supervisorPass(world: World) {
  const warden = world.agents.find((a) => a.role === 'supervisor');
  for (const a of world.agents) {
    if (a.quarantineFor > 0) {
      a.quarantineFor -= 1;
      if (a.quarantineFor === 0) {
        a.status = 'idle';
        a.health = 100;
        a.pos = { ...a.home };
        a.taskId = null;
        speak(a, 'restarted · nominal');
        log(world, 'restore', `${a.callsign} restarted, integrity restored.`, a.id);
      }
      continue;
    }
    if (a.health <= QUARANTINE_AT && !NEVER_QUARANTINE.has(a.id) && a.status !== 'quarantined') {
      // Free any task it was holding so the pipeline reroutes.
      if (a.taskId) {
        const t = world.tasks.find((x) => x.id === a.taskId);
        if (t && t.stage !== 'done' && t.stage !== 'failed') {
          t.stage = 'queued';
          t.assignedTo = null;
        }
      }
      a.status = 'quarantined';
      a.taskId = null;
      a.quarantineFor = QUARANTINE_TICKS;
      a.pos = { ...STATIONS.AIRLOCK };
      world.stats.quarantines += 1;
      world.integrity = clamp(world.integrity - 4);
      speak(a, 'quarantined', 3);
      if (warden) speak(warden, `isolating ${a.callsign}`, 2);
      log(world, 'quarantine', `WARDEN quarantined ${a.callsign} (integrity ${Math.round(a.health)}%). Rerouting.`, a.id);
    }
  }
}

function applyInteractions(world: World, interactions: Interaction[]) {
  for (const it of interactions) {
    if (it.kind === 'anomaly') {
      world.integrity = clamp(world.integrity - 18);
      spawnTask(world, 'anomaly', 'contain anomaly + restore systems');
      log(world, 'anomaly', 'Anomaly injected. Integrity dropped; containment task spawned.');
    } else if (it.kind === 'directive' && it.text) {
      const text = it.text.slice(0, 120);
      world.directive = text;
      spawnTask(world, 'directive', text);
      const helm = world.agents.find((a) => a.role === 'orchestrator');
      if (helm) speak(helm, 'new directive received', 2);
      log(world, 'directive', `Directive set: “${text}”. HELM distributing.`);
    } else if (it.kind === 'question' && it.agentId) {
      const target = byId(world, it.agentId);
      if (target) {
        // Templated acknowledgement; narrate.ts replaces it with a real reply.
        speak(target, 'stand by, reading the room…', 2);
        log(world, 'ask', `Visitor asked ${target.callsign}: “${(it.text ?? '').slice(0, 100)}”`, target.id);
      }
    }
  }
}

export function step(world: World, interactions: Interaction[] = []): World {
  world.tick += 1;

  applyInteractions(world, interactions);
  supervisorPass(world);

  // HELM spawns system work when there's headroom.
  if (Math.random() < 0.55) {
    const t = spawnTask(world, 'system');
    if (t) {
      const helm = world.agents.find((a) => a.role === 'orchestrator');
      if (helm && Math.random() < 0.4) speak(helm, 'routing new task', 1);
    }
  }

  // Advance every in-flight task one stage. Judge stage resolves outcomes.
  for (const task of world.tasks) {
    if (task.stage === 'done' || task.stage === 'failed') continue;
    if (task.stage === 'judge') {
      judgeTask(world, task);
      continue;
    }
    moveToStage(world, task);
  }

  // Retry one failed task occasionally; otherwise let completed/failed age out.
  const failed = world.tasks.find((t) => t.stage === 'failed' && world.tick - t.createdTick < 6);
  if (failed && Math.random() < 0.6) {
    failed.stage = 'queued';
    failed.assignedTo = null;
    failed.builtBy = null;
    failed.score = null;
    log(world, 'retry', `Retrying ${failed.label}.`);
  }
  world.tasks = world.tasks.filter(
    (t) => (t.stage !== 'done' && t.stage !== 'failed') || world.tick - t.createdTick < 4
  );

  // Health drift + speech decay + idle positioning.
  for (const a of world.agents) {
    if (a.sayTtl > 0) {
      a.sayTtl -= 1;
      if (a.sayTtl === 0) a.say = null;
    }
    if (a.status === 'working') a.health = clamp(a.health - rand(3, 6));
    else if (a.status === 'idle') {
      a.health = clamp(a.health + 2);
      if (!a.taskId) a.pos = { ...a.home };
    }
  }

  world.integrity = clamp(world.integrity + (world.integrity < 100 ? 1 : 0));
  return world;
}

// Compact snapshot of the world for the LLM narrator — small + cache-friendly.
export function describeForLlm(world: World): string {
  const agents = world.agents
    .map((a) => `${a.callsign}(${a.role},${a.status},hp${Math.round(a.health)}${a.taskId ? ',busy' : ''})`)
    .join(' ');
  const tasks = world.tasks
    .filter((t) => t.stage !== 'done' && t.stage !== 'failed')
    .map((t) => `${t.label}[${t.stage}]`)
    .join('; ');
  const recent = world.log.slice(0, 5).map((l) => l.text).join(' | ');
  return [
    `tick ${world.tick}, integrity ${Math.round(world.integrity)}%`,
    world.directive ? `directive: ${world.directive}` : 'no active directive',
    `crew: ${agents}`,
    `in-flight: ${tasks || 'none'}`,
    `recent: ${recent}`,
  ].join('\n');
}

export { ROLE_BRIEF };
