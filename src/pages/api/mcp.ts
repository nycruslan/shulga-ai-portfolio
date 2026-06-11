import type { APIRoute } from 'astro';
import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { about } from '../../data/about';
import { getProject, listProjects, searchPortfolio } from '../../lib/portfolio-content';
import { readEvalRuns } from '../../lib/turso';

export const prerender = false;

// Public, read-only MCP server (Streamable HTTP, stateless). Visitors add
// https://ruslanshulga.com/api/mcp to Claude, Cursor, or any MCP client and
// query the portfolio with tools instead of scrolling. Everything it serves is
// already public on the site.

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
});

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      'get_resume',
      {
        title: 'Get resume',
        description:
          "Ruslan Shulga's full professional profile: role, experience, highlights with metrics, stack, background, and what he's looking for. Call this first for any question about who he is or what he's done.",
        inputSchema: {},
      },
      async () => text(about)
    );

    server.registerTool(
      'list_projects',
      {
        title: 'List projects',
        description:
          'List the selected-work case studies with slugs, blurbs, stacks, and headline metrics. Use get_project for the full write-up.',
        inputSchema: {},
      },
      async () => text(await listProjects())
    );

    server.registerTool(
      'get_project',
      {
        title: 'Get project case study',
        description:
          'Full case study for one project (problem, architecture, key decisions, what broke). Call when the user asks how something was built.',
        inputSchema: { slug: z.string().describe('Project slug from list_projects, e.g. "hybrid-rag"') },
      },
      async ({ slug }) => {
        const project = await getProject(slug);
        if (!project) {
          const available = (await listProjects()).map((p) => p.slug).join(', ');
          return text(`No project "${slug}". Available slugs: ${available}`);
        }
        return text(project);
      }
    );

    server.registerTool(
      'search_portfolio',
      {
        title: 'Search the portfolio',
        description:
          'Lexical search across the resume and all case studies. Returns scored passages. Call when the question is specific (a technology, a metric, a decision) and you do not know which project covers it.',
        inputSchema: { query: z.string().describe('Search terms, e.g. "rerank precision"') },
      },
      async ({ query }) => {
        const hits = await searchPortfolio(query, 5);
        if (!hits.length) return text(`No matches for "${query}".`);
        return text(hits.map((h) => ({ source: h.source, title: h.title, score: h.score, text: h.text })));
      }
    );

    server.registerTool(
      'get_eval_summary',
      {
        title: 'Get chatbot eval scores',
        description:
          "Latest nightly eval scores for this site's own AI chat (groundedness, persona, refusals, prompt-injection resistance), judged by an LLM in CI and published at /evals. Call when asked how the assistant is tested or how reliable it is.",
        inputSchema: {},
      },
      async () => {
        const [latest] = await readEvalRuns(1);
        if (!latest) return text('No eval runs published yet. Dashboard: ' + about.portfolio + '/evals');
        return text({
          generated_at: latest.generated_at,
          model: latest.model,
          judge_model: latest.judge_model,
          overall_score_out_of_10: latest.overall,
          passed: `${latest.passed}/${latest.total}`,
          categories: latest.categories,
          dashboard: `${about.portfolio}/evals`,
        });
      }
    );

    server.registerTool(
      'get_contact',
      {
        title: 'Get contact info',
        description: 'Email, LinkedIn, GitHub, and location for reaching Ruslan.',
        inputSchema: {},
      },
      async () =>
        text({
          email: about.email,
          linkedin: about.linkedin,
          github: about.github,
          location: about.location,
          note: 'Email is the fastest channel.',
        })
    );
  },
  {
    serverInfo: { name: 'ruslan-shulga-portfolio', version: '1.0.0' },
  },
  {
    basePath: '/api',
    maxDuration: 60,
    disableSse: true,
  }
);

export const ALL: APIRoute = ({ request }) => handler(request);
