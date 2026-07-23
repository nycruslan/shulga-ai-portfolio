import type { APIRoute } from 'astro';
import {
  createPlaygroundConfig,
  listPlaygroundConfigs,
  setPlaygroundStatus,
} from '../../../lib/turso';
import { createPortfolioSchema, statusSchema, LIMITS } from '../../../lib/playground-schema';

export const prerender = false;

// Trade Playground config API. Auth: the /admin middleware gates every verb
// here — only the allowlisted owner session reaches these handlers. The VPS
// never calls this; it reads the Turso table directly on its own schedule.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const GET: APIRoute = async () => json({ portfolios: await listPlaygroundConfigs() });

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const parsed = createPortfolioSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return json({ error: `${issue?.path.join('.') || 'input'}: ${issue?.message}` }, 400);
  }
  // Cap ACTIVE portfolios, not total — archived experiments don't count, and
  // the VPS runner enforces the same ceiling on its side.
  const existing = await listPlaygroundConfigs();
  if (existing.filter((p) => p.status === 'active').length >= LIMITS.maxActive) {
    return json({ error: `max ${LIMITS.maxActive} active portfolios — archive one first` }, 409);
  }
  if (existing.some((p) => p.name.toLowerCase() === parsed.data.name.toLowerCase())) {
    return json({ error: 'a portfolio with that name already exists' }, 409);
  }
  const res = await createPlaygroundConfig(parsed.data);
  return res.ok ? json({ id: res.id }, 201) : json({ error: res.error }, 500);
};

export const PATCH: APIRoute = async ({ request }) => {
  let body: { id?: string; status?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const status = statusSchema.safeParse(body.status);
  if (!body.id || !status.success) return json({ error: 'id and a valid status required' }, 400);
  // The active ceiling applies to EVERY path into 'active' — resuming or
  // reactivating past the cap would create a portfolio the runner silently
  // never trades (it processes at most maxActive, oldest first).
  if (status.data === 'active') {
    const existing = await listPlaygroundConfigs();
    const actives = existing.filter((p) => p.status === 'active' && p.id !== body.id);
    if (actives.length >= LIMITS.maxActive) {
      return json({ error: `max ${LIMITS.maxActive} active portfolios — pause one first` }, 409);
    }
  }
  const ok = await setPlaygroundStatus(body.id, status.data);
  return ok ? json({ ok: true }) : json({ error: 'not found or write failed' }, 404);
};
