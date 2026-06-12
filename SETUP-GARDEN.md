# The Garden — setup

The Garden (`/garden`) is a living society of AI creatures that work together as a
crew: they take on a shared project (growing a grove, nursing a failing bed back to
health, raising a new creature), gather at the site, do the work, and the world
visibly grows. Off-duty creatures wander, talk, remember, and bond. It reuses the
Turso database and the `CHAT_API_KEY` the rest of the site already uses, so with
those set it is alive the moment someone opens `/garden`. One optional step keeps
it living when no one is watching.

## What runs where

- **Visitor ticks** hit `POST /api/garden/tick`. The deterministic engine (the
  crew's project, plant growth, seasons, movement, reactions to your actions)
  advances for free; at most one Haiku call per tick gives an off-duty
  conversation its next line, or in the gaps a reflection or a birth. Capped per
  day, single-writer via a lease lock.
- **The heartbeat** (`POST /api/garden/heartbeat`) advances a burst of ticks for
  the zero-visitor case, so a returning visitor finds the world moved on.
- **Storage** is Turso (`garden_*` tables, created on first run). No migration step.

## Activate the zero-visitor heartbeat

Pick any random string and add it in two places:

- **Vercel**: project → Settings → Environment Variables → add `TICK_SECRET`.
- **GitHub**: repo → Settings → Secrets and variables → Actions → New repository
  secret → name `TICK_SECRET`, same value.

If your production domain isn't `ruslanshulga.com`, also add a repository
**variable** `GARDEN_HEARTBEAT_URL` = `https://YOUR_DOMAIN/api/garden/heartbeat`.

`.github/workflows/garden-heartbeat.yml` then runs every 3 hours (and on demand
from the Actions tab). A `locked` or `rate` response is a normal no-op.

## Knobs

All cadence, cost, and ecology knobs live in one place: `GARDEN_CONFIG` in
`src/lib/garden/types.ts` (tick interval, daily call cap, crew size, conversation
length, reflection and birth thresholds, population cap). The seed creatures and
beds are in `src/lib/garden/seed.ts`.

## Safety

The model only ever produces short lines of dialogue and small structured data
(names, moods). A visitor whisper becomes a creature's memory, never a system
prompt, so there is nothing to inject into.
