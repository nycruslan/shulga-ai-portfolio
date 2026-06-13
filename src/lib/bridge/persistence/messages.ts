import type { Client } from '@libsql/client';
import type { UIMessage } from 'ai';
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
  visitorId: string,
  messages: UIMessage[],
  nowIso = new Date().toISOString(),
): Promise<void> {
  await ensureBridgeSchema(client);
  await client.execute({
    sql: `INSERT OR REPLACE INTO bridge_messages (id, conversation_id, created_at, message)
          VALUES (?, ?, ?, ?)`,
    args: [conversationId, visitorId, nowIso, JSON.stringify(messages)],
  });
}

export async function loadConversation(
  client: Client,
  conversationId: string,
): Promise<UIMessage[]> {
  await ensureBridgeSchema(client);
  const rs = await client.execute({
    sql: `SELECT message FROM bridge_messages WHERE id = ?`,
    args: [conversationId],
  });
  const raw = rs.rows[0]?.message;
  if (raw == null) return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? (parsed as UIMessage[]) : [];
  } catch {
    return [];
  }
}
