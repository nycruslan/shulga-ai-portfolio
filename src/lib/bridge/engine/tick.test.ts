import { describe, expect, it } from 'vitest';
import {
  HAIL_WINDOW_MS,
  MIN_TICK_GAP_MS,
  buildInitialBridgeWorld,
  planTick,
  shouldTick,
  type TickTelemetry,
} from './tick';
import { buildBridgeFeed, livenessAt, LIVE_WINDOW_MS } from '../feed';
import { factsSurvive } from '../narrate';

const T0 = '2026-06-12T12:00:00.000Z';
const telemetry: TickTelemetry = {
  eventsToday: 23,
  callsToday: 7,
  costTodayUsd: 0.0314,
  dailyCallCap: 150,
};

const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

describe('shouldTick cadence gate', () => {
  it('always allows heartbeats', () => {
    const world = buildInitialBridgeWorld(T0);
    expect(shouldTick(world, 'heartbeat', Date.parse(T0) + 1)).toBe(true);
  });

  it('blocks visitor ticks inside the minimum gap and allows them after', () => {
    const world = buildInitialBridgeWorld(T0);
    expect(shouldTick(world, 'visitor', Date.parse(T0) + MIN_TICK_GAP_MS - 1)).toBe(false);
    expect(shouldTick(world, 'visitor', Date.parse(T0) + MIN_TICK_GAP_MS)).toBe(true);
  });
});

describe('planTick', () => {
  it('advances the tick and emits exactly one ambient channel line', () => {
    const world = buildInitialBridgeWorld(T0);
    const plan = planTick(world, 'heartbeat', telemetry, later(T0, MIN_TICK_GAP_MS));
    expect(plan.world.tick).toBe(1);
    const channel = plan.events.filter((e) => e.kind === 'channel');
    expect(channel).toHaveLength(1);
  });

  it('fills templates with the real telemetry numbers, never placeholders', () => {
    let world = buildInitialBridgeWorld(T0);
    const summaries: string[] = [];
    for (let i = 0; i < 12; i++) {
      const plan = planTick(world, 'heartbeat', telemetry, later(T0, (i + 1) * MIN_TICK_GAP_MS));
      world = plan.world;
      summaries.push(...plan.events.map((e) => e.summary));
    }
    expect(summaries.some((s) => s.includes('23 events'))).toBe(true);
    expect(summaries.some((s) => s.includes('7 model calls') && s.includes('$0.03'))).toBe(true);
    expect(summaries.every((s) => !s.includes('{') && !s.includes('}'))).toBe(true);
  });

  it('never lets the same crew member speak on consecutive ticks', () => {
    let world = buildInitialBridgeWorld(T0);
    const speakers: string[] = [];
    for (let i = 0; i < 14; i++) {
      const plan = planTick(world, 'heartbeat', telemetry, later(T0, (i + 1) * MIN_TICK_GAP_MS));
      world = plan.world;
      const line = plan.events.find((e) => e.kind === 'channel');
      if (line) speakers.push(line.actor);
    }
    for (let i = 1; i < speakers.length; i++) {
      expect(speakers[i]).not.toBe(speakers[i - 1]);
    }
  });

  it('hails a new visitor once, then stays quiet inside the hail window', () => {
    const world = buildInitialBridgeWorld(T0);
    const t1 = later(T0, MIN_TICK_GAP_MS);
    const first = planTick(world, 'visitor', telemetry, t1);
    expect(first.visitorHailed).toBe(true);
    expect(first.events.some((e) => e.kind === 'visitor' && e.actor === 'envoy')).toBe(true);

    const t2 = later(t1, HAIL_WINDOW_MS - 1000);
    const second = planTick(first.world, 'visitor', telemetry, t2);
    expect(second.visitorHailed).toBe(false);
    expect(second.events.every((e) => e.kind !== 'visitor')).toBe(true);

    const t3 = later(t1, HAIL_WINDOW_MS + 1000);
    const third = planTick(first.world, 'visitor', telemetry, t3);
    expect(third.visitorHailed).toBe(true);
  });

  it('records a system tick event for heartbeats but not for visitor ticks', () => {
    const world = buildInitialBridgeWorld(T0);
    const hb = planTick(world, 'heartbeat', telemetry, later(T0, MIN_TICK_GAP_MS));
    expect(hb.events.some((e) => e.kind === 'tick' && e.actor === 'engine')).toBe(true);
    const vt = planTick(world, 'visitor', telemetry, later(T0, MIN_TICK_GAP_MS));
    expect(vt.events.some((e) => e.kind === 'tick')).toBe(false);
  });

  it('does not mutate the input world', () => {
    const world = buildInitialBridgeWorld(T0);
    const snapshot = structuredClone(world);
    planTick(world, 'heartbeat', telemetry, later(T0, MIN_TICK_GAP_MS));
    expect(world).toEqual(snapshot);
  });
});

describe('narration fact guard', () => {
  it('accepts rephrasings that keep every number and rejects ones that drop them', () => {
    const original = 'Budget check: 7 model calls today, $0.03. Cap is 150.';
    expect(factsSurvive(original, 'ledger says 7 calls, $0.03 spent. 150 is the ceiling.')).toBe(
      true,
    );
    expect(factsSurvive(original, 'budget looks fine, well under the cap.')).toBe(false);
  });
});

describe('feed assembly', () => {
  it('computes liveness from the freshest of world tick and latest event', () => {
    const nowMs = Date.parse(T0);
    expect(livenessAt(later(T0, -LIVE_WINDOW_MS + 1000), nowMs)).toBe('live');
    expect(livenessAt(later(T0, -LIVE_WINDOW_MS - 1000), nowMs)).toBe('off-duty');
  });

  it('reports unconfigured cleanly and still renders a full crew', () => {
    const payload = buildBridgeFeed({
      row: null,
      events: [],
      spend: { llmCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      nowIso: T0,
    });
    expect(payload.configured).toBe(false);
    expect(payload.crew).toHaveLength(5);
    expect(payload.cursor).toBe(0);
  });

  it('uses the freshest event timestamp when polling queries overlap', () => {
    const eventAt = later(T0, 2_000);
    const payload = buildBridgeFeed({
      row: { version: 0, world: buildInitialBridgeWorld(T0), tickedAt: T0 },
      events: [
        {
          id: 1,
          createdAt: eventAt,
          actor: 'engine',
          kind: 'tick',
          summary: 'Tick complete.',
        },
      ],
      latestEventAt: later(T0, 1_000),
      spend: { llmCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      nowIso: later(T0, 3_000),
    });
    expect(payload.watch.lastActivityAt).toBe(eventAt);
  });

  it('hides visitor mission text without relabeling internal audit work', () => {
    const base = {
      createdAt: T0,
      updatedAt: T0,
      status: 'running' as const,
      outcome: 'private outcome',
    };
    const payload = buildBridgeFeed({
      row: null,
      events: [],
      missions: [
        {
          ...base,
          id: 1,
          title: 'Private role text',
          brief: 'private',
          assignee: 'curator',
          visitorId: 'visitor',
        },
        {
          ...base,
          id: 2,
          title: 'Fix copy: intro',
          brief: 'internal',
          assignee: 'curator',
        },
      ],
      spend: { llmCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      nowIso: T0,
    });
    expect(payload.missions.map((mission) => mission.title)).toEqual([
      'Recruiter briefing',
      'Fix copy: intro',
    ]);
    expect(payload.missions[0]).not.toHaveProperty('brief');
    expect(payload.missions[0]).not.toHaveProperty('visitorId');
    expect(payload.missions[0]).not.toHaveProperty('outcome');
  });
});
