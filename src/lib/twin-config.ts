import { turso } from './turso-client';
import {
  EMPTY_CONFIG,
  EMPTY_FACTS,
  factsSchema,
  type TwinConfig,
  type TwinFacts,
} from './twin-schema';

/**
 * Persistence for the twin's config: which face, which voice, and who the
 * twin thinks it is.
 *
 * Single row (id = 1). This app is the WRITER; the agent worker never reads
 * Turso — the config rides along as agent-dispatch metadata when a session
 * starts, so the worker needs no database credentials and no polling.
 *
 * The shape and the pure logic over it live in twin-schema.ts, which has no
 * Turso import and is therefore unit-testable.
 */

export {
  buildPersona,
  completeness,
  EMPTY_CONFIG,
  EMPTY_FACTS,
  factsSchema,
  type TwinConfig,
  type TwinFacts,
} from './twin-schema';

async function ensureTable(): Promise<void> {
  await turso!.execute(
    'CREATE TABLE IF NOT EXISTS twin_config (' +
      'id INTEGER PRIMARY KEY CHECK (id = 1), ' +
      'avatar_id TEXT, avatar_provider TEXT, avatar_preview_url TEXT, ' +
      'voice_id TEXT, voice_name TEXT, ' +
      "facts_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT)",
  );
}

export async function readTwinConfig(): Promise<TwinConfig> {
  if (!turso) return EMPTY_CONFIG;
  try {
    await ensureTable();
    const rs = await turso.execute(
      'SELECT avatar_id, avatar_provider, avatar_preview_url, voice_id, voice_name, ' +
        'facts_json, updated_at FROM twin_config WHERE id = 1',
    );
    const r = rs.rows[0];
    if (!r) return EMPTY_CONFIG;

    let facts: TwinFacts = EMPTY_FACTS;
    try {
      facts = factsSchema.parse(JSON.parse(String(r.facts_json ?? '{}')));
    } catch {
      // A malformed blob shouldn't take the whole console down.
    }

    const provider = r.avatar_provider == null ? null : String(r.avatar_provider);
    return {
      avatarId: r.avatar_id == null ? null : String(r.avatar_id),
      avatarProvider: provider === 'anam' || provider === 'liveavatar' ? provider : null,
      avatarPreviewUrl: r.avatar_preview_url == null ? null : String(r.avatar_preview_url),
      voiceId: r.voice_id == null ? null : String(r.voice_id),
      voiceName: r.voice_name == null ? null : String(r.voice_name),
      facts,
      updatedAt: r.updated_at == null ? null : String(r.updated_at),
    };
  } catch (err) {
    console.error('[twin-config] read failed:', err);
    return EMPTY_CONFIG;
  }
}

/** Upsert. Only the fields present are written; the rest keep their value. */
export async function writeTwinConfig(patch: Partial<TwinConfig>): Promise<TwinConfig> {
  if (!turso) throw new Error('Turso is not configured.');
  await ensureTable();

  const current = await readTwinConfig();
  const next: TwinConfig = {
    ...current,
    ...patch,
    facts: patch.facts ? factsSchema.parse(patch.facts) : current.facts,
    updatedAt: new Date().toISOString(),
  };

  await turso.execute({
    sql:
      'INSERT INTO twin_config (id, avatar_id, avatar_provider, avatar_preview_url, ' +
      'voice_id, voice_name, facts_json, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET avatar_id = excluded.avatar_id, ' +
      'avatar_provider = excluded.avatar_provider, ' +
      'avatar_preview_url = excluded.avatar_preview_url, ' +
      'voice_id = excluded.voice_id, voice_name = excluded.voice_name, ' +
      'facts_json = excluded.facts_json, updated_at = excluded.updated_at',
    args: [
      next.avatarId,
      next.avatarProvider,
      next.avatarPreviewUrl,
      next.voiceId,
      next.voiceName,
      JSON.stringify(next.facts),
      next.updatedAt,
    ],
  });

  return next;
}
