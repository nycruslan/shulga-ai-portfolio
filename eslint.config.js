// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default defineConfig(
  {
    ignores: ['dist/**', '.astro/**', '.vercel/**', 'node_modules/**', 'public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    files: ['**/*.tsx'],
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
  {
    // Node scripts run outside Astro/TS tooling.
    files: ['scripts/**', '*.config.{js,ts,mjs}'],
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Pre-Bridge island with a known benign pattern; new code does NOT get
    // this exemption.
    files: ['src/components/islands/CommandPalette.tsx'],
    rules: { 'react-hooks/set-state-in-effect': 'off' },
  },
  {
    // React Compiler intentionally skips TanStack Table's function-returning hook.
    files: ['src/components/admin/{AdminTables,TraderTables}.tsx'],
    rules: { 'react-hooks/incompatible-library': 'off' },
  },
  prettier,
);
