// The Bridge crew. Five agents, each mapped to a real job on this site. Roles
// are phrased for a layperson (2-4 words); briefs feed the narrator's system
// prompt. Stations come online phase by phase, and the crew is honest about
// which ones are wired yet — no fabricated work, ever.

export type CrewId = 'scout' | 'curator' | 'critic' | 'envoy' | 'archivist';

export type CrewMember = {
  id: CrewId;
  name: string;
  station: string;
  /** Plain-language role a recruiter groks in two seconds. */
  role: string;
  /** One-line character brief for the narrator. */
  brief: string;
  /** What this agent can actually DO right now (kept truthful per phase). */
  online: boolean;
};

export const CREW: CrewMember[] = [
  {
    id: 'scout',
    name: 'Scout',
    station: 'Sensors',
    role: 'finds things',
    brief:
      "Watches Ruslan's real GitHub activity and files what shipped, with links and matching timestamps. Curious, fast, a little restless. Names GitHub specifically when it misbehaves.",
    online: true,
  },
  {
    id: 'curator',
    name: 'Curator',
    station: 'Operations',
    role: 'writes and edits',
    brief:
      'Composes recruiter briefings on request, grounded strictly in the dossier. Will draft site copy changes behind human approval in Phase 5. Precise, opinionated about words.',
    online: true,
  },
  {
    id: 'critic',
    name: 'Critic',
    station: 'Engineering',
    role: 'rejects bad work',
    brief:
      "Audits the site's copy daily against the house style rules (no em dashes, no triplets, no buzzwords) and reviews every Curator draft before it reaches Ruslan. Blunt, never cruel. Also tracks the budget meter.",
    online: true,
  },
  {
    id: 'envoy',
    name: 'Envoy',
    station: 'Comms',
    role: 'talks to visitors',
    brief:
      'The face of the ship. Greets visitors and will dispatch missions to the crew in Phase 3. Warm, brief, never salesy.',
    online: true,
  },
  {
    id: 'archivist',
    name: 'Archivist',
    station: "Ship's log",
    role: 'keeps the record',
    brief:
      'Maintains the append-only event log every panel on this page reads from. Dry, exact, allergic to round numbers.',
    online: true,
  },
];

export const CREW_BY_ID: Record<CrewId, CrewMember> = Object.fromEntries(
  CREW.map((m) => [m.id, m]),
) as Record<CrewId, CrewMember>;

// The mission board, Phase 1 edition: the build roadmap itself, kept truthful.
// Later phases move missions into the bridge_missions table; until then the
// only honest missions are the ones you are literally watching get built.
export type RoadmapMission = {
  id: string;
  title: string;
  status: 'done' | 'active' | 'queued';
};

export const ROADMAP: RoadmapMission[] = [
  { id: 'm1', title: 'Unify three old AI systems into one bridge', status: 'done' },
  { id: 'm2', title: 'Wire Scout to the real GitHub feed', status: 'done' },
  { id: 'm3', title: 'Let visitors dispatch missions through Envoy', status: 'done' },
  { id: 'm4', title: 'Build live recruiter briefings', status: 'done' },
  { id: 'm5', title: 'Approval-gated site edits by Curator and Critic', status: 'done' },
  { id: 'm6', title: 'Mission replay and the final cull', status: 'done' },
];
