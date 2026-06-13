# ruslanshulga.com

Personal portfolio for Ruslan Shulga. Built with Astro and React islands, deployed on Vercel.

It doubles as a working demo: the hero runs a WebGL shader (OGL), and "Ask my portfolio" is a streaming chat agent backed by Claude Haiku that only answers from a fixed set of facts about my work.

## Stack

- **Astro 6** with the Vercel adapter (static pages + a couple of server routes)
- **React islands** for the interactive bits (chat, command palette, custom cursor, hero shader)
- **Tailwind CSS 4** via the Vite plugin, plus CSS variables for the palette
- **GSAP + Lenis** for scroll reveals and smooth scrolling
- **@anthropic-ai/sdk** for the chat endpoint
- **MDX content collection** for case studies

## Project layout

```text
src/
├── components/          # Astro sections (Hero, Story, Projects, Contact, Nav)
│   └── islands/         # React: AskMe, CommandPalette, CustomCursor, HeroShader
├── content/work/        # Case studies (.mdx) — see content.config.ts for the schema
├── data/about.ts        # Single source of truth: bio, links, and the chat system prompt
├── layouts/Layout.astro # <head>, meta/OG/JSON-LD, skip link, preloader, Lenis init
├── pages/
│   ├── api/chat.ts      # Streaming chat endpoint (Claude Haiku)
│   ├── api/me.json.ts   # Machine-readable résumé
│   ├── work/[slug].astro
│   └── index.astro
└── styles/global.css
```

## Local setup

```sh
npm install
cp .env.example .env   # then set CHAT_API_KEY
npm run dev            # http://localhost:4321
```

### Environment variables

| Variable                   | Required | Purpose                                                                                              |
| :------------------------- | :------- | :--------------------------------------------------------------------------------------------------- |
| `CHAT_API_KEY`             | for chat | Anthropic API key. Without it, `/api/chat` returns 503 and the rest of the site still works.         |
| `UPSTASH_REDIS_REST_URL`   | optional | Enables per-IP rate limiting on `/api/chat`.                                                         |
| `UPSTASH_REDIS_REST_TOKEN` | optional | Pairs with the URL above. Provision both free via the Upstash integration in the Vercel Marketplace. |

If the Upstash vars are unset, rate limiting is skipped (fine for local dev).

## Editing content

- **Bio, links, chat facts:** `src/data/about.ts`. Everything else imports from here.
- **Case studies:** add an `.mdx` file under `src/content/work/`. Frontmatter is validated by `src/content.config.ts`.
- **Social card:** regenerate with `node scripts/gen-og.mjs` (writes `public/og.png`).

## Commands

| Command           | Action                        |
| :---------------- | :---------------------------- |
| `npm run dev`     | Local dev server              |
| `npm run build`   | Production build to `./dist/` |
| `npm run preview` | Preview the build locally     |

## Deploy

Pushes deploy through Vercel. Set the env vars above in the Vercel project settings.
