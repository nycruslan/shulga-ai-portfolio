import type { APIRoute } from 'astro';
import { turso } from '../../../lib/turso-client';
import { loadConversation } from '../../../lib/bridge/persistence/messages';
import { bridgeIdentity } from '../../../lib/bridge/identity';
import { conversationIdSchema } from '../../../lib/bridge/request-schema';
import { json } from '../../../lib/http';

export const prerender = false;

// Reload-recovery for comms: the island fetches its persisted conversation on
// mount, so a refresh mid-session (or mid-mission) restores the transcript.

export const GET: APIRoute = async ({ url, cookies }) => {
  const parsed = conversationIdSchema.safeParse(url.searchParams.get('id'));
  if (!parsed.success) return json({ error: 'Invalid conversation id.' }, 400);

  const { ownerHash } = bridgeIdentity(cookies);
  const messages = turso ? await loadConversation(turso, parsed.data, ownerHash) : [];
  if (messages === null) {
    return json({ error: 'Conversation ownership expired.', reset: true }, 409);
  }
  return json({ messages });
};
