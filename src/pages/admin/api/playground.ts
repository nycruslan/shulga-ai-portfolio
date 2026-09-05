import type { APIRoute } from 'astro';
import { z } from 'zod';
import {
  savePlaygroundConfig,
  listPlaygroundConfigs,
  setPlaygroundStatus,
} from '../../../lib/turso';
import { createPortfolioSchema, statusSchema } from '../../../lib/playground-schema';
import { json, readJson } from '../../../lib/http';

export const prerender = false;

// Trade Playground config API. Auth: the /admin middleware gates every verb
// here — only the allowlisted owner session reaches these handlers. The VPS
// never calls this; it reads the Turso table directly on its own schedule.

const createRequestSchema = createPortfolioSchema.extend({
  replaces_id: z.uuidv4().optional(),
});
const statusRequestSchema = z.object({ id: z.uuidv4(), status: statusSchema });

export const GET: APIRoute = async () => json({ portfolios: await listPlaygroundConfigs() });

export const POST: APIRoute = async ({ request }) => {
  const parsed = await readJson(request, createRequestSchema);
  if (!parsed.ok) return parsed.response;

  // Edit-as-new-version: configs are immutable (a mid-experiment mutation
  // would corrupt results), so "edit" = create the new version, then archive
  // the old one. Its open positions keep their exits; only new buys stop.
  const { replaces_id: replacesId = null, ...input } = parsed.data;
  const res = await savePlaygroundConfig(input, replacesId);
  if (!res.ok) return json({ error: res.error }, res.status);
  return json({ id: res.id }, 201);
};

export const PATCH: APIRoute = async ({ request }) => {
  const parsed = await readJson(request, statusRequestSchema);
  if (!parsed.ok) return parsed.response;
  const result = await setPlaygroundStatus(parsed.data.id, parsed.data.status);
  return result.ok ? json({ ok: true }) : json({ error: result.error }, result.status);
};
