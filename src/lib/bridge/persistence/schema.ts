import type { Client } from '@libsql/client';

// The Bridge's durable state. Unlike the legacy single-row world blobs, state
// is split into proper tables so the activity feed, ship's log, and replay
// scrubber all read from one append-only event stream.

export const BRIDGE_SCHEMA = [
  // Append-only activity stream. Written from agent onStepFinish callbacks and
  // engine ticks; feeds the live feed, ship's log, and replay.
  `CREATE TABLE IF NOT EXISTS bridge_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at TEXT NOT NULL,
     actor TEXT NOT NULL,
     kind TEXT NOT NULL,
     summary TEXT NOT NULL,
     detail TEXT,
     link TEXT,
     mission_id INTEGER,
     generation_id TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_bridge_events_mission ON bridge_events(mission_id)`,

  // Visitor-attributable units of work.
  `CREATE TABLE IF NOT EXISTS bridge_missions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('queued','running','awaiting_approval','done','failed')),
     title TEXT NOT NULL,
     brief TEXT NOT NULL,
     assignee TEXT,
     visitor_id TEXT,
     outcome TEXT
   )`,

  // UIMessage JSON, one row per message, grouped by conversation. Always
  // UIMessages, never ModelMessages (see persistence notes in messages.ts).
  `CREATE TABLE IF NOT EXISTS bridge_messages (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     message TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_bridge_messages_conversation ON bridge_messages(conversation_id, created_at)`,

  // Crew memory and personality, one row per agent.
  `CREATE TABLE IF NOT EXISTS bridge_crew (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     role TEXT NOT NULL,
     state TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  // Per-day, per-agent spend. cost_usd comes from the AI Gateway generation
  // metadata so every event links to its real cost.
  `CREATE TABLE IF NOT EXISTS bridge_budget (
     day TEXT NOT NULL,
     agent TEXT NOT NULL,
     llm_calls INTEGER NOT NULL DEFAULT 0,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL DEFAULT 0,
     PRIMARY KEY (day, agent)
   )`,

  // Curator's copy-change proposals: drafted by the crew, decided by Ruslan,
  // shipped as real commits. The queue is durable because the approver is a
  // human on his own schedule, not the visitor in a chat stream.
  `CREATE TABLE IF NOT EXISTS bridge_proposals (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending','shipped','rejected','failed')),
     key TEXT NOT NULL,
     old_text TEXT NOT NULL,
     new_text TEXT NOT NULL,
     finding TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 1,
     mission_id INTEGER,
     commit_url TEXT,
     decided_by TEXT
   )`,
];

const ready: WeakMap<Client, Promise<void>> = new WeakMap();

export function ensureBridgeSchema(client: Client): Promise<void> {
  let p = ready.get(client);
  if (!p) {
    p = client.batch(BRIDGE_SCHEMA, 'write').then(() => undefined);
    ready.set(client, p);
  }
  return p;
}
