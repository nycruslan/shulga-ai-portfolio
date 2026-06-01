// @ts-check
import { defineConfig, envField } from 'astro/config';
import react from '@astrojs/react';
import mdx from '@astrojs/mdx';
import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://ruslanshulga.com',
  adapter: vercel(),
  integrations: [react(), mdx()],
  env: {
    schema: {
      CHAT_API_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
