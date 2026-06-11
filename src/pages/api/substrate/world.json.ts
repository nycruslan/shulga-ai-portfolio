import type { APIRoute } from 'astro';
import { isConfigured, readState } from '../../../lib/substrate/store';
import type { SnapshotResponse } from '../../../lib/substrate/types';

export const prerender = false;

// Read path: many watchers, one writer. CDN-cached for ~2s so a crowd costs a
// handful of origin reads. The client polls this and triggers a tick when stale.
export const GET: APIRoute = async () => {
  if (!isConfigured()) {
    return json({ configured: false } satisfies SnapshotResponse, 'public, max-age=30');
  }
  const state = await readState();
  if (!state) {
    return json({ configured: false } satisfies SnapshotResponse, 'public, max-age=10');
  }
  const body: SnapshotResponse = {
    configured: true,
    version: state.version,
    tickedAt: state.tickedAt,
    staleMs: Date.now() - Date.parse(state.tickedAt),
    world: state.world,
  };
  return json(body, 'public, s-maxage=2, stale-while-revalidate=4');
};

function json(body: unknown, cacheControl: string): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl },
  });
}
