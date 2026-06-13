import type { BridgeEventInput } from '../persistence/events';
import { CREW, type CrewId } from '../crew';
import { initialScoutState, type ScoutState } from './scout';
import { initialAuditState, type AuditState } from './audit';

// The deterministic heart of the Bridge. planTick is a pure function: given
// the current world and real telemetry, it decides who speaks and what events
// get appended. No randomness (seeded by tick number), no LLM, no I/O — the
// narrator may later repaint the WORDING of channel lines in-voice, but the
// facts in them come from here and are real. Every number shown to a visitor
// (event counts, model calls, dollars) must arrive through TickTelemetry.

export type BridgeWorld = {
  tick: number;
  startedAt: string;
  lastTickAt: string;
  lastVisitorAt: string | null;
  crew: Record<CrewId, { status: string; lastSpokeTick: number }>;
  scout: ScoutState;
  audit: AuditState;
};

export type TickTelemetry = {
  /** Real count of events already in today's log. */
  eventsToday: number;
  /** Real model-call count and dollars spent today (bridge_budget). */
  callsToday: number;
  costTodayUsd: number;
  dailyCallCap: number;
};

export type TickTrigger = 'heartbeat' | 'visitor';

export type TickPlan = {
  world: BridgeWorld;
  events: BridgeEventInput[];
  /** Channel lines the narrator may rephrase in-voice (facts must survive). */
  narratable: Array<{ actor: CrewId; line: string }>;
  /** True when Envoy should hail a newly arrived visitor. */
  visitorHailed: boolean;
};

export const MIN_TICK_GAP_MS = 90_000;
/** Hail at most once per this window, no matter how many visitors arrive. */
export const HAIL_WINDOW_MS = 10 * 60_000;
/** Daily cap on narrator (Haiku) calls; the engine runs free without them. */
export const DAILY_NARRATION_CAP = 150;

export function buildInitialBridgeWorld(nowIso: string): BridgeWorld {
  return {
    tick: 0,
    startedAt: nowIso,
    lastTickAt: nowIso,
    lastVisitorAt: null,
    crew: {
      // lastSpokeTick: -1 = has not spoken; 0 would mute everyone on tick 1.
      scout: { status: 'Sensors warming up. First GitHub sweep this watch.', lastSpokeTick: -1 },
      curator: {
        status: 'Briefing room open. Editing tools arrive in Phase 5.',
        lastSpokeTick: -1,
      },
      critic: { status: 'Watching the budget meter.', lastSpokeTick: -1 },
      envoy: { status: 'On comms. Listening for visitors.', lastSpokeTick: -1 },
      archivist: { status: 'Keeping the log.', lastSpokeTick: -1 },
    },
    scout: initialScoutState(),
    audit: initialAuditState(),
  };
}

/**
 * Worlds persisted by earlier phases lack newer fields (e.g. Phase 1 rows have
 * no scout state). Merge whatever is stored over a fresh world so reads never
 * crash on shape drift and new stations self-initialize.
 */
export function normalizeBridgeWorld(stored: unknown, nowIso: string): BridgeWorld {
  const base = buildInitialBridgeWorld(nowIso);
  if (typeof stored !== 'object' || stored === null) return base;
  const w = stored as Partial<BridgeWorld>;
  return {
    ...base,
    ...w,
    crew: { ...base.crew, ...(w.crew ?? {}) },
    scout: { ...base.scout, ...(w.scout ?? {}) },
    audit: { ...base.audit, ...(w.audit ?? {}) },
  };
}

/** Cadence gate: visitor-triggered ticks are bounded; heartbeats always run. */
export function shouldTick(world: BridgeWorld, trigger: TickTrigger, nowMs: number): boolean {
  if (trigger === 'heartbeat') return true;
  return nowMs - Date.parse(world.lastTickAt) >= MIN_TICK_GAP_MS;
}

// Honest ambient lines. Every {placeholder} is filled with a real number from
// telemetry. The rotation is seeded by tick number so tests are deterministic
// and consecutive ticks do not repeat a speaker.
type LineTemplate = { actor: CrewId; build: (t: TickTelemetry, w: BridgeWorld) => string };

const AMBIENT_LINES: LineTemplate[] = [
  {
    actor: 'archivist',
    build: (t) => `Log current. ${t.eventsToday} events filed today.`,
  },
  {
    actor: 'critic',
    build: (t) =>
      `Budget check: ${t.callsToday} model calls today, $${t.costTodayUsd.toFixed(2)}. Cap is ${t.dailyCallCap}.`,
  },
  {
    actor: 'scout',
    build: (_t, w) =>
      w.scout.lastError
        ? `${w.scout.lastError} Retrying next sweep.`
        : w.scout.lastCommit
          ? `Sensors green. Last push: ${w.scout.lastCommit.repo.split('/')[1]} at ${w.scout.lastCommit.at.slice(11, 16)}Z.`
          : 'Sensors green. Watching the GitHub feed; nothing new yet.',
  },
  {
    actor: 'envoy',
    build: (_t, w) =>
      w.lastVisitorAt
        ? 'Comms open. Holding the channel for the next visitor.'
        : 'Comms open. No visitors yet this watch.',
  },
  {
    actor: 'curator',
    build: (_t, w) =>
      w.audit.lastAuditAt
        ? `Briefing room open. Last copy audit ${w.audit.lastAuditAt.slice(5, 10)} ${w.audit.lastAuditAt.slice(11, 16)}Z.`
        : 'Briefing room open. First copy audit comes with the next heartbeat.',
  },
  {
    actor: 'archivist',
    build: (_t, w) => `Watch tick ${w.tick}. All entries timestamped and real.`,
  },
  {
    actor: 'critic',
    build: () => {
      const online = CREW.filter((m) => m.online).length;
      return `Reviewed the roster. ${online} stations online, ${CREW.length - online} waiting on wiring.`;
    },
  },
];

export function planTick(
  world: BridgeWorld,
  trigger: TickTrigger,
  telemetry: TickTelemetry,
  nowIso: string,
): TickPlan {
  const next: BridgeWorld = structuredClone(world);
  next.tick += 1;
  next.lastTickAt = nowIso;

  const events: BridgeEventInput[] = [];
  const narratable: TickPlan['narratable'] = [];
  const nowMs = Date.parse(nowIso);

  // A real visitor arrival is an event worth hailing, but only once per window
  // so a busy hour does not flood the channel with greetings.
  let visitorHailed = false;
  if (trigger === 'visitor') {
    const lastVisitorMs = next.lastVisitorAt ? Date.parse(next.lastVisitorAt) : 0;
    next.lastVisitorAt = nowIso;
    if (nowMs - lastVisitorMs >= HAIL_WINDOW_MS) {
      visitorHailed = true;
      const hail =
        'Visitor on the bridge. Short version: five AI agents run this site, and you are watching them work.';
      events.push({ actor: 'envoy', kind: 'visitor', summary: hail });
      next.crew.envoy = { status: 'Talking to a visitor.', lastSpokeTick: next.tick };
    }
  }

  // One ambient line per tick, rotated deterministically, never the same
  // speaker twice in a row, and never Envoy talking over their own hail.
  for (let offset = 0; offset < AMBIENT_LINES.length; offset++) {
    const candidate = AMBIENT_LINES[(next.tick + offset) % AMBIENT_LINES.length];
    const spokeLast = next.crew[candidate.actor].lastSpokeTick === next.tick - 1;
    const hailingNow = visitorHailed && candidate.actor === 'envoy';
    if (spokeLast || hailingNow) continue;
    const line = candidate.build(telemetry, next);
    events.push({ actor: candidate.actor, kind: 'channel', summary: line });
    narratable.push({ actor: candidate.actor, line });
    next.crew[candidate.actor] = { status: line, lastSpokeTick: next.tick };
    break;
  }

  // Heartbeats leave a system entry so the gap between watches is visibly
  // accounted for. Visitor ticks skip it to keep the log signal-dense.
  if (trigger === 'heartbeat') {
    events.push({
      actor: 'engine',
      kind: 'tick',
      summary: `Heartbeat tick ${next.tick}. ${telemetry.callsToday} model calls so far today.`,
      detail: { trigger, callsToday: telemetry.callsToday, costTodayUsd: telemetry.costTodayUsd },
    });
  }

  return { world: next, events, narratable, visitorHailed };
}
