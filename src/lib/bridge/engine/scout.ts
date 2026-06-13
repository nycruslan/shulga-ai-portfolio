import type { BridgeEventInput } from '../persistence/events';
import type { ScoutActivity } from '../github';

// Scout's pure planning layer. Given freshly fetched GitHub activity and the
// previous state, decide which events to file and how state advances. Rules:
// pushes to one repo within a single check collapse into one event (noise
// control); every event links to its real artifact and quotes GitHub's own
// timestamp; first run after deploy is capped so the log is not flooded with
// history; once a week, with enough material, Scout files a shipped brief
// built purely from recorded activity.

export type ScoutState = {
  /** Newest GitHub event id seen (numeric string). */
  cursor: string | null;
  lastCheckedAt: string | null;
  lastCommit: { at: string; url: string; repo: string; title: string } | null;
  lastBriefAt: string | null;
  /** Rolling buffer feeding the weekly brief. */
  recent: ScoutActivity[];
  /** Honest failure surface for the roster card. */
  lastError: string | null;
};

export const initialScoutState = (): ScoutState => ({
  cursor: null,
  lastCheckedAt: null,
  lastCommit: null,
  lastBriefAt: null,
  recent: [],
  lastError: null,
});

export const SCOUT_CHECK_INTERVAL_MS = 30 * 60_000;
export const BRIEF_INTERVAL_MS = 7 * 24 * 3600_000;
export const BRIEF_MIN_ACTIVITIES = 3;
const FIRST_RUN_MAX = 6;
const FIRST_RUN_WINDOW_MS = 48 * 3600_000;
const RECENT_CAP = 50;

export function scoutCheckDue(state: ScoutState, nowMs: number): boolean {
  return !state.lastCheckedAt || nowMs - Date.parse(state.lastCheckedAt) >= SCOUT_CHECK_INTERVAL_MS;
}

const hhmm = (iso: string) => iso.slice(11, 16) + 'Z';

export type ScoutPlan = { events: BridgeEventInput[]; state: ScoutState };

export function planScoutEvents(
  activities: ScoutActivity[],
  prev: ScoutState,
  nowIso: string,
): ScoutPlan {
  const state: ScoutState = structuredClone(prev);
  state.lastCheckedAt = nowIso;
  state.lastError = null;
  const events: BridgeEventInput[] = [];

  // First sweep after deploy: only the recent past, and only a handful.
  let fresh = activities;
  if (prev.cursor === null) {
    const cutoff = Date.parse(nowIso) - FIRST_RUN_WINDOW_MS;
    fresh = activities.filter((a) => Date.parse(a.at) >= cutoff).slice(-FIRST_RUN_MAX);
  }

  if (activities.length) {
    state.cursor = activities.reduce(
      (max, a) => (BigInt(a.id) > BigInt(max) ? a.id : max),
      state.cursor ?? '0',
    );
  }

  // Collapse pushes per repo; everything else files individually.
  const pushesByRepo = new Map<string, ScoutActivity[]>();
  for (const a of fresh) {
    if (a.kind === 'push') {
      pushesByRepo.set(a.repo, [...(pushesByRepo.get(a.repo) ?? []), a]);
    } else {
      events.push({
        actor: 'scout',
        kind: 'github',
        summary: `${a.title} in ${a.repo} (${hhmm(a.at)}).`,
        link: a.url,
        detail: { activity: a },
      });
    }
  }
  for (const [repo, pushes] of pushesByRepo) {
    const newest = pushes.at(-1)!;
    const summary =
      pushes.length === 1
        ? `Pushed to ${repo}: "${newest.title}" (${hhmm(newest.at)}).`
        : `${pushes.length} pushes to ${repo}. Newest: "${newest.title}" (${hhmm(newest.at)}).`;
    events.push({
      actor: 'scout',
      kind: 'github',
      summary,
      link: newest.url,
      detail: { pushes: pushes.map((p) => ({ sha: p.sha, title: p.title, at: p.at, url: p.url })) },
    });
    state.lastCommit = { at: newest.at, url: newest.url, repo, title: newest.title };
  }

  state.recent = [...state.recent, ...fresh].slice(-RECENT_CAP);

  // Weekly shipped brief, built only from what Scout actually recorded.
  if (state.lastBriefAt === null) {
    // Start the clock on first contact; the first brief comes a week later.
    if (fresh.length) state.lastBriefAt = nowIso;
  } else if (Date.parse(nowIso) - Date.parse(state.lastBriefAt) >= BRIEF_INTERVAL_MS) {
    const windowStart = state.lastBriefAt;
    const inWindow = state.recent.filter((a) => a.at >= windowStart);
    if (inWindow.length >= BRIEF_MIN_ACTIVITIES) {
      events.push(buildWeeklyBrief(inWindow, nowIso));
      state.lastBriefAt = nowIso;
    }
  }

  return { events, state };
}

/** Deterministic brief: counts and names, all real, receipts in the detail. */
export function buildWeeklyBrief(inWindow: ScoutActivity[], nowIso: string): BridgeEventInput {
  const pushes = inWindow.filter((a) => a.kind === 'push');
  const repos = new Map<string, number>();
  for (const a of inWindow) repos.set(a.repo, (repos.get(a.repo) ?? 0) + 1);
  const busiest = [...repos.entries()].sort((a, b) => b[1] - a[1])[0];
  const newest = inWindow.at(-1);
  const extras = inWindow.length - pushes.length;

  const parts = [
    `Shipped this week: ${pushes.length} ${pushes.length === 1 ? 'push' : 'pushes'} across ${repos.size} ${repos.size === 1 ? 'repo' : 'repos'}`,
    extras > 0 ? `plus ${extras} other ${extras === 1 ? 'event' : 'events'}` : null,
    busiest ? `Busiest: ${busiest[0]} (${busiest[1]})` : null,
    newest ? `Latest: "${newest.title}"` : null,
  ].filter(Boolean);

  return {
    actor: 'scout',
    kind: 'brief',
    summary: parts.join('. ') + '.',
    link: newest?.url,
    detail: { window: { from: inWindow[0]?.at, to: nowIso }, activities: inWindow },
  };
}
