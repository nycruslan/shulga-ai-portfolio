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
import { planCiEvents, planScoutEvents, scoutCheckDue } from './engine/scout';
import { fetchLatestCiRun, fetchUserActivity, type CiRun } from './github';
import { countEventsSince } from './persistence/events';
import { DAILY_BRIDGE_CALL_CAP, daySpend, finalizeSpend, reserveCall } from './persistence/budget';
import { NARRATOR_MODEL, narrate } from './narrate';
import { estimateCostUsd } from './pricing';
import { failStaleMissions } from './persistence/missions';
import { auditDue } from './engine/audit';
import { runAuditCycle } from './audit-cycle';
import { DRAFT_MODEL } from './curator-draft';
import { SHIP_NOTE_DAILY_CAP, SHIP_NOTE_MODEL, writeShipNote } from './ship-note';
import { getCorpus } from '../portfolio-content';
import curated from '../../data/curated.json';
import { commitBridgeTick } from './persistence/commit-tick';

// Thin orchestrator around the pure tick engine: lock, plan, run Scout's
// GitHub sweep when due, optionally narrate (one Haiku call, budget-gated),
// persist. Called by /api/bridge/tick.

// Long enough to cover the worst tick: a GitHub sweep, the audit-day Sonnet
// draft, and a Haiku narration, with cold-start headroom. Far under Vercel's
// function timeout. The lease is owner-checked on write, so even if this is
// exceeded a successor's lock and world can't be clobbered.
const TICK_LOCK_MS = 120_000;
const GITHUB_USERNAME = about.github.split('/').pop() ?? 'nycruslan';

// Branches Scout keeps a CI watch on. One API call per repo per sweep. The
// events feed can't cover this: workflow runs never appear in a user's public
// event stream, which is how a three-day-red build once went unreported while
// Scout kept saying "sensors green".
const CI_WATCHED = [{ repo: `${GITHUB_USERNAME}/shulga-ai-portfolio`, branch: 'master' }];

/**
 * The read-only copy surface for Critic's site-wide sweep: every corpus chunk
 * (about fields + case-study sections), keyed stably so findings fingerprint
 * across days. Code fences are stripped — a dash in a code sample is not
 * prose. Failure degrades to a curated-only audit, never a dead tick.
 */
async function buildReadOnlySurface(): Promise<Record<string, string>> {
  try {
    const corpus = await getCorpus();
    return Object.fromEntries(
      corpus.map((c) => [`${c.source}#${c.title}`, c.text.replace(/```[\s\S]*?```/g, '')]),
    );
  } catch (err) {
    console.error('[bridge] read-only copy surface failed:', err);
    return {};
  }
}

export type TickOutcome =
  | { ran: false; reason: 'unconfigured' | 'cadence' | 'locked' | 'lease-lost' | 'error' }
  | { ran: true; tick: number; events: number; narrated: boolean };

export async function runTick(trigger: TickTrigger): Promise<TickOutcome> {
  if (!turso || !bridgeStore.isConfigured()) return { ran: false, reason: 'unconfigured' };

  const now = new Date();
  const nowIso = now.toISOString();

  const initialRow = await bridgeStore.readState();
  if (!initialRow) return { ran: false, reason: 'error' };
  const initialWorld = normalizeBridgeWorld(initialRow.world, nowIso);
  if (!shouldTick(initialWorld, trigger, now.getTime())) {
    return { ran: false, reason: 'cadence' };
  }

  let lockToken = now.getTime() + TICK_LOCK_MS;
  if (!(await bridgeStore.acquireLock(now.getTime(), TICK_LOCK_MS))) {
    return { ran: false, reason: 'locked' };
  }

  try {
    // The state may have advanced after the optimistic cadence check but before
    // this request acquired the lease. Re-read it under the lock so planning
    // and the final version check use the same snapshot.
    const row = await bridgeStore.readState();
    if (!row) throw new Error('Bridge state is unreadable.');
    const world = normalizeBridgeWorld(row.world, nowIso);
    if (!shouldTick(world, trigger, now.getTime())) {
      await bridgeStore.releaseLock(lockToken);
      return { ran: false, reason: 'cadence' };
    }

    const spend = await daySpend(turso, nowIso);
    const todayStart = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
    const eventsToday = await countEventsSince(turso, todayStart);

    // Scout's GitHub sweep, when due. Network failure becomes an honest status
    // line on the roster card ("GitHub isn't responding"), never a fake event.
    // Events are collected here and written below with the tick's own events,
    // so a mid-tick crash cannot file findings without advancing the cursor.
    const preTickEvents = [];
    // Fresh pushes Scout files this tick; Curator may write a ship note on it.
    let shipCandidate: { repo: string; titles: string[]; url: string } | null = null;
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
        const pushed = scoutPlan.events.findLast(
          (e) => e.kind === 'github' && !!(e.detail as { pushes?: unknown[] })?.pushes,
        );
        if (pushed) {
          const pushes = (pushed.detail as { pushes: Array<{ title: string }> }).pushes;
          shipCandidate = {
            repo: world.scout.lastCommit?.repo ?? '',
            titles: pushes.map((p) => p.title),
            url: pushed.link ?? '',
          };
        }
      } catch (err) {
        console.error('[bridge] scout sweep failed:', err);
        world.scout.lastCheckedAt = nowIso;
        world.scout.lastError = "GitHub isn't responding.";
        world.crew.scout.status = "GitHub isn't responding. Retrying next sweep.";
      }

      // CI condition check rides the same cadence. Per-repo failures degrade
      // silently to "checked next sweep" — a flaky API call must never file a
      // false alert or clear a real one.
      const observed: Array<{ repo: string; run: CiRun }> = [];
      for (const watched of CI_WATCHED) {
        try {
          const run = await fetchLatestCiRun(watched.repo, watched.branch, GITHUB_TOKEN);
          if (run) observed.push({ repo: watched.repo, run });
        } catch (err) {
          console.error(`[bridge] ci check failed (${watched.repo}):`, err);
        }
      }
      if (observed.length) {
        const ciPlan = planCiEvents(observed, world.scout, nowIso);
        world.scout = ciPlan.state;
        preTickEvents.push(...ciPlan.events);
        if (ciPlan.events.length) {
          const latest = ciPlan.events.at(-1)!;
          world.crew.scout = { status: latest.summary, lastSpokeTick: world.tick };
        }
      }
    }

    // Network work may consume much of the original lease. Do not perform any
    // model or proposal writes unless this process still owns a live lease.
    const afterScoutToken = await bridgeStore.renewLock(lockToken, Date.now(), TICK_LOCK_MS);
    if (afterScoutToken === null) return { ran: false, reason: 'lease-lost' };
    lockToken = afterScoutToken;

    // Curator's ship note: one Haiku call turning fresh commit subjects into a
    // visitor-readable line, gated on Curator's own budget and dropped whole
    // if it fails the deterministic review. Never blocks the tick.
    if (shipCandidate?.repo && AI_GATEWAY_API_KEY) {
      if (await reserveCall(turso, 'curator', SHIP_NOTE_DAILY_CAP, nowIso)) {
        const shipNote = await writeShipNote({
          repo: shipCandidate.repo,
          titles: shipCandidate.titles,
        });
        if (shipNote) {
          await finalizeSpend(
            turso,
            {
              agent: 'curator',
              inputTokens: shipNote.usage.inputTokens,
              outputTokens: shipNote.usage.outputTokens,
              costUsd: estimateCostUsd(SHIP_NOTE_MODEL, shipNote.usage),
            },
            nowIso,
          );
          preTickEvents.push({
            actor: 'curator',
            kind: 'ship',
            summary: shipNote.note,
            link: shipCandidate.url || undefined,
            generationId: shipNote.generationId,
            detail: { commits: shipCandidate.titles, repo: shipCandidate.repo },
          });
          world.crew.curator = { status: shipNote.note, lastSpokeTick: world.tick };
        }
      }
    }

    // The Critic/Curator cycle: deterministic copy audit roughly daily, on
    // heartbeats only (a visitor arriving should never trigger drafting).
    // Runs BEFORE planTick so the updated audit state lands in the persisted
    // world clone.
    if (trigger === 'heartbeat' && auditDue(world.audit, now.getTime())) {
      const beforeAuditToken = await bridgeStore.renewLock(lockToken, Date.now(), TICK_LOCK_MS);
      if (beforeAuditToken === null) return { ran: false, reason: 'lease-lost' };
      lockToken = beforeAuditToken;
      try {
        const cycle = await runAuditCycle({
          client: turso,
          entries: curated as Record<string, string>,
          readOnly: await buildReadOnlySurface(),
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
      const afterAuditToken = await bridgeStore.renewLock(lockToken, Date.now(), TICK_LOCK_MS);
      if (afterAuditToken === null) return { ran: false, reason: 'lease-lost' };
      lockToken = afterAuditToken;
    }

    const plan = planTick(
      world,
      trigger,
      {
        eventsToday,
        callsToday: spend.llmCalls,
        costTodayUsd: spend.costUsd,
        dailyCallCap: DAILY_BRIDGE_CALL_CAP,
      },
      nowIso,
    );

    // Optional voice pass. Facts are checked by narrate(); on any failure the
    // template lines ship as-is. The original line is preserved in detail for
    // the expandable layer-3 trace.
    // Gate narration on the narrator's OWN spend, not the whole crew's, so
    // heavy Envoy or Curator traffic (each capped separately) can't starve it.
    let narrated = false;
    if (
      AI_GATEWAY_API_KEY &&
      plan.narratable.length &&
      (await reserveCall(turso, 'narrator', DAILY_NARRATION_CAP, nowIso))
    ) {
      const result = await narrate(plan.narratable);
      if (result.usage) {
        narrated = true;
        await finalizeSpend(
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

    const beforeCommitToken = await bridgeStore.renewLock(lockToken, Date.now(), TICK_LOCK_MS);
    if (beforeCommitToken === null) return { ran: false, reason: 'lease-lost' };
    lockToken = beforeCommitToken;

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

    // World state and its receipts commit together. Version + live-lease checks
    // make a stale tick fail without publishing events for a world that lost.
    const allEvents = [...preTickEvents, ...plan.events];
    const committed = await commitBridgeTick(turso, {
      world: plan.world,
      expectedVersion: row.version,
      lockToken,
      tickedAtIso: nowIso,
      events: allEvents,
    });
    if (!committed) return { ran: false, reason: 'lease-lost' };

    return { ran: true, tick: plan.world.tick, events: allEvents.length, narrated };
  } catch (err) {
    console.error('[bridge] tick failed:', err);
    await bridgeStore.releaseLock(lockToken);
    return { ran: false, reason: 'error' };
  }
}
