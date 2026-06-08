import type { APIRoute } from 'astro';
import { auth } from '../../../lib/auth';

export const prerender = false;

export const ALL: APIRoute = async (ctx) => {
  if (!auth) return new Response('Admin not configured', { status: 503 });
  return auth.handler(ctx.request);
};
