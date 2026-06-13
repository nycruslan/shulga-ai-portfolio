// The only code path with write access to anything: an approved proposal
// becomes one commit to the whitelisted copy registry, via the GitHub
// Contents API, authored through the same pipeline as Ruslan's own pushes
// (Vercel redeploys on the commit). Whitelist is hard: this module can touch
// exactly one file, and only keys that already exist in it.

export const CURATED_PATH = 'src/data/curated.json';
export const DEFAULT_REPO = 'nycruslan/shulga-ai-portfolio';

const API = 'https://api.github.com';
const UA = 'shulga-ai-portfolio-bridge';

export type ApplyResult = { commitUrl: string; commitSha: string };

export async function applyCopyChange(options: {
  token: string;
  repo?: string;
  key: string;
  oldText: string;
  newText: string;
  proposalId: number;
  fetchImpl?: typeof fetch;
}): Promise<ApplyResult> {
  const { token, repo = DEFAULT_REPO, key, oldText, newText, proposalId } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
  };

  const fileRes = await fetchImpl(`${API}/repos/${repo}/contents/${CURATED_PATH}`, { headers });
  if (!fileRes.ok) throw new Error(`GitHub read failed: HTTP ${fileRes.status}`);
  const file = (await fileRes.json()) as { content: string; sha: string };

  const current = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) as Record<
    string,
    string
  >;
  if (!(key in current)) throw new Error(`Key "${key}" is not in the copy registry.`);
  if (current[key] !== oldText) {
    throw new Error('The live copy changed since this draft. Re-audit needed.');
  }

  const updated = { ...current, [key]: newText };
  const body = {
    message: `copy(${key}): style fix drafted by Curator, approved by Ruslan (proposal #${proposalId})`,
    content: Buffer.from(JSON.stringify(updated, null, 2) + '\n', 'utf8').toString('base64'),
    sha: file.sha,
  };

  const putRes = await fetchImpl(`${API}/repos/${repo}/contents/${CURATED_PATH}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!putRes.ok) throw new Error(`GitHub write failed: HTTP ${putRes.status}`);
  const result = (await putRes.json()) as { commit: { sha: string; html_url: string } };
  return { commitUrl: result.commit.html_url, commitSha: result.commit.sha };
}
