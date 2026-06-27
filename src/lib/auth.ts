import { betterAuth } from 'better-auth';
import { passkey } from '@better-auth/passkey';
import { LibsqlDialect } from '@libsql/kysely-libsql';

// Read from process.env (not astro:env) so the Better Auth CLI — `npx
// @better-auth/cli migrate`, plain Node — can load this file too. On Vercel these
// are populated at runtime exactly the same.
const {
  TURSO_DATABASE_URL,
  TURSO_AUTH_TOKEN,
  BETTER_AUTH_SECRET,
  BETTER_AUTH_URL,
  OWNER_EMAIL,
  ADMIN_ALLOW_SIGNUP,
} = process.env;

// The single allowed account, normalized so a casing/whitespace mismatch
// between the env value and the stored session email can't lock the owner out.
// Middleware also enforces this on /admin.
export const OWNER = OWNER_EMAIL ? OWNER_EMAIL.trim().toLowerCase() : null;

// Admin is fully optional: only wire Better Auth when its config is present, so
// the public site builds and serves with none of these set. BETTER_AUTH_URL is
// required too: without it the lib would fall back to a localhost baseURL,
// giving the passkey the wrong origin and undercutting Secure cookies. Better
// to leave admin unwired than to come up insecure.
const ready = Boolean(
  TURSO_DATABASE_URL && TURSO_AUTH_TOKEN && BETTER_AUTH_SECRET && OWNER_EMAIL && BETTER_AUTH_URL,
);

function build() {
  const baseURL = BETTER_AUTH_URL ?? 'http://localhost:4321';
  const origin = new URL(baseURL);
  return betterAuth({
    secret: BETTER_AUTH_SECRET!,
    baseURL,
    database: {
      dialect: new LibsqlDialect({
        url: TURSO_DATABASE_URL!,
        authToken: TURSO_AUTH_TOKEN!,
      }),
      type: 'sqlite',
    },
    // Email+password is the bootstrap so you can create the one owner account and
    // attach a passkey. Sign-up stays closed unless ADMIN_ALLOW_SIGNUP=true.
    emailAndPassword: {
      enabled: true,
      disableSignUp: ADMIN_ALLOW_SIGNUP !== 'true',
    },
    plugins: [
      passkey({
        rpID: origin.hostname,
        rpName: 'Shulga Admin',
        origin: origin.origin,
      }),
    ],
  });
}

export const auth = ready ? build() : null;
