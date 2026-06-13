// Critic's audit: a deterministic style linter over the editable copy
// registry (src/data/curated.json), enforcing the same writing rules Ruslan
// holds his own prose to. Zero model calls, zero false mystery: every finding
// names the rule, the key, and the offending fragment.

export type CopyFinding = {
  key: string;
  rule: 'em-dash' | 'buzzword' | 'triplet' | 'length';
  note: string;
};

const BUZZWORDS = [
  'robust',
  'comprehensive',
  'seamless',
  'pivotal',
  'cutting-edge',
  'innovative',
  'game-changer',
  'unparalleled',
  'results-driven',
  'passionate',
  'leverage',
  'leveraged',
  'spearheaded',
  'revolutionized',
];

// Oxford-comma triplet: "A, B, and C". Middle segment may not cross a
// sentence break or another comma, so pairs and long sentences don't flag.
const TRIPLET_RE = /,[^,.;:]+,\s+and\s+\w/i;
const MAX_LEN = 400;

export function auditCopyEntry(key: string, text: string): CopyFinding[] {
  const findings: CopyFinding[] = [];

  const dash = text.match(/[—–]/);
  if (dash) {
    const at = text.indexOf(dash[0]);
    findings.push({
      key,
      rule: 'em-dash',
      note: `Em dash at "...${text.slice(Math.max(0, at - 18), at + 18)}...". House style: split the sentence or use a comma.`,
    });
  }

  const lower = text.toLowerCase();
  for (const word of BUZZWORDS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) {
      findings.push({ key, rule: 'buzzword', note: `Buzzword "${word}". Use a plain verb.` });
      break; // one buzzword finding per entry is enough to act on
    }
  }

  if (TRIPLET_RE.test(text)) {
    findings.push({
      key,
      rule: 'triplet',
      note: 'Rule-of-three list. House style: prefer pairs, singles, or quads.',
    });
  }

  if (text.length > MAX_LEN) {
    findings.push({
      key,
      rule: 'length',
      note: `${text.length} chars; cap is ${MAX_LEN}. Tighten it.`,
    });
  }

  return findings;
}

export function auditCopy(entries: Record<string, string>): CopyFinding[] {
  return Object.entries(entries).flatMap(([key, text]) => auditCopyEntry(key, text));
}

export type AuditState = {
  lastAuditAt: string | null;
};

export const initialAuditState = (): AuditState => ({ lastAuditAt: null });

export const AUDIT_INTERVAL_MS = 20 * 3600_000; // ~daily, tolerant of heartbeat drift

export function auditDue(state: AuditState, nowMs: number): boolean {
  return !state.lastAuditAt || nowMs - Date.parse(state.lastAuditAt) >= AUDIT_INTERVAL_MS;
}
