import { createHash, randomBytes } from 'node:crypto';
import type { AstroCookies } from 'astro';

const COOKIE = 'bridge-session';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type BridgeIdentity = {
  ownerHash: string;
  visitorId: string;
};

/**
 * Anonymous Bridge ownership uses a server-issued bearer cookie. Only its hash
 * reaches Turso, so a database read cannot be turned into a session credential.
 */
export function bridgeIdentity(cookies: AstroCookies): BridgeIdentity {
  let token = cookies.get(COOKIE)?.value;
  if (!token || !TOKEN_RE.test(token)) {
    token = randomBytes(32).toString('base64url');
    cookies.set(COOKIE, token, {
      httpOnly: true,
      secure: import.meta.env.PROD,
      sameSite: 'strict',
      path: '/api/bridge',
      maxAge: MAX_AGE_SECONDS,
    });
  }

  const ownerHash = createHash('sha256').update(token).digest('hex');
  return { ownerHash, visitorId: `vis-${ownerHash.slice(0, 16)}` };
}
