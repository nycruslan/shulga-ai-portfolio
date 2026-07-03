import type { BridgeEvent } from './persistence/events';
import type { DaySpend } from './persistence/budget';
import type { Mission } from './persistence/missions';
import type { WorldStateRow } from './engine/world-store';
import { DAILY_NARRATION_CAP, type BridgeWorld } from './engine/tick';
import { activeCiAlert } from './engine/scout';
import { CREW, ROADMAP, type RoadmapMission } from './crew';

// Pure assembly of the bridge's read payload. Liveness thresholds are shared
// with the island so the badge can be computed identically on either side.

export const LIVE_WINDOW_MS = 10 * 60_000;

export type BridgeLiveness = 'live' | 'off-duty';

export type BridgeFeedPayload = {
  configured: boolean;
  now: string;
  watch: {
    tick: number;
    lastTickAt: string;
    lastVisitorAt: string | null;
    lastActivityAt: string;
    liveness: BridgeLiveness;
  };
  crew: Array<{
    id: string;
    name: string;
    station: string;
    role: string;
    online: boolean;
    status: string;
  }>;
  roadmap: RoadmapMission[];
  /** Real visitor-dispatched missions, newest first. */
  missions: Mission[];
  /** False until the gateway key is installed; the comms panel says so. */
  commsOnline: boolean;
  spend: { calls: number; costUsd: number; cap: number };
  /** Latest real shipped artifact, for the watch-bar receipt chip. */
  shipped: { at: string; url: string; repo: string; title: string } | null;
  /** Active CI failure on a watched repo; the deck goes to red alert on this. */
  alert: {
    repo: string;
    workflow: string;
    title: string;
    url: string;
    since: string | null;
  } | null;
  events: BridgeEvent[];
  /** Highest event id seen; pass back as ?after= on the next poll. */
  cursor: number;
};

export function livenessAt(lastActivityAt: string, nowMs: number): BridgeLiveness {
  return nowMs - Date.parse(lastActivityAt) <= LIVE_WINDOW_MS ? 'live' : 'off-duty';
}

function buildAlert(world: BridgeWorld | undefined): BridgeFeedPayload['alert'] {
  // Optional chaining: worlds persisted before the CI sensor have no ci map.
  const alert = world?.scout ? activeCiAlert(world.scout) : null;
  if (!alert) return null;
  return {
    repo: alert.repo,
    workflow: alert.workflow,
    title: alert.title,
    url: alert.url,
    since: alert.redSince,
  };
}

export function buildBridgeFeed(input: {
  row: WorldStateRow<BridgeWorld> | null;
  events: BridgeEvent[];
  spend: DaySpend;
  nowIso: string;
  missions?: Mission[];
  commsOnline?: boolean;
}): BridgeFeedPayload {
  const { row, events, spend, nowIso, missions = [], commsOnline = false } = input;
  const world = row?.world;
  const latestEventAt = events.at(-1)?.createdAt;
  const lastTickAt = world?.lastTickAt ?? nowIso;
  const lastActivityAt = latestEventAt && latestEventAt > lastTickAt ? latestEventAt : lastTickAt;

  return {
    configured: row !== null,
    now: nowIso,
    watch: {
      tick: world?.tick ?? 0,
      lastTickAt,
      lastVisitorAt: world?.lastVisitorAt ?? null,
      lastActivityAt,
      liveness: livenessAt(lastActivityAt, Date.parse(nowIso)),
    },
    crew: CREW.map((m) => ({
      id: m.id,
      name: m.name,
      station: m.station,
      role: m.role,
      online: m.online,
      status: world?.crew[m.id]?.status ?? 'Standing by.',
    })),
    roadmap: ROADMAP,
    missions,
    commsOnline,
    spend: { calls: spend.llmCalls, costUsd: spend.costUsd, cap: DAILY_NARRATION_CAP },
    // Optional chaining: worlds persisted before Phase 2 have no scout state.
    shipped: world?.scout?.lastCommit ?? null,
    alert: buildAlert(world),
    events,
    cursor: events.at(-1)?.id ?? 0,
  };
}
