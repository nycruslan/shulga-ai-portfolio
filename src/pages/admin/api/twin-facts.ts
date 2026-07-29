import type { APIRoute } from 'astro';
import { factsSchema, readTwinConfig, writeTwinConfig } from '../../../lib/twin-config';

export const prerender = false;

// Reads and writes the twin's persona facts. Auth: the /admin middleware
// gates every verb here.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const GET: APIRoute = async () => json({ config: await readTwinConfig() });

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const parsed = factsSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return json({ error: `${issue?.path.join('.') || 'input'}: ${issue?.message}` }, 400);
  }

  try {
    return json({ config: await writeTwinConfig({ facts: parsed.data }) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return json({ error: message }, 503);
  }
};
