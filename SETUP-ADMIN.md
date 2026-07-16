# Admin dashboard setup

The `/admin` route shows your trader and JobHunt dashboards. It's gated by Better Auth
and reads snapshots the copilot/jobhunt tools publish to Turso. Until the env vars below
are set, `/admin` says "not configured" and the rest of the site is unaffected.

## Access model

Two gates, both driven by one email allowlist:

- **Registration** — a `databaseHooks.user.create.before` hook rejects any sign-in whose
  email isn't allowlisted, so a stranger's Google login can't even create a row.
- **Access** — middleware redirects any `/admin` request whose session email isn't
  allowlisted.

The allowlist is `OWNER_EMAIL` (always included) plus everyone in `ADMIN_ALLOWLIST`.
Sign-in is **Continue with Google** (one click, no password) or a **passkey** on an
account that already exists. Email/password is disabled for new accounts and kept only as
an owner break-glass behind the "Use email & password instead" toggle.

To add or remove someone: edit `ADMIN_ALLOWLIST` in Vercel → Settings → Environment
Variables and redeploy. No code change.

## 1. Create the Turso database

```bash
brew install tursodatabase/tap/turso     # or: curl -sSfL https://get.tur.so/install.sh | bash
turso auth login                          # opens browser
turso db create jobhunt
turso db show jobhunt --url               # -> TURSO_DATABASE_URL
turso db tokens create jobhunt            # -> TURSO_AUTH_TOKEN
```

## 2. Create a Google OAuth client

Google Cloud Console → APIs & Services → Credentials → **Create OAuth client ID** → Web
application:

- **Authorized JavaScript origins**: `https://ruslanshulga.com` (add
  `http://localhost:4321` for local dev)
- **Authorized redirect URIs**: `https://ruslanshulga.com/api/auth/callback/google`
  (and `http://localhost:4321/api/auth/callback/google` for local dev)

Copy the client ID and secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. If the
OAuth consent screen is in "testing", add each allowlisted email as a test user (or
publish the app).

## 3. Set the portfolio env

Local `.env` (and the same in Vercel → Project → Settings → Environment Variables):

```
TURSO_DATABASE_URL=libsql://jobhunt-...turso.io
TURSO_AUTH_TOKEN=...
BETTER_AUTH_SECRET=        # openssl rand -base64 32
BETTER_AUTH_URL=https://ruslanshulga.com   # http://localhost:4321 for local dev
OWNER_EMAIL=you@example.com                # your Google email, always allowed
ADMIN_ALLOWLIST=friend@x.com,teammate@y.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

## 4. Create the auth tables in Turso

With the env set, generate Better Auth's schema into the Turso DB:

```bash
npx @better-auth/cli@latest migrate     # creates user/session/account/passkey tables
```

## 5. First sign-in + passkey

1. Deploy (Vercel gives a preview URL) or run `npm run dev` locally.
2. Visit `/admin/login` → **Continue with Google**. Your account is created on the spot
   because your email is on the allowlist. A non-allowlisted Google email is bounced with
   "not on the admin allowlist."
3. Optional: click **Add a passkey** for a fast second door.

## 6. Publish snapshots from the tools

Trader snapshots come from `~/.portfolio_copilot` (`python -m copilot.publish_trader`,
already on cron). JobHunt snapshots come from `~/.jobhunt_mcp`:

```bash
# add the same Turso creds to briefing.conf (git-ignored)
printf 'TURSO_DATABASE_URL=%s\nTURSO_AUTH_TOKEN=%s\n' "<url>" "<token>" >> ~/.jobhunt_mcp/briefing.conf

# install the publisher dependency into both interpreters that run jobhunt
pipx inject jobhunt-mcp libsql       # the MCP server's venv
python3.11 -m pip install libsql     # the launchd briefing (system python)
```

Then open `https://ruslanshulga.com/admin`.

## Notes

- Access is the allowlist, enforced on every `/admin` request and again at account
  creation. An empty `ADMIN_ALLOWLIST` still lets the owner in and no one else.
- Google verifies emails, so a Google sign-in links to an existing account with the same
  email instead of duplicating it (trusted-provider account linking).
- Snapshots are read-only. Acting on jobs/trades stays in the tools, not the dashboard.
