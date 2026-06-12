import type { APIRoute } from 'astro';
import { isConfigured, readState } from '../../../lib/garden/store';
import type { GardenSnapshotResponse } from '../../../lib/garden/types';
import { GARDEN_CONFIG } from '../../../lib/garden/types';

export const prerender = false;

// Read path: many watchers, one writer. CDN-cached for ~2s so a crowd costs a
// handful of origin reads. The client polls this and triggers a tick when stale.
export const GET: APIRoute = async () => {
  if (!isConfigured()) return json({ configured: false } satisfies GardenSnapshotResponse, 'public, max-age=30');
  const row = await readState();
  if (!row) return json({ configured: false } satisfies GardenSnapshotResponse, 'public, max-age=10');

  const s = row.state;
  const body: GardenSnapshotResponse = {
    configured: true,
    version: row.version,
    tickedAt: row.tickedAt,
    staleMs: Date.now() - Date.parse(row.tickedAt),
    world: s.world,
    agents: s.agents,
    plants: s.plants,
    recentMessages: s.messages.slice(-GARDEN_CONFIG.messageCap),
    relationships: s.relationships,
    events: s.events.slice(0, 40),
    project: s.project,
    stats: {
      population: s.agents.filter((a) => a.alive).length,
      plants: s.plants.length,
      bonds: s.relationships.filter((r) => r.affinity >= 12).length,
      day: s.world.day,
      births: s.agents.filter((a) => a.generation > 0).length,
    },
  };
  return json(body, 'public, s-maxage=2, stale-while-revalidate=4');
};

function json(body: unknown, cacheControl: string): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl },
  });
}
