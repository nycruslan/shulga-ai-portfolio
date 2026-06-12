// @ts-check
import { defineConfig, envField } from 'astro/config';
import react from '@astrojs/react';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://ruslanshulga.com',
  adapter: vercel(),
  integrations: [react(), mdx(), sitemap()],
  env: {
    schema: {
      CHAT_API_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
      // Shared secret the GitHub Actions heartbeat sends to /api/foundry/build so
      // the crew keeps building with zero visitors. Optional: visitor traffic also
      // triggers builds, bounded by the same cadence + daily cap regardless.
      TICK_SECRET: envField.string({ context: 'server', access: 'secret', optional: true }),
      // Optional. When both are set, /api/chat enforces per-IP rate limiting.
      // Provision free via the Upstash integration in the Vercel Marketplace.
      UPSTASH_REDIS_REST_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
      UPSTASH_REDIS_REST_TOKEN: envField.string({ context: 'server', access: 'secret', optional: true }),

      // Owner admin (optional). When all are set, /admin unlocks the JobHunt
      // dashboard. Until then the admin routes report "not configured" and the
      // rest of the site is unaffected. See SETUP-ADMIN.md.
      TURSO_DATABASE_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
      TURSO_AUTH_TOKEN: envField.string({ context: 'server', access: 'secret', optional: true }),
      BETTER_AUTH_SECRET: envField.string({ context: 'server', access: 'secret', optional: true }),
      BETTER_AUTH_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
      OWNER_EMAIL: envField.string({ context: 'server', access: 'secret', optional: true }),
      ADMIN_ALLOW_SIGNUP: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
