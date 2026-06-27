import { getCollection } from 'astro:content';
import { about } from '../data/about';

// Shared, server-side content layer for the machine-readable surfaces: the MCP
// server (/api/mcp), the chat agent's tools, and /llms.txt all read from here
// so they can never drift from the human-readable site.

export type Chunk = {
  source: string; // e.g. "about", "work/hybrid-rag"
  title: string;
  text: string;
};

export type SearchHit = Chunk & { score: number };

let corpusPromise: Promise<Chunk[]> | null = null;

async function buildCorpus(): Promise<Chunk[]> {
  const chunks: Chunk[] = [
    { source: 'about', title: 'Summary', text: about.summary },
    { source: 'about', title: 'Highlights', text: about.highlights.join('\n') },
    { source: 'about', title: 'Philosophy', text: about.philosophy.join('\n') },
    { source: 'about', title: 'Stack', text: about.stack.join(', ') },
    { source: 'about', title: 'Background', text: about.background.join('\n') },
    { source: 'about', title: 'Looking for', text: about.lookingFor },
  ];

  const work = await getCollection('work');
  for (const entry of work) {
    chunks.push({
      source: `work/${entry.id}`,
      title: entry.data.title,
      text: `${entry.data.blurb}\nStack: ${entry.data.stack.join(', ')}\nMetrics: ${entry.data.metrics
        .map((m) => `${m.label}: ${m.value}`)
        .join('; ')}`,
    });
    // Split the case-study body into heading-bounded sections so search hits
    // return a focused passage, not the whole document.
    const body = entry.body ?? '';
    const sections = body.split(/\n(?=## )/g);
    for (const section of sections) {
      const text = section.trim();
      if (text.length < 40) continue;
      const heading = text.match(/^## (.+)$/m)?.[1] ?? entry.data.title;
      chunks.push({ source: `work/${entry.id}`, title: `${entry.data.title} · ${heading}`, text });
    }
  }
  return chunks;
}

export function getCorpus(): Promise<Chunk[]> {
  corpusPromise ??= buildCorpus();
  return corpusPromise;
}

// Plain lexical scoring (term overlap + title boost). Deliberately simple and
// inspectable; the point of the glass box is showing real scores, not magic.
export async function searchPortfolio(query: string, limit = 4): Promise<SearchHit[]> {
  const corpus = await getCorpus();
  // Bound the work regardless of caller: cap input length, dedupe, and cap term
  // count so a pathologically long query can't drive O(terms × corpus) CPU.
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .slice(0, 200)
        .split(/[^a-z0-9~%+.]+/)
        .filter((t) => t.length > 2),
    ),
  ].slice(0, 24);
  if (!terms.length) return [];

  const hits = corpus
    .map((chunk) => {
      const haystack = chunk.text.toLowerCase();
      const titleHay = chunk.title.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (titleHay.includes(term)) score += 3;
        const matches = haystack.split(term).length - 1;
        score += Math.min(matches, 4);
      }
      return { ...chunk, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return hits;
}

export async function listProjects() {
  const work = await getCollection('work');
  return work
    .sort((a, b) => a.data.order - b.data.order)
    .map((entry) => ({
      slug: entry.id,
      title: entry.data.title,
      blurb: entry.data.blurb,
      stack: entry.data.stack,
      metrics: entry.data.metrics,
      url: `${about.portfolio}/work/${entry.id}`,
    }));
}

export async function getProject(slug: string) {
  const work = await getCollection('work');
  const entry = work.find((e) => e.id === slug);
  if (!entry) return null;
  return {
    slug: entry.id,
    title: entry.data.title,
    blurb: entry.data.blurb,
    stack: entry.data.stack,
    metrics: entry.data.metrics,
    url: `${about.portfolio}/work/${entry.id}`,
    body: entry.body ?? '',
  };
}
