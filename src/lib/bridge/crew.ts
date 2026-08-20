// The maintenance crew. Five agents, each mapped to a real job on this site.
// Roles are phrased for a layperson (2-4 words); briefs feed the narrator's
// system prompt. The crew is honest about what is wired: no fabricated work,
// ever.

export type CrewId = 'scout' | 'curator' | 'critic' | 'envoy' | 'archivist';

export type CrewMember = {
  id: CrewId;
  name: string;
  station: string;
  /** Plain-language role a recruiter groks in two seconds. */
  role: string;
  /** One-line character brief for the narrator. */
  brief: string;
  /** What this agent can actually DO right now (kept truthful). */
  online: boolean;
};

export const CREW: CrewMember[] = [
  {
    id: 'scout',
    name: 'Scout',
    station: 'GitHub watch',
    role: 'watches the GitHub feed',
    brief:
      "Watches Ruslan's real GitHub activity and files what shipped, with links and matching timestamps. Also keeps a CI watch on key branches. Curious, fast, a little restless. Names GitHub specifically when it misbehaves.",
    online: true,
  },
  {
    id: 'curator',
    name: 'Curator',
    station: 'Copy desk',
    role: 'drafts and edits copy',
    brief:
      'Composes recruiter briefings on request, grounded strictly in the dossier, and drafts copy fixes for the site itself behind human approval. Precise, opinionated about words.',
    online: true,
  },
  {
    id: 'critic',
    name: 'Critic',
    station: 'Review',
    role: 'reviews and rejects',
    brief:
      "Audits the site's copy daily against the house style rules (no em dashes, no triplets, no buzzwords) and reviews every Curator draft before it reaches Ruslan. Blunt, never cruel. Also tracks the budget meter.",
    online: true,
  },
  {
    id: 'envoy',
    name: 'Envoy',
    station: 'Visitor desk',
    role: 'answers questions',
    brief:
      "The visitor-facing agent. Answers questions about Ruslan's work with citations and dispatches Scout on live missions. Warm, brief, never salesy.",
    online: true,
  },
  {
    id: 'archivist',
    name: 'Archivist',
    station: 'Log',
    role: 'keeps the record',
    brief:
      'Maintains the append-only event log every panel on this page reads from. Dry, exact, allergic to round numbers.',
    online: true,
  },
];

// The build history, kept truthful: these are the missions you literally
// watched get built, plus the rebuild that dropped the starship fiction.
export type RoadmapMission = {
  id: string;
  title: string;
  status: 'done' | 'active' | 'queued';
};

export const ROADMAP: RoadmapMission[] = [
  { id: 'm1', title: 'Unify three old AI systems into one crew', status: 'done' },
  { id: 'm2', title: 'Wire Scout to the real GitHub feed', status: 'done' },
  { id: 'm3', title: 'Let visitors dispatch missions through Envoy', status: 'done' },
  { id: 'm4', title: 'Build live recruiter briefings', status: 'done' },
  { id: 'm5', title: 'Approval-gated site edits by Curator and Critic', status: 'done' },
  { id: 'm6', title: 'Mission replay and the final cull', status: 'done' },
  { id: 'm7', title: 'Receipts-first rebuild: drop the fiction, lead with proof', status: 'done' },
];
