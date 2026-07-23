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
  // Edit-as-new-version: configs are immutable (a mid-experiment mutation
  // would corrupt results), so "edit" = create the new version, then archive
  // the old one. Its open positions keep their exits; only new buys stop.
  const replacesId =
    body &&
    typeof body === 'object' &&
    typeof (body as { replaces_id?: unknown }).replaces_id === 'string'
      ? (body as { replaces_id: string }).replaces_id
      : null;
  const parsed = createPortfolioSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return json({ error: `${issue?.path.join('.') || 'input'}: ${issue?.message}` }, 400);
  }
  // Cap ACTIVE portfolios, not total — archived experiments don't count, and
  // the VPS runner enforces the same ceiling on its side. A replaced portfolio
  // is about to be archived, so it doesn't count against either check.
  const existing = await listPlaygroundConfigs();
  const others = existing.filter((p) => p.id !== replacesId);
  if (others.filter((p) => p.status === 'active').length >= LIMITS.maxActive) {
    return json({ error: `max ${LIMITS.maxActive} active portfolios — archive one first` }, 409);
  }
  if (others.some((p) => p.name.toLowerCase() === parsed.data.name.toLowerCase())) {
    return json({ error: 'a portfolio with that name already exists' }, 409);
  }
  if (replacesId && !existing.some((p) => p.id === replacesId)) {
    return json({ error: 'the portfolio being edited no longer exists' }, 404);
  }
  const res = await createPlaygroundConfig(parsed.data);
  if (!res.ok) return json({ error: res.error }, 500);
  if (replacesId) await setPlaygroundStatus(replacesId, 'archived');
  return json({ id: res.id }, 201);
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
