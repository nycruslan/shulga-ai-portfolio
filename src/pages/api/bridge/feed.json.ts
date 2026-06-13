import type { APIRoute } from 'astro';
import { AI_GATEWAY_API_KEY } from 'astro:env/server';
import { turso } from '../../../lib/turso-client';
import { bridgeStore } from '../../../lib/bridge/store';
import { listEvents } from '../../../lib/bridge/persistence/events';
import { daySpend } from '../../../lib/bridge/persistence/budget';
import { listMissions } from '../../../lib/bridge/persistence/missions';
import { buildBridgeFeed } from '../../../lib/bridge/feed';

// Comms is "online" when a key exists, or in dev where mock models stand in.
const commsOnline = !!AI_GATEWAY_API_KEY || import.meta.env.DEV;

export const prerender = false;

// The single read surface for the bridge UI. The island polls this with an
// ?after=<eventId> cursor every few seconds; the page SSRs the same payload
// for first paint. Everything in it is real: events from the append-only log,
// spend from bridge_budget, watch state from the world row.

export const GET: APIRoute = async ({ url }) => {
  if (!turso || !bridgeStore.isConfigured()) {
    return new Response(JSON.stringify({ configured: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const after = Number(url.searchParams.get('after') ?? 0) || 0;
  const nowIso = new Date().toISOString();
  const [row, events, spend, missions] = await Promise.all([
    bridgeStore.readState(),
    listEvents(turso, { afterId: after, limit: after ? 100 : 40 }),
    daySpend(turso, nowIso),
    listMissions(turso, 8),
  ]);

  const payload = buildBridgeFeed({ row, events, spend, nowIso, missions, commsOnline });
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
