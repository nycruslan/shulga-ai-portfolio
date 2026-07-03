import { describe, expect, it } from 'vitest';
import { parseEvents, type CiRun, type ScoutActivity } from '../github';
import {
  activeCiAlert,
  BRIEF_INTERVAL_MS,
  buildWeeklyBrief,
  humanizeDurationMs,
  initialScoutState,
  planCiEvents,
  planScoutEvents,
  scoutCheckDue,
  SCOUT_CHECK_INTERVAL_MS,
} from './scout';
import { normalizeBridgeWorld, buildInitialBridgeWorld } from './tick';

const NOW = '2026-06-12T12:00:00.000Z';
const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

// Shapes lifted from the real public events API (verified live): public
// payloads carry head/before but no commits array; authenticated ones list
// commits. The parser must handle both.
const publicPush = {
  id: '13224228807',
  type: 'PushEvent',
  repo: { name: 'nycruslan/shulga-ai-portfolio' },
  created_at: '2026-06-12T12:18:04Z',
  payload: { ref: 'refs/heads/master', head: 'ea1a9ddd14ec0cc5effa80ba05f486b9d24b7d4f' },
};
const authedPush = {
  id: '13224228808',
  type: 'PushEvent',
  repo: { name: 'nycruslan/portfolio-copilot' },
  created_at: '2026-06-12T12:20:00Z',
  payload: {
    ref: 'refs/heads/main',
    commits: [{ sha: 'abc1234def', message: 'feat: add scanner\n\nlong body' }],
  },
};
const prEvent = {
  id: '13224228809',
  type: 'PullRequestEvent',
  repo: { name: 'nycruslan/shulga-ai-portfolio' },
  created_at: '2026-06-12T12:25:00Z',
  payload: {
    action: 'closed',
    pull_request: {
      html_url: 'https://github.com/x/y/pull/7',
      title: 'Bridge phase 2',
      merged: true,
    },
  },
};
const starEvent = {
  id: '13224228810',
  type: 'WatchEvent',
  repo: { name: 'vercel/ai' },
  created_at: '2026-06-12T12:30:00Z',
  payload: {},
};

describe('parseEvents', () => {
  it('parses public pushes (head sha, no commits) with a commit deep link', () => {
    const [a] = parseEvents([publicPush], null);
    expect(a.kind).toBe('push');
    expect(a.url).toBe(
      'https://github.com/nycruslan/shulga-ai-portfolio/commit/ea1a9ddd14ec0cc5effa80ba05f486b9d24b7d4f',
    );
    expect(a.title).toBe('master advanced to ea1a9dd');
    expect(a.at).toBe('2026-06-12T12:18:04Z');
  });

  it('uses the commit message when the payload includes commits', () => {
    const [a] = parseEvents([authedPush], null);
    expect(a.title).toBe('feat: add scanner');
  });

  it('keeps merged PRs, drops stars, and respects the cursor', () => {
    const all = parseEvents([starEvent, prEvent, authedPush, publicPush], null);
    expect(all.map((a) => a.kind)).toEqual(['push', 'push', 'pr']); // oldest first, no star
    const afterCursor = parseEvents([starEvent, prEvent, authedPush, publicPush], '13224228808');
    expect(afterCursor.map((a) => a.id)).toEqual(['13224228809']);
  });
});

const activity = (over: Partial<ScoutActivity>): ScoutActivity => ({
  id: '100',
  kind: 'push',
  repo: 'nycruslan/shulga-ai-portfolio',
  at: later(NOW, -3600_000),
  url: 'https://github.com/nycruslan/shulga-ai-portfolio/commit/abc1234',
  title: 'feat: something real',
  sha: 'abc1234',
  ...over,
});

describe('planScoutEvents', () => {
  it('collapses same-repo pushes into one event linking the newest commit', () => {
    const state = { ...initialScoutState(), cursor: '1' };
    const plan = planScoutEvents(
      [
        activity({ id: '2', title: 'fix: a', at: later(NOW, -7200_000) }),
        activity({
          id: '3',
          title: 'feat: b',
          at: later(NOW, -3600_000),
          url: 'https://github.com/r/x/commit/fff9999',
          sha: 'fff9999',
        }),
      ],
      state,
      NOW,
    );
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0].summary).toContain('2 pushes');
    expect(plan.events[0].summary).toContain('"feat: b"');
    expect(plan.events[0].link).toBe('https://github.com/r/x/commit/fff9999');
    expect(plan.state.cursor).toBe('3');
    expect(plan.state.lastCommit?.title).toBe('feat: b');
  });

  it('quotes GitHub timestamps in the summary, not filing time', () => {
    const state = { ...initialScoutState(), cursor: '1' };
    const plan = planScoutEvents([activity({ id: '2', at: '2026-06-12T09:41:00Z' })], state, NOW);
    expect(plan.events[0].summary).toContain('09:41Z');
  });

  it('caps the first sweep after deploy to recent history', () => {
    const old = activity({ id: '2', at: later(NOW, -3 * 24 * 3600_000) }); // 3 days old
    const fresh = Array.from({ length: 8 }, (_, i) =>
      activity({
        id: String(10 + i),
        repo: `nycruslan/repo-${i}`,
        at: later(NOW, -(i + 1) * 3600_000),
      }),
    );
    const plan = planScoutEvents([old, ...fresh], initialScoutState(), NOW);
    // 8 fresh activities in 8 distinct repos, capped at 6, 3-day-old one dropped.
    expect(plan.events).toHaveLength(6);
    expect(plan.state.cursor).toBe('17'); // cursor still advances past everything seen
  });

  it('files nothing when there is no new activity, but records the check', () => {
    const state = { ...initialScoutState(), cursor: '99' };
    const plan = planScoutEvents([], state, NOW);
    expect(plan.events).toHaveLength(0);
    expect(plan.state.lastCheckedAt).toBe(NOW);
  });

  it('schedules the weekly brief only after a week with enough material', () => {
    let state: ReturnType<typeof initialScoutState> = { ...initialScoutState(), cursor: '1' };
    // First contact starts the clock without a brief.
    let plan = planScoutEvents([activity({ id: '2' })], state, NOW);
    expect(plan.state.lastBriefAt).toBe(NOW);
    expect(plan.events.every((e) => e.kind !== 'brief')).toBe(true);

    // A week later with 3+ activities in the window: brief fires.
    state = plan.state;
    const weekLater = later(NOW, BRIEF_INTERVAL_MS + 1000);
    plan = planScoutEvents(
      [
        activity({ id: '3', at: later(NOW, 24 * 3600_000) }),
        activity({ id: '4', at: later(NOW, 48 * 3600_000), repo: 'nycruslan/other' }),
        activity({ id: '5', at: later(NOW, 72 * 3600_000) }),
      ],
      state,
      weekLater,
    );
    const brief = plan.events.find((e) => e.kind === 'brief');
    expect(brief).toBeDefined();
    expect(plan.state.lastBriefAt).toBe(weekLater);
  });

  it('does not mutate the previous state', () => {
    const state = initialScoutState();
    const snapshot = structuredClone(state);
    planScoutEvents([activity({})], state, NOW);
    expect(state).toEqual(snapshot);
  });
});

describe('buildWeeklyBrief', () => {
  it('reports real counts with receipts attached', () => {
    const brief = buildWeeklyBrief(
      [
        activity({ id: '1', title: 'feat: a' }),
        activity({ id: '2', repo: 'nycruslan/other', title: 'fix: b' }),
        activity({
          id: '3',
          kind: 'pr',
          title: 'Merged PR: c',
          url: 'https://github.com/x/pull/1',
        }),
      ],
      NOW,
    );
    expect(brief.summary).toContain('2 pushes across 2 repos');
    expect(brief.summary).toContain('plus 1 other event');
    expect(brief.summary).toContain('Latest: "Merged PR: c"');
    expect((brief.detail as { activities: unknown[] }).activities).toHaveLength(3);
  });
});

describe('scoutCheckDue', () => {
  it('is due initially and again after the interval', () => {
    const state = initialScoutState();
    expect(scoutCheckDue(state, Date.parse(NOW))).toBe(true);
    state.lastCheckedAt = NOW;
    expect(scoutCheckDue(state, Date.parse(NOW) + SCOUT_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(scoutCheckDue(state, Date.parse(NOW) + SCOUT_CHECK_INTERVAL_MS)).toBe(true);
  });
});

const ciRun = (over: Partial<CiRun>): CiRun => ({
  id: 900,
  workflow: 'ci',
  title: 'feat: something real',
  status: 'completed',
  conclusion: 'success',
  url: 'https://github.com/nycruslan/portfolio-copilot/actions/runs/900',
  startedAt: later(NOW, -600_000),
  ...over,
});
const REPO = 'nycruslan/portfolio-copilot';

describe('planCiEvents', () => {
  it('records a first-seen green branch silently', () => {
    const plan = planCiEvents([{ repo: REPO, run: ciRun({}) }], initialScoutState(), NOW);
    expect(plan.events).toHaveLength(0);
    expect(plan.state.ci[REPO].conclusion).toBe('success');
    expect(activeCiAlert(plan.state)).toBeNull();
  });

  it('files a red alert when a branch is red on first observation', () => {
    const run = ciRun({ conclusion: 'failure', startedAt: '2026-06-12T03:32:00Z' });
    const plan = planCiEvents([{ repo: REPO, run }], initialScoutState(), NOW);
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0].kind).toBe('ci');
    expect(plan.events[0].summary).toContain('Red alert');
    expect(plan.events[0].summary).toContain('portfolio-copilot');
    expect(plan.events[0].summary).toContain('03:32Z');
    expect(plan.events[0].link).toBe(run.url);
    expect(plan.state.ci[REPO].redSince).toBe('2026-06-12T03:32:00Z');
    expect(activeCiAlert(plan.state)?.repo).toBe(REPO);
  });

  it('files one alert on green→red and stays quiet while red persists', () => {
    let plan = planCiEvents([{ repo: REPO, run: ciRun({}) }], initialScoutState(), NOW);
    plan = planCiEvents(
      [{ repo: REPO, run: ciRun({ id: 901, conclusion: 'failure' }) }],
      plan.state,
      later(NOW, 3600_000),
    );
    expect(plan.events).toHaveLength(1);
    // A second failing run: still red, no fresh alarm, but redSince holds.
    const redSince = plan.state.ci[REPO].redSince;
    plan = planCiEvents(
      [{ repo: REPO, run: ciRun({ id: 902, conclusion: 'failure' }) }],
      plan.state,
      later(NOW, 7200_000),
    );
    expect(plan.events).toHaveLength(0);
    expect(plan.state.ci[REPO].redSince).toBe(redSince);
    expect(plan.state.ci[REPO].runId).toBe(902);
  });

  it('files a recovery with the real downtime on red→green', () => {
    const red = ciRun({ id: 901, conclusion: 'failure', startedAt: NOW });
    let plan = planCiEvents([{ repo: REPO, run: red }], initialScoutState(), NOW);
    const threeDays = later(NOW, 3 * 24 * 3600_000);
    plan = planCiEvents([{ repo: REPO, run: ciRun({ id: 902 }) }], plan.state, threeDays);
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0].summary).toContain('Condition green');
    expect(plan.events[0].summary).toContain('after 3d');
    expect(plan.state.ci[REPO].redSince).toBeNull();
    expect(activeCiAlert(plan.state)).toBeNull();
  });

  it('ignores unfinished runs and non-verdict conclusions', () => {
    const red = planCiEvents(
      [{ repo: REPO, run: ciRun({ id: 901, conclusion: 'failure' }) }],
      initialScoutState(),
      NOW,
    );
    const plan = planCiEvents(
      [
        { repo: REPO, run: ciRun({ id: 902, status: 'in_progress', conclusion: null }) },
        { repo: REPO, run: ciRun({ id: 903, conclusion: 'cancelled' }) },
      ],
      red.state,
      later(NOW, 1000),
    );
    expect(plan.events).toHaveLength(0);
    expect(plan.state.ci[REPO].conclusion).toBe('failure'); // the alert stands
  });

  it('re-observing the same run id changes nothing', () => {
    const run = ciRun({});
    let plan = planCiEvents([{ repo: REPO, run }], initialScoutState(), NOW);
    plan = planCiEvents([{ repo: REPO, run }], plan.state, later(NOW, 1000));
    expect(plan.events).toHaveLength(0);
  });

  it('upgrades a pre-CI scout state (no ci map) without crashing', () => {
    const legacy = initialScoutState() as Record<string, unknown>;
    delete legacy.ci;
    const plan = planCiEvents(
      [{ repo: REPO, run: ciRun({}) }],
      legacy as ReturnType<typeof initialScoutState>,
      NOW,
    );
    expect(plan.state.ci[REPO].conclusion).toBe('success');
  });
});

describe('humanizeDurationMs', () => {
  it('rounds to minutes, hours, then days', () => {
    expect(humanizeDurationMs(30_000)).toBe('1m');
    expect(humanizeDurationMs(41 * 60_000)).toBe('41m');
    expect(humanizeDurationMs(12 * 3600_000)).toBe('12h');
    expect(humanizeDurationMs(3 * 24 * 3600_000)).toBe('3d');
  });
});

describe('normalizeBridgeWorld', () => {
  it('upgrades a Phase 1 world (no scout state) without losing data', () => {
    const phase1 = buildInitialBridgeWorld(NOW) as Record<string, unknown>;
    delete phase1.scout;
    (phase1 as { tick: number }).tick = 42;
    const world = normalizeBridgeWorld(phase1, later(NOW, 1000));
    expect(world.tick).toBe(42);
    expect(world.scout).toEqual(initialScoutState());
    expect(world.crew.envoy.status).toBeTruthy();
  });

  it('falls back to a fresh world on garbage input', () => {
    expect(normalizeBridgeWorld(null, NOW).tick).toBe(0);
    expect(normalizeBridgeWorld('corrupt', NOW).crew.scout).toBeDefined();
  });
});
