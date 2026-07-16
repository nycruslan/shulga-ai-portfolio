import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
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
  ADMIN_ALLOWLIST,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
} = process.env;

// One email, normalized so a casing/whitespace mismatch between the env value
// and the stored session email can't lock the owner out.
export const OWNER = OWNER_EMAIL ? OWNER_EMAIL.trim().toLowerCase() : null;

// The allowlist: everyone permitted to register AND reach /admin. Comma or
// whitespace separated in ADMIN_ALLOWLIST; the owner is always included, so a
// missing/empty list still lets the owner in and nobody else. This single set
// drives both gates — signup (the create hook below) and access (middleware).
export const ALLOWLIST: ReadonlySet<string> = new Set(
  [OWNER, ...(ADMIN_ALLOWLIST ?? '').split(/[\s,]+/)]
    .map((e) => e?.trim().toLowerCase())
    .filter((e): e is string => Boolean(e)),
);

export function isAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  return ALLOWLIST.has(email.trim().toLowerCase());
}

// Google is optional: wire it only when both halves of the OAuth client are
// present, so the site still builds and serves (with passkey + password) when
// they aren't set yet. Exported so the login UI only shows the Google button
// when it will actually work.
export const googleReady = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

// Admin is fully optional: only wire Better Auth when its core config is present,
// so the public site builds and serves with none of these set. BETTER_AUTH_URL is
// required too: without it the lib would fall back to a localhost baseURL, giving
// the passkey the wrong origin and undercutting Secure cookies. Better to leave
// admin unwired than to come up insecure.
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
    // Email+password stays enabled as the owner's break-glass fallback (the owner
    // account was bootstrapped this way). New password signups are off — the only
    // way onto the allowlist is Google or a passkey on an already-linked account.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    ...(googleReady && {
      socialProviders: {
        google: {
          clientId: GOOGLE_CLIENT_ID!,
          clientSecret: GOOGLE_CLIENT_SECRET!,
        },
      },
    }),
    // Link a Google sign-in to an existing account with the same verified email
    // (so the owner's gmail Google login lands on the bootstrapped account instead
    // of erroring or duplicating). Google verifies the email, so this is safe.
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google', 'email-password'],
      },
    },
    // The real allowlist gate. Fires on EVERY account-creation path (Google,
    // password, anything), so a stranger's Google login can't mint an account.
    // Middleware separately guards access; this stops the row from ever existing.
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isAllowed(user.email)) {
              throw new APIError('FORBIDDEN', {
                message: 'This email is not on the admin allowlist.',
              });
            }
          },
        },
      },
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
