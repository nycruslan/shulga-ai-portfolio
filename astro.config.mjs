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
      // Optional. When both are set, /api/chat enforces per-IP rate limiting.
      // Provision free via the Upstash integration in the Vercel Marketplace.
      UPSTASH_REDIS_REST_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
      UPSTASH_REDIS_REST_TOKEN: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
