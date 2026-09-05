import type { Client } from '@libsql/client';
import { safeValidateUIMessages, type UIMessage } from 'ai';
import { ensureBridgeSchema } from './schema';

// Conversation persistence. Always UIMessages (never ModelMessages — the v6
// persistence rule), stored as one row per conversation holding the whole
// message array: conversations are small (rate-limited), writes are atomic,
// and ordering is free. This module is the single seam to swap when the v7
// "app messages" persistence model lands.
//
// Column mapping on bridge_messages: id = conversation id (PK),
// conversation_id = visitor id (attribution), message = JSON UIMessage[].

export async function saveConversation(
  client: Client,
  conversationId: string,
  ownerHash: string,
  visitorId: string,
  messages: UIMessage[],
  nowIso = new Date().toISOString(),
): Promise<boolean> {
  await ensureBridgeSchema(client);
  const rs = await client.execute({
    sql: `INSERT INTO bridge_messages (id, conversation_id, owner_hash, created_at, message)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            created_at = excluded.created_at,
            message = excluded.message
          WHERE bridge_messages.owner_hash = excluded.owner_hash`,
    args: [conversationId, visitorId, ownerHash, nowIso, JSON.stringify(messages)],
  });
  return rs.rowsAffected === 1;
}

/** Returns null when the id exists but belongs to a different browser session. */
export async function loadConversation(
  client: Client,
  conversationId: string,
  ownerHash: string,
): Promise<UIMessage[] | null> {
  await ensureBridgeSchema(client);
  const rs = await client.execute({
    sql: `SELECT owner_hash, message FROM bridge_messages WHERE id = ?`,
    args: [conversationId],
  });
  const row = rs.rows[0];
  if (!row) return [];
  if (row.owner_hash !== ownerHash) return null;
  try {
    const parsed = JSON.parse(String(row.message));
    const validated = await safeValidateUIMessages({ messages: parsed });
    return validated.success ? validated.data : [];
  } catch {
    return [];
  }
}
