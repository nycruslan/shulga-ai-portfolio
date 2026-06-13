import { createClient, type Client } from '@libsql/client';
import { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN } from 'astro:env/server';

// One Turso client for the whole app. Null when unconfigured (dev without
// secrets), so callers degrade gracefully instead of failing.

export const turso: Client | null =
  TURSO_DATABASE_URL && TURSO_AUTH_TOKEN
    ? createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN })
    : null;
