import { describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import {
  auditCopy,
  auditCopyEntry,
  auditDue,
  auditReadOnlyCopy,
  findingFingerprint,
  initialAuditState,
  repairEmDashes,
} from './engine/audit';
import { runAuditCycle } from './audit-cycle';
import { draftRevision } from './curator-draft';
import { applyCopyChange, CURATED_PATH } from './github-write';
import {
  listProposals,
  keyIsBlocked,
  decideProposal,
  createProposal,
  claimProposal,
} from './persistence/proposals';
import { listMissions } from './persistence/missions';
import curated from '../../data/curated.json';

const NOW = '2026-06-12T12:00:00.000Z';
const db = () => createClient({ url: ':memory:' });
const usage = {
  inputTokens: { total: 200, noCache: 200, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 80, text: 80, reasoning: undefined },
  totalTokens: 280,
} as const;
const stopFinish = { unified: 'stop', raw: 'stop' } as const;

const textResult = (text: string): LanguageModelV3GenerateResult => ({
  content: [{ type: 'text', text }],
  finishReason: stopFinish,
  usage,
  warnings: [],
});

function mockDrafter(...replies: string[]) {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () =>
      textResult(JSON.stringify({ newText: replies[Math.min(call++, replies.length - 1)] })),
  });
}

describe('audit rules', () => {
  it('flags em dashes, buzzwords, triplets, and over-length; passes clean copy', () => {
    expect(auditCopyEntry('k', 'Plain and clean. Two short sentences.')).toEqual([]);
    expect(auditCopyEntry('k', 'A thing — another thing.').map((f) => f.rule)).toContain('em-dash');
    expect(auditCopyEntry('k', 'Our robust platform.').map((f) => f.rule)).toContain('buzzword');
    expect(auditCopyEntry('k', 'It parses, validates, and ships.').map((f) => f.rule)).toContain(
      'triplet',
    );
    expect(auditCopyEntry('k', 'x'.repeat(401)).map((f) => f.rule)).toContain('length');
  });

  it('does not flag pairs or two-comma sentences without "and" lists', () => {
    expect(auditCopyEntry('k', 'It parses and ships.')).toEqual([]);
    expect(auditCopyEntry('k', 'First, we read. Then, we write and verify.')).toEqual([]);
  });

  it('the shipped copy registry passes its own audit (regression guard)', () => {
    expect(auditCopy(curated as Record<string, string>)).toEqual([]);
  });

  it('repairEmDashes splits on dashes and leaves clean copy untouched', () => {
    expect(repairEmDashes('A thing — another thing.')).toBe('A thing. Another thing.');
    // Only continuations are recapitalised; the opening segment is left as-is.
    expect(repairEmDashes('one – two – three')).toBe('one. Two. Three');
    expect(repairEmDashes('No dashes here, just commas.')).toBe('No dashes here, just commas.');
    // The result must satisfy the auditor it feeds.
    expect(auditCopyEntry('k', repairEmDashes('Clean idea — but a dash.'))).toEqual([]);
    // It only touches dashes: a buzzword still stands for the model to fix.
    expect(
      auditCopyEntry('k', repairEmDashes('A robust idea — really.')).map((f) => f.rule),
    ).toEqual(['buzzword']);
  });

  it('audit cadence is roughly daily', () => {
    const s = initialAuditState();
    expect(auditDue(s, Date.parse(NOW))).toBe(true);
    s.lastAuditAt = NOW;
    expect(auditDue(s, Date.parse(NOW) + 3600_000)).toBe(false);
    expect(auditDue(s, Date.parse(NOW) + 21 * 3600_000)).toBe(true);
  });
});

describe('draftRevision (Critic reviews Curator)', () => {
  const findings = auditCopyEntry('k', 'A thing — another thing.');

  it('accepts a clean draft on the first attempt', async () => {
    const out = await draftRevision({
      key: 'k',
      text: 'A thing — another thing.',
      findings,
      model: mockDrafter('A thing. Another thing.'),
    });
    expect(out).toMatchObject({ ok: true, newText: 'A thing. Another thing.', attempts: 1 });
  });

  it('retries when the first draft still violates, then accepts', async () => {
    const out = await draftRevision({
      key: 'k',
      text: 'A thing — another thing.',
      findings,
      // A buzzword the mechanical repair can't touch, so it genuinely retries.
      model: mockDrafter('Still a robust draft.', 'Fixed now. Clean copy.'),
    });
    expect(out).toMatchObject({ ok: true, attempts: 2 });
  });

  it('mechanically repairs an em dash the model reintroduces, no retry needed', async () => {
    const out = await draftRevision({
      key: 'k',
      text: 'A thing — another thing.',
      findings,
      model: mockDrafter('Clean idea — but with a dash.'),
    });
    expect(out).toMatchObject({ ok: true, attempts: 1 });
    expect((out as { newText: string }).newText).not.toMatch(/[—–]/);
  });

  it('gives up after three rejected drafts, honestly', async () => {
    const out = await draftRevision({
      key: 'k',
      text: 'A thing — another thing.',
      findings,
      model: mockDrafter('Bad robust one.', 'Bad robust two.', 'Bad robust three.'),
    });
    expect(out).toMatchObject({ ok: false, attempts: 3 });
    expect((out as { reason: string }).reason).toContain('rejected the draft 3 times');
  });
});

describe('read-only sweep rules', () => {
  it('keeps dash/buzzword/triplet findings but never flags length', () => {
    const entries = {
      'work/x#Long': 'y'.repeat(500),
      'about#Summary': 'A robust thing — it parses, validates, and ships.',
    };
    const rules = auditReadOnlyCopy(entries).map((f) => f.rule);
    expect(rules).not.toContain('length');
    expect(rules).toEqual(expect.arrayContaining(['em-dash', 'buzzword', 'triplet']));
  });

  it('fingerprints are stable per key and rule', () => {
    const [f] = auditReadOnlyCopy({ 'about#Summary': 'A dash — here.' });
    expect(findingFingerprint(f)).toBe('about#Summary:em-dash');
  });
});

describe('runAuditCycle', () => {
  const dirty = { intro: 'We leverage a robust platform — seamlessly.' };
  const clean = { intro: 'Plain copy. Nothing to flag.' };

  it('files a clean-audit event and stops when nothing is flagged', async () => {
    const client = db();
    const { state, events } = await runAuditCycle({
      client,
      entries: clean,
      auditState: initialAuditState(),
      draftModel: mockDrafter('unused'),
      nowIso: NOW,
    });
    expect(state.lastAuditAt).toBe(NOW);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toContain('0 findings');
    expect(await listProposals(client)).toHaveLength(0);
  });

  it('flags read-only findings once, then holds until the copy changes', async () => {
    const client = db();
    const readOnly = { 'about#Summary': 'A seamless dash — everywhere.' };

    const first = await runAuditCycle({
      client,
      entries: clean,
      readOnly,
      auditState: initialAuditState(),
      draftModel: mockDrafter('unused'),
      nowIso: NOW,
    });
    const sweep = first.events.find((e) => e.summary.includes('Site-wide sweep'));
    expect(sweep).toBeDefined();
    expect(sweep!.summary).toContain('2 new findings'); // em-dash + buzzword
    expect(sweep!.summary).toContain('flagged for Ruslan');
    // No proposal or mission: read-only findings are outside the write path.
    expect(await listProposals(client)).toHaveLength(0);
    expect(await listMissions(client)).toHaveLength(0);

    // Same findings next day: no repeat drumbeat, and no clean-audit claim.
    const second = await runAuditCycle({
      client,
      entries: clean,
      readOnly,
      auditState: first.state,
      draftModel: mockDrafter('unused'),
      nowIso: NOW,
    });
    expect(second.events).toHaveLength(0);

    // Fixed copy clears the fingerprint; a relapse would file again.
    const third = await runAuditCycle({
      client,
      entries: clean,
      readOnly: { 'about#Summary': 'Fixed. Plain and calm.' },
      auditState: second.state,
      draftModel: mockDrafter('unused'),
      nowIso: NOW,
    });
    expect(third.state.reported).toEqual([]);
    expect(third.events[0].summary).toContain('Copy audit clean');
    expect(third.events[0].summary).toContain('1 site sources');

    const relapse = await runAuditCycle({
      client,
      entries: clean,
      readOnly,
      auditState: third.state,
      draftModel: mockDrafter('unused'),
      nowIso: NOW,
    });
    expect(relapse.events[0].summary).toContain('Site-wide sweep');
  });

  it('upgrades a pre-sweep audit state (no reported list) without crashing', async () => {
    const legacy = { lastAuditAt: null } as ReturnType<typeof initialAuditState>;
    const { state } = await runAuditCycle({
      client: db(),
      entries: clean,
      readOnly: { 'about#Summary': 'A dash — here.' },
      auditState: legacy,
      draftModel: mockDrafter('unused'),
      nowIso: NOW,
    });
    expect(state.reported).toEqual(['about#Summary:em-dash']);
  });

  it('full cycle: finding -> draft -> Critic sign-off -> pending proposal + awaiting mission', async () => {
    const client = db();
    const { events } = await runAuditCycle({
      client,
      entries: dirty,
      auditState: initialAuditState(),
      draftModel: mockDrafter('We built a plain platform. It just works.'),
      nowIso: NOW,
    });

    const [proposal] = await listProposals(client, 'pending');
    expect(proposal).toMatchObject({ key: 'intro', status: 'pending', attempts: 1 });
    expect(proposal.newText).toContain('plain platform');

    const [mission] = await listMissions(client);
    expect(mission.status).toBe('awaiting_approval');
    expect(mission.assignee).toBe('curator');

    expect(events.some((e) => e.actor === 'critic' && e.summary.includes('finding'))).toBe(true);
    expect(events.some((e) => e.actor === 'curator' && e.summary.includes('awaits Ruslan'))).toBe(
      true,
    );
  });

  it('logs the public disagreement when Critic keeps rejecting; no proposal filed', async () => {
    const client = db();
    const { events } = await runAuditCycle({
      client,
      entries: dirty,
      auditState: initialAuditState(),
      // Buzzwords survive the mechanical repair, so Critic rejects every draft.
      draftModel: mockDrafter('still robust', 'again robust'),
      nowIso: NOW,
    });
    expect(await listProposals(client)).toHaveLength(0);
    expect((await listMissions(client))[0].status).toBe('failed');
    expect(events.some((e) => e.summary.includes('rejected the draft 3 times'))).toBe(true);
  });

  it('skips drafting but keeps auditing when no model is available', async () => {
    const client = db();
    const { events } = await runAuditCycle({
      client,
      entries: dirty,
      auditState: initialAuditState(),
      draftModel: null,
      nowIso: NOW,
    });
    expect(events.some((e) => e.summary.includes('gateway key'))).toBe(true);
    expect(await listProposals(client)).toHaveLength(0);
  });

  it('does not re-propose a key that is pending or recently decided', async () => {
    const client = db();
    const id = await createProposal(
      client,
      { key: 'intro', oldText: 'a', newText: 'b', finding: 'f', attempts: 1 },
      NOW,
    );
    expect(await keyIsBlocked(client, 'intro', NOW)).toBe(true);
    const claimToken = crypto.randomUUID();
    await claimProposal(client, id, claimToken, NOW);
    await decideProposal(client, id, { status: 'rejected', decidedBy: 'ruslan', claimToken }, NOW);
    expect(await keyIsBlocked(client, 'intro', NOW)).toBe(true); // 7-day cool-off
    const later = new Date(Date.parse(NOW) + 8 * 24 * 3600_000).toISOString();
    expect(await keyIsBlocked(client, 'intro', later)).toBe(false);
  });
});

describe('proposal claims', () => {
  it('lets one approver claim and requires that token to decide', async () => {
    const client = db();
    const id = await createProposal(
      client,
      { key: 'intro', oldText: 'a', newText: 'b', finding: 'f', attempts: 1 },
      NOW,
    );
    const tokens = [crypto.randomUUID(), crypto.randomUUID()];
    const claims = await Promise.all(tokens.map((token) => claimProposal(client, id, token, NOW)));
    expect(claims.filter(Boolean)).toHaveLength(1);

    const winningToken = tokens[claims.findIndex(Boolean)];
    const losingToken = tokens[claims.findIndex((claimed) => !claimed)];
    expect(
      await decideProposal(
        client,
        id,
        { status: 'rejected', decidedBy: 'other', claimToken: losingToken },
        NOW,
      ),
    ).toBe(false);

    const replacementToken = crypto.randomUUID();
    const afterExpiry = new Date(Date.parse(NOW) + 2 * 60_000 + 1).toISOString();
    expect(await claimProposal(client, id, replacementToken, afterExpiry)).toBe(true);
    expect(
      await decideProposal(
        client,
        id,
        { status: 'rejected', decidedBy: 'stale', claimToken: winningToken },
        afterExpiry,
      ),
    ).toBe(false);
    expect(
      await decideProposal(
        client,
        id,
        { status: 'rejected', decidedBy: 'owner', claimToken: replacementToken },
        afterExpiry,
      ),
    ).toBe(true);
  });
});

describe('applyCopyChange (stubbed GitHub)', () => {
  const registry = { intro: 'old text', motto: 'unchanged' };
  const b64 = Buffer.from(JSON.stringify(registry, null, 2)).toString('base64');

  function stubGithub(opts: { putStatus?: number } = {}) {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const impl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'GET') {
        return new Response(JSON.stringify({ content: b64, sha: 'file-sha' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          commit: { sha: 'newsha123', html_url: 'https://github.com/x/commit/newsha123' },
        }),
        { status: opts.putStatus ?? 200 },
      );
    };
    return { calls, impl };
  }

  it('commits the single whitelisted file with the key swapped', async () => {
    const { calls, impl } = stubGithub();
    const result = await applyCopyChange({
      token: 't',
      key: 'intro',
      oldText: 'old text',
      newText: 'new text',
      proposalId: 7,
      fetchImpl: impl,
    });
    expect(result.commitUrl).toContain('newsha123');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toContain(CURATED_PATH);
    const committed = JSON.parse(
      Buffer.from((put.body as { content: string }).content, 'base64').toString('utf8'),
    );
    expect(committed.intro).toBe('new text');
    expect(committed.motto).toBe('unchanged');
    expect((put.body as { message: string }).message).toContain('proposal #7');
  });

  it('refuses when the live text drifted from the draft baseline', async () => {
    const { impl } = stubGithub();
    await expect(
      applyCopyChange({
        token: 't',
        key: 'intro',
        oldText: 'STALE baseline',
        newText: 'new',
        proposalId: 1,
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/changed since this draft/);
  });

  it('refuses keys outside the registry', async () => {
    const { impl } = stubGithub();
    await expect(
      applyCopyChange({
        token: 't',
        key: 'not_a_key',
        oldText: 'x',
        newText: 'y',
        proposalId: 1,
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/not in the copy registry/);
  });
});
