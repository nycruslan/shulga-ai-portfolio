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

type TwinConfigPatch = Partial<Omit<TwinConfig, 'updatedAt'>>;
type TwinConfigField = keyof TwinConfigPatch;

/** Upsert. Only the fields present are written; the rest keep their value. */
export async function writeTwinConfig(patch: TwinConfigPatch): Promise<TwinConfig> {
  if (!turso) throw new Error('Turso is not configured.');
  await ensureTable();
  const now = new Date().toISOString();
  await turso.execute({
    sql: "INSERT OR IGNORE INTO twin_config (id, facts_json, updated_at) VALUES (1, '{}', ?)",
    args: [now],
  });

  const columns: Array<{
    key: TwinConfigField;
    column: string;
    value: string | null | undefined;
  }> = [
    { key: 'avatarId', column: 'avatar_id', value: patch.avatarId },
    { key: 'avatarProvider', column: 'avatar_provider', value: patch.avatarProvider },
    { key: 'avatarPreviewUrl', column: 'avatar_preview_url', value: patch.avatarPreviewUrl },
    { key: 'voiceId', column: 'voice_id', value: patch.voiceId },
    { key: 'voiceName', column: 'voice_name', value: patch.voiceName },
    {
      key: 'facts',
      column: 'facts_json',
      value: Object.hasOwn(patch, 'facts')
        ? JSON.stringify(factsSchema.parse(patch.facts))
        : undefined,
    },
  ];
  const writes = columns.filter((entry) => Object.hasOwn(patch, entry.key));
  if (writes.some((entry) => entry.value === undefined)) {
    throw new Error('Twin config fields cannot be undefined.');
  }
  if (writes.length) {
    await turso.execute({
      sql: `UPDATE twin_config SET ${writes.map((entry) => `${entry.column} = ?`).join(', ')}, updated_at = ? WHERE id = 1`,
      args: [...writes.map((entry) => entry.value as string | null), now],
    });
  }

  return readTwinConfig();
}
