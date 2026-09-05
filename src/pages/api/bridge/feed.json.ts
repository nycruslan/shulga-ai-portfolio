import type { APIRoute } from 'astro';
import { AI_GATEWAY_API_KEY } from 'astro:env/server';
import { turso } from '../../../lib/turso-client';
import { bridgeStore } from '../../../lib/bridge/store';
import { latestEventTimestamp, listEvents } from '../../../lib/bridge/persistence/events';
import { daySpend } from '../../../lib/bridge/persistence/budget';
import { listMissions } from '../../../lib/bridge/persistence/missions';
import { buildBridgeFeed } from '../../../lib/bridge/feed';
import { json } from '../../../lib/http';

// Comms is "online" when a key exists, or in dev where mock models stand in.
const commsOnline = !!AI_GATEWAY_API_KEY || import.meta.env.DEV;

export const prerender = false;

// The single read surface for the bridge UI. The island polls this with an
// ?after=<eventId> cursor every few seconds; the page SSRs the same payload
// for first paint. Everything in it is real: events from the append-only log,
// spend from bridge_budget, watch state from the world row.

const cacheHeaders = {
  'Cache-Control': 'public, max-age=0, s-maxage=10, stale-while-revalidate=20',
};

export const GET: APIRoute = async ({ url }) => {
  if (!turso || !bridgeStore.isConfigured()) {
    return json({ configured: false }, 200, cacheHeaders);
  }

  const after = Number(url.searchParams.get('after') ?? 0) || 0;
  const nowIso = new Date().toISOString();
  const [row, events, latestEventAt, spend, missions] = await Promise.all([
    bridgeStore.readState(),
    listEvents(turso, { afterId: after, limit: after ? 100 : 40 }),
    latestEventTimestamp(turso),
    daySpend(turso, nowIso),
    listMissions(turso, 8),
  ]);

  const payload = buildBridgeFeed({
    row,
    events,
    latestEventAt,
    spend,
    nowIso,
    missions,
    commsOnline,
  });
  return json(payload, 200, cacheHeaders);
};
