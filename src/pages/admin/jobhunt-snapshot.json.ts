import type { APIRoute } from 'astro';
import { readSnapshot } from '../../lib/turso';

export const prerender = false;

// Live read surface for the JobHunt dashboard island. It lives under /admin so
// the existing middleware gates it to the owner; the page SSRs the same snapshot
// for first paint, then the island polls this for updates. Never cached, so a
// fresh publish from the jobhunt tool shows up on the next poll.
export const GET: APIRoute = async () => {
  const snap = await readSnapshot();
  return new Response(JSON.stringify(snap), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
};
