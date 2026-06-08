# Admin dashboard setup

The `/admin` route shows your JobHunt pipeline (funnel, today's matches, applications,
follow-ups). It's gated by Better Auth (passkey, with an email/password bootstrap) and
reads a snapshot the jobhunt tool publishes to Turso. Until the env vars below are set,
`/admin` says "not configured" and the rest of the site is unaffected.

## 1. Create the Turso database

```bash
brew install tursodatabase/tap/turso     # or: curl -sSfL https://get.tur.so/install.sh | bash
turso auth login                          # opens browser
turso db create jobhunt
turso db show jobhunt --url               # -> TURSO_DATABASE_URL
turso db tokens create jobhunt            # -> TURSO_AUTH_TOKEN
```

## 2. Set the portfolio env

Local `.env` (and the same in Vercel → Project → Settings → Environment Variables):

```
TURSO_DATABASE_URL=libsql://jobhunt-...turso.io
TURSO_AUTH_TOKEN=...
BETTER_AUTH_SECRET=        # openssl rand -base64 32
BETTER_AUTH_URL=https://ruslanshulga.com   # http://localhost:4321 for local dev
OWNER_EMAIL=you@example.com
ADMIN_ALLOW_SIGNUP=true    # temporary, see step 4
```

## 3. Create the auth tables in Turso

With the env set, generate Better Auth's schema into the Turso DB:

```bash
npx @better-auth/cli@latest migrate     # creates user/session/account/passkey tables
```

## 4. Create your owner account + passkey

1. Deploy the branch (Vercel gives a preview URL) or run `npm run dev` locally.
2. Visit `/admin/login`, use "Create the owner account" with `OWNER_EMAIL` + a password.
   (Sign-up only works while `ADMIN_ALLOW_SIGNUP=true`.)
3. Sign in, then click "Add a passkey". From now on use "Sign in with passkey".
4. **Remove `ADMIN_ALLOW_SIGNUP`** (or set it to `false`) and redeploy. Sign-up is now closed.

## 5. Publish snapshots from the jobhunt tool

On the machine running jobhunt (`~/.jobhunt_mcp`):

```bash
# add the same Turso creds to briefing.conf (git-ignored)
printf 'TURSO_DATABASE_URL=%s\nTURSO_AUTH_TOKEN=%s\n' "<url>" "<token>" >> ~/.jobhunt_mcp/briefing.conf

# install the publisher dependency into both interpreters that run jobhunt
pipx inject jobhunt-mcp libsql       # the MCP server's venv
python3.11 -m pip install libsql     # the launchd briefing (system python)
```

`preferences.publish` is already `true` in your profile. A snapshot is pushed on every
feed pull, apply, and status change, and at the end of the daily brief. Trigger one now:

```bash
python3.11 ~/.jobhunt_mcp/daily_briefing.py    # or run /jobhunt-today
```

Then open `https://ruslanshulga.com/admin`.

## Notes

- Only `OWNER_EMAIL` can sign in; middleware enforces it on every `/admin` request.
- The snapshot is read-only. Acting on jobs stays in Claude (the MCP tools).
- Tailored PDFs/cover letters are local artifacts; the dashboard shows status, not files.
