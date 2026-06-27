import { AI_GATEWAY_API_KEY, GITHUB_TOKEN } from 'astro:env/server';
import { turso } from '../turso-client';
import { about } from '../../data/about';
import { bridgeStore } from './store';
import {
  DAILY_NARRATION_CAP,
  normalizeBridgeWorld,
  planTick,
  shouldTick,
  type TickTrigger,
} from './engine/tick';
import { planScoutEvents, scoutCheckDue } from './engine/scout';
import { fetchUserActivity } from './github';
import { appendEvent, countEventsSince } from './persistence/events';
import { daySpend, recordSpend } from './persistence/budget';
import { NARRATOR_MODEL, narrate } from './narrate';
import { estimateCostUsd } from './pricing';
import { failStaleMissions } from './persistence/missions';
import { auditDue } from './engine/audit';
import { runAuditCycle } from './audit-cycle';
import { DRAFT_MODEL } from './curator-draft';
import curated from '../../data/curated.json';

// Thin orchestrator around the pure tick engine: lock, plan, run Scout's
// GitHub sweep when due, optionally narrate (one Haiku call, budget-gated),
// persist. Called by /api/bridge/tick.

// Long enough to cover the worst tick: a GitHub sweep, the audit-day Sonnet
// draft, and a Haiku narration, with cold-start headroom. Far under Vercel's
// function timeout. The lease is owner-checked on write, so even if this is
// exceeded a successor's lock and world can't be clobbered.
const TICK_LOCK_MS = 120_000;
const GITHUB_USERNAME = about.github.split('/').pop() ?? 'nycruslan';

export type TickOutcome =
  | { ran: false; reason: 'unconfigured' | 'cadence' | 'locked' | 'error' }
  | { ran: true; tick: number; events: number; narrated: boolean };

export async function runTick(trigger: TickTrigger): Promise<TickOutcome> {
  if (!turso || !bridgeStore.isConfigured()) return { ran: false, reason: 'unconfigured' };

  const now = new Date();
  const nowIso = now.toISOString();

  const row = await bridgeStore.readState();
  if (!row) return { ran: false, reason: 'error' };
  const world = normalizeBridgeWorld(row.world, nowIso);
  if (!shouldTick(world, trigger, now.getTime())) return { ran: false, reason: 'cadence' };

  const lockToken = now.getTime() + TICK_LOCK_MS;
  if (!(await bridgeStore.acquireLock(now.getTime(), TICK_LOCK_MS))) {
    return { ran: false, reason: 'locked' };
  }

  try {
    const spend = await daySpend(turso, nowIso);
    const todayStart = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
    const eventsToday = await countEventsSince(turso, todayStart);

    // Scout's GitHub sweep, when due. Network failure becomes an honest status
    // line on the roster card ("GitHub isn't responding"), never a fake event.
    // Events are collected here and written below with the tick's own events,
    // so a mid-tick crash cannot file findings without advancing the cursor.
    const preTickEvents = [];
    if (scoutCheckDue(world.scout, now.getTime())) {
      try {
        const activity = await fetchUserActivity(GITHUB_USERNAME, world.scout.cursor, GITHUB_TOKEN);
        const scoutPlan = planScoutEvents(activity, world.scout, nowIso);
        world.scout = scoutPlan.state;
        preTickEvents.push(...scoutPlan.events);
        if (scoutPlan.events.length) {
          // lastSpokeTick = current tick mutes Scout's ambient line this tick.
          const latest = scoutPlan.events.at(-1)!;
          world.crew.scout = { status: latest.summary, lastSpokeTick: world.tick };
        }
      } catch (err) {
        console.error('[bridge] scout sweep failed:', err);
        world.scout.lastCheckedAt = nowIso;
        world.scout.lastError = "GitHub isn't responding.";
        world.crew.scout.status = "GitHub isn't responding. Retrying next sweep.";
      }
    }

    // The Critic/Curator cycle: deterministic copy audit roughly daily, on
    // heartbeats only (a visitor arriving should never trigger drafting).
    // Runs BEFORE planTick so the updated audit state lands in the persisted
    // world clone.
    if (trigger === 'heartbeat' && auditDue(world.audit, now.getTime())) {
      try {
        const cycle = await runAuditCycle({
          client: turso,
          entries: curated as Record<string, string>,
          auditState: world.audit,
          draftModel: AI_GATEWAY_API_KEY ? DRAFT_MODEL : null,
          nowIso,
        });
        world.audit = cycle.state;
        preTickEvents.push(...cycle.events);
      } catch (err) {
        console.error('[bridge] audit cycle failed:', err);
        world.audit = { ...world.audit, lastAuditAt: nowIso };
      }
    }

    const plan = planTick(
      world,
      trigger,
      {
        eventsToday,
        callsToday: spend.llmCalls,
        costTodayUsd: spend.costUsd,
        dailyCallCap: DAILY_NARRATION_CAP,
      },
      nowIso,
    );

    // Optional voice pass. Facts are checked by narrate(); on any failure the
    // template lines ship as-is. The original line is preserved in detail for
    // the expandable layer-3 trace.
    // Gate narration on the narrator's OWN spend, not the whole crew's, so
    // heavy Envoy or Curator traffic (each capped separately) can't starve it.
    let narrated = false;
    const narratorCalls = (await daySpend(turso, nowIso, 'narrator')).llmCalls;
    if (AI_GATEWAY_API_KEY && plan.narratable.length && narratorCalls < DAILY_NARRATION_CAP) {
      const result = await narrate(plan.narratable);
      if (result.usage) {
        narrated = true;
        await recordSpend(
          turso,
          {
            agent: 'narrator',
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            costUsd: estimateCostUsd(NARRATOR_MODEL, result.usage),
          },
          nowIso,
        );
        for (const event of plan.events) {
          const voiced = result.lines[event.actor as keyof typeof result.lines];
          if (event.kind === 'channel' && voiced) {
            event.detail = { ...(event.detail as object), template: event.summary };
            event.summary = voiced;
            const crew = plan.world.crew[event.actor as keyof typeof plan.world.crew];
            if (crew) crew.status = voiced;
          }
          if (result.generationId) event.generationId = result.generationId;
        }
      }
    }

    // Sweep missions whose runs died mid-flight (closed tab, redeploy). An
    // honest "interrupted" beats a spinner stuck on 'running' forever.
    const staleMissions = await failStaleMissions(turso, nowIso);
    for (const id of staleMissions) {
      plan.events.push({
        actor: 'engine',
        kind: 'mission',
        summary: `Mission #${id} marked failed: the run was interrupted.`,
        missionId: id,
      });
    }

    // Persist the advanced world (tick counter AND scout cursor) BEFORE filing
    // events. A crash between the two loses at most this tick's events; it can
    // never re-file a finding the cursor already moved past, which would mint a
    // duplicate. The owner-checked write also drops cleanly if the lease lapsed.
    const allEvents = [...preTickEvents, ...plan.events];
    await bridgeStore.writeState(plan.world, nowIso, lockToken);
    for (const event of allEvents) {
      await appendEvent(turso, event, nowIso);
    }

    return { ran: true, tick: plan.world.tick, events: allEvents.length, narrated };
  } catch (err) {
    console.error('[bridge] tick failed:', err);
    await bridgeStore.releaseLock(lockToken);
    return { ran: false, reason: 'error' };
  }
}
