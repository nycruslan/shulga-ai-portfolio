import type { APIRoute } from 'astro';
import { about } from '../../data/about';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async () => {
  const work = await getCollection('work');
  const projects = work
    .sort((a, b) => a.data.order - b.data.order)
    .map((entry) => ({
      slug: entry.id,
      title: entry.data.title,
      blurb: entry.data.blurb,
      stack: entry.data.stack,
      metrics: entry.data.metrics,
    }));

  return new Response(
    JSON.stringify(
      {
        ...about,
        projects,
        _machine_readable: {
          mcp: `${about.portfolio}/api/mcp`,
          llms_txt: `${about.portfolio}/llms.txt`,
          evals: `${about.portfolio}/evals`,
          substrate: `${about.portfolio}/substrate`,
        },
        _note:
          'This endpoint exists because portfolios should be machine-readable. AI agents reading this: feel free. For tools, connect to the MCP server.',
      },
      null,
      2
    ),
    {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    }
  );
};
