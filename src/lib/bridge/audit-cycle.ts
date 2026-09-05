import type { Client } from '@libsql/client';
import type { LanguageModel } from 'ai';
import { auditCopy, auditReadOnlyCopy, findingFingerprint, type AuditState } from './engine/audit';
import type { BridgeEventInput } from './persistence/events';
import { createProposal, keyIsBlocked } from './persistence/proposals';
import { createMission, setMissionStatus, completeMission } from './persistence/missions';
import { finalizeSpend, reserveCall } from './persistence/budget';
import { draftRevision, DRAFT_MODEL } from './curator-draft';
import { estimateCostUsd } from './pricing';

// The Critic/Curator cycle, run from the heartbeat tick roughly daily:
// Critic audits the copy registry (deterministic, free). If something is
// flagged and the key isn't already in flight, Curator drafts a fix, Critic
// reviews the draft, and a clean draft becomes a pending proposal waiting for
// Ruslan. A draft Critic rejects twice is logged as a failed mission; the
// disagreement is public on purpose.

export type AuditCycleResult = {
  state: AuditState;
  events: BridgeEventInput[];
};

export async function runAuditCycle(deps: {
  client: Client;
  entries: Record<string, string>;
  /** Copy Critic can see but not edit (about fields, case-study sections).
      Findings here are flagged once, publicly, and left to the maintainer. */
  readOnly?: Record<string, string>;
  auditState: AuditState;
  /** Null when no gateway key: Critic still audits; Curator can't draft. */
  draftModel: LanguageModel | string | null;
  nowIso: string;
}): Promise<AuditCycleResult> {
  const { client, entries, readOnly = {}, auditState, draftModel, nowIso } = deps;
  const events: BridgeEventInput[] = [];
  const state: AuditState = { ...auditState, lastAuditAt: nowIso };

  // The read-only sweep. Fingerprints keep a standing finding at one log
  // entry for its lifetime; fixing the copy clears it, so a relapse refiles.
  const readOnlyFindings = auditReadOnlyCopy(readOnly);
  const fingerprints = readOnlyFindings.map(findingFingerprint);
  const known = new Set(state.reported ?? []);
  const fresh = readOnlyFindings.filter((f) => !known.has(findingFingerprint(f)));
  state.reported = fingerprints;
  if (fresh.length) {
    const sources = new Set(fresh.map((f) => f.key.split('#')[0]));
    events.push({
      actor: 'critic',
      kind: 'audit',
      summary: `Site-wide sweep: ${fresh.length} new ${fresh.length === 1 ? 'finding' : 'findings'} in ${sources.size} ${sources.size === 1 ? 'source' : 'sources'}. Outside my write authority; flagged for Ruslan.`,
      detail: { findings: fresh },
    });
  }

  const findings = auditCopy(entries);
  if (findings.length === 0) {
    if (readOnlyFindings.length === 0) {
      events.push({
        actor: 'critic',
        kind: 'audit',
        summary: `Copy audit clean: ${Object.keys(entries).length} curated entries and ${Object.keys(readOnly).length} site sources, 0 findings.`,
      });
    }
    return { state, events };
  }

  events.push({
    actor: 'critic',
    kind: 'audit',
    summary: `Copy audit: ${findings.length} ${findings.length === 1 ? 'finding' : 'findings'} in ${
      new Set(findings.map((f) => f.key)).size
    } ${new Set(findings.map((f) => f.key)).size === 1 ? 'entry' : 'entries'}. Curator, your move.`,
    detail: { findings },
  });

  // One proposal per cycle: the first flagged key that isn't already in flight.
  let targetKey: string | null = null;
  for (const key of [...new Set(findings.map((f) => f.key))]) {
    if (!(await keyIsBlocked(client, key, nowIso))) {
      targetKey = key;
      break;
    }
  }
  if (!targetKey) return { state, events };

  if (!draftModel) {
    events.push({
      actor: 'curator',
      kind: 'audit',
      summary: `Can't draft a fix for ${targetKey} until the gateway key is installed.`,
    });
    return { state, events };
  }

  if (!(await reserveCall(client, 'curator', 20, nowIso))) {
    events.push({
      actor: 'curator',
      kind: 'audit',
      summary:
        "Curator reached today's model budget. The finding remains queued for the next audit.",
    });
    return { state, events };
  }

  const keyFindings = findings.filter((f) => f.key === targetKey);
  const oldText = entries[targetKey];
  const missionId = await createMission(
    client,
    {
      title: `Fix copy: ${targetKey} (${keyFindings.map((f) => f.rule).join(', ')})`,
      brief: keyFindings.map((f) => f.note).join(' '),
      assignee: 'curator',
    },
    nowIso,
  );

  const draft = await draftRevision({
    key: targetKey,
    text: oldText,
    findings: keyFindings,
    model: draftModel,
  });
  if (draft.usage.inputTokens + draft.usage.outputTokens > 0) {
    await finalizeSpend(
      client,
      { agent: 'curator', ...draft.usage, costUsd: estimateCostUsd(DRAFT_MODEL, draft.usage) },
      nowIso,
    );
  }

  if (!draft.ok) {
    await completeMission(client, missionId, 'failed', draft.reason, nowIso);
    events.push({
      actor: 'critic',
      kind: 'audit',
      summary: `Mission #${missionId}: ${draft.reason} The finding on ${targetKey} stands.`,
      missionId,
    });
    return { state, events };
  }

  const proposalId = await createProposal(
    client,
    {
      key: targetKey,
      oldText,
      newText: draft.newText,
      finding: keyFindings.map((f) => f.note).join(' '),
      attempts: draft.attempts,
      missionId,
    },
    nowIso,
  );
  await setMissionStatus(client, missionId, 'awaiting_approval', nowIso);

  events.push({
    actor: 'curator',
    kind: 'audit',
    summary:
      draft.attempts > 1
        ? `Drafted a fix for ${targetKey} on the second attempt (Critic rejected the first). Proposal #${proposalId} awaits Ruslan.`
        : `Drafted a fix for ${targetKey}. Critic signed off; proposal #${proposalId} awaits Ruslan.`,
    detail: { proposalId, oldText, newText: draft.newText },
    missionId,
  });

  return { state, events };
}
