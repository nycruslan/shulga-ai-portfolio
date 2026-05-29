import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const work = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/work' }),
  schema: z.object({
    title: z.string(),
    blurb: z.string(),
    stack: z.array(z.string()),
    metrics: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
        })
      )
      .default([]),
    shape: z.enum(['graph', 'layers', 'mesh', 'gateway', 'pipeline']).default('graph'),
    order: z.number().default(0),
  }),
});

export const collections = { work };
