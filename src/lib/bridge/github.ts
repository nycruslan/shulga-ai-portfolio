// Scout's sensors: the public GitHub events feed. Parsing is pure (testable on
// fixtures); fetching is a thin wrapper. The public API omits commit messages
// unless authenticated, so pushes are best-effort enriched with one commit
// lookup each, capped, and degrade to SHA-only summaries. Every activity
// carries the html URL and GitHub's own timestamp — those are the receipts.

export type ScoutActivity = {
  /** GitHub event id (numeric string, strictly increasing). */
  id: string;
  kind: 'push' | 'pr' | 'release' | 'repo';
  repo: string;
  /** GitHub's timestamp for the event, ISO. */
  at: string;
  /** Deep link to the real artifact (commit, PR, release, repo). */
  url: string;
  /** Human line: commit message first line, PR title, release name... */
  title: string;
  /** Commit sha for pushes (short). */
  sha?: string;
};

type GithubEvent = {
  id: string;
  type: string;
  repo: { name: string };
  created_at: string;
  payload: {
    ref?: string;
    head?: string;
    size?: number;
    commits?: Array<{ sha: string; message: string }>;
    action?: string;
    pull_request?: { html_url: string; title: string; merged?: boolean };
    release?: { html_url: string; name?: string; tag_name?: string };
    ref_type?: string;
  };
};

const API = 'https://api.github.com';
const UA = 'shulga-ai-portfolio-bridge';

/** Pure: GitHub events JSON -> activities newer than the cursor, oldest first. */
export function parseEvents(events: GithubEvent[], cursor: string | null): ScoutActivity[] {
  const out: ScoutActivity[] = [];
  for (const e of events) {
    if (cursor && BigInt(e.id) <= BigInt(cursor)) continue;
    const repo = e.repo.name;
    if (e.type === 'PushEvent') {
      // Authenticated payloads list commits; public ones only carry head/before.
      const head = e.payload.commits?.at(-1)?.sha ?? e.payload.head;
      if (!head) continue;
      const message = e.payload.commits?.at(-1)?.message;
      const branch = e.payload.ref?.replace('refs/heads/', '') ?? '';
      out.push({
        id: e.id,
        kind: 'push',
        repo,
        at: e.created_at,
        url: `https://github.com/${repo}/commit/${head}`,
        title: message?.split('\n')[0] ?? `${branch} advanced to ${head.slice(0, 7)}`,
        sha: head.slice(0, 7),
      });
    } else if (e.type === 'PullRequestEvent' && e.payload.pull_request) {
      const action = e.payload.action;
      if (action !== 'opened' && action !== 'closed') continue;
      const merged = action === 'closed' && e.payload.pull_request.merged;
      if (action === 'closed' && !merged) continue;
      out.push({
        id: e.id,
        kind: 'pr',
        repo,
        at: e.created_at,
        url: e.payload.pull_request.html_url,
        title: `${merged ? 'Merged' : 'Opened'} PR: ${e.payload.pull_request.title}`,
      });
    } else if (e.type === 'ReleaseEvent' && e.payload.release) {
      out.push({
        id: e.id,
        kind: 'release',
        repo,
        at: e.created_at,
        url: e.payload.release.html_url,
        title: `Released ${e.payload.release.name || e.payload.release.tag_name || ''}`.trim(),
      });
    } else if (e.type === 'CreateEvent' && e.payload.ref_type === 'repository') {
      out.push({
        id: e.id,
        kind: 'repo',
        repo,
        at: e.created_at,
        url: `https://github.com/${repo}`,
        title: `New repository: ${repo}`,
      });
    }
  }
  // The API returns newest first; the log wants chronological order.
  return out.reverse();
}

function headers(token?: string): Record<string, string> {
  return {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// --- CI sensor -------------------------------------------------------------
// Scout's second instrument: the latest Actions run on each watched default
// branch. One request per repo per sweep, so even unauthenticated (60/h) the
// budget is never in danger at the 30-minute check interval.

export type CiRun = {
  id: number;
  /** Workflow name, e.g. "ci". */
  workflow: string;
  /** The run's display title (usually the commit subject). */
  title: string;
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion: string | null;
  url: string;
  startedAt: string;
};

type WorkflowRunsResponse = {
  workflow_runs?: Array<{
    id: number;
    name: string | null;
    display_title: string | null;
    status: string;
    conclusion: string | null;
    html_url: string;
    run_started_at: string;
  }>;
};

/**
 * Latest workflow run on a branch, or null when the repo has none. Throws on
 * network/API failure; the caller degrades to an honest status line, exactly
 * like the events sweep.
 */
export async function fetchLatestCiRun(
  repo: string,
  branch: string,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CiRun | null> {
  const res = await fetchImpl(
    `${API}/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1&exclude_pull_requests=true`,
    { headers: headers(token) },
  );
  if (!res.ok) throw new Error(`GitHub runs API (${repo}): HTTP ${res.status}`);
  const run = ((await res.json()) as WorkflowRunsResponse).workflow_runs?.[0];
  if (!run) return null;
  return {
    id: run.id,
    workflow: run.name ?? 'workflow',
    title: run.display_title ?? '',
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    startedAt: run.run_started_at,
  };
}

const ENRICH_CAP = 4;

/**
 * Fetch activities newer than the cursor. Push titles missing a commit message
 * (public payloads) are enriched with one commit lookup each, newest-first,
 * capped at ENRICH_CAP calls. Throws on network/API failure; the caller turns
 * that into an honest "GitHub isn't responding" status.
 */
export async function fetchUserActivity(
  username: string,
  cursor: string | null,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ScoutActivity[]> {
  const res = await fetchImpl(`${API}/users/${username}/events/public?per_page=30`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`GitHub events API: HTTP ${res.status}`);
  const activities = parseEvents((await res.json()) as GithubEvent[], cursor);

  let enriched = 0;
  for (const a of [...activities].reverse()) {
    if (a.kind !== 'push' || !a.sha || !a.title.includes('advanced to')) continue;
    if (enriched >= ENRICH_CAP) break;
    enriched += 1;
    try {
      const c = await fetchImpl(`${API}/repos/${a.repo}/commits/${a.sha}`, {
        headers: headers(token),
      });
      if (!c.ok) continue;
      const data = (await c.json()) as { commit?: { message?: string } };
      const message = data.commit?.message?.split('\n')[0];
      if (message) a.title = message;
    } catch {
      /* enrichment is best-effort; the SHA summary stands */
    }
  }
  return activities;
}
