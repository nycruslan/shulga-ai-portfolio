import type { APIRoute } from 'astro';
import { turso } from '../../../lib/turso-client';
import { loadConversation } from '../../../lib/bridge/persistence/messages';

export const prerender = false;

// Reload-recovery for comms: the island fetches its persisted conversation on
// mount, so a refresh mid-session (or mid-mission) restores the transcript.

export const GET: APIRoute = async ({ url }) => {
  const id = String(url.searchParams.get('id') ?? '').slice(0, 64);
  const messages = turso && id ? await loadConversation(turso, id) : [];
  return new Response(JSON.stringify({ messages }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
