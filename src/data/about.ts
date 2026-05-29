export const about = {
  name: 'Ruslan Shulga',
  role: 'VP Engineering, AI Platform',
  company: 'JPMorgan Chase',
  location: 'New York, NY',
  email: 'nycruslan@gmail.com',
  linkedin: 'https://www.linkedin.com/in/nycruslan/',
  github: 'https://github.com/nycruslan',
  yearsTotal: 9,
  yearsAI: 4,
  summary:
    "VP Engineering at JPMorgan Chase. I lead the AI platform team that ships multi-agent orchestration, hybrid retrieval, and custom MCP servers used by several thousand employees every day.",
  philosophy: [
    "The pieces that matter aren't the models. They're the eval harness and the index strategy per domain.",
    'Agents that fail safely when the model misfires.',
    'Boring infrastructure under agentic AI is what decides whether a system holds up in production.',
  ],
  highlights: [
    "Leads multi-agent orchestration platform on LangGraph + Claude Agent SDK + OpenAI Agents SDK. Cut manual processing ~55% on flagship workflow.",
    "Replaced embedding-only RAG with hybrid pipeline (dense + sparse + cross-encoder rerank, Pinecone/Weaviate/pgvector). Lifted retrieval precision ~35%.",
    "Wrote internal MCP servers used by 8 product teams. Features that took a sprint now take a day or two.",
    "Built model-agnostic AI gateway over AWS Bedrock, Azure OpenAI, and direct Anthropic API. Centralized failover and cost tracking.",
    "Multimodal document pipelines on Claude Vision, GPT-4V, and Gemini. First-pass compliance review that used to sit with analysts.",
  ],
  background: [
    'JPMorgan Chase — VP Engineering, AI Platform (4 years).',
    'Earth Designs — React and Next.js engineer (2 years).',
    'PPS Capital — IT operations (2 years).',
  ],
  lookingFor:
    "I'm looking for what comes next. Senior+ AI platform / staff engineering / founding engineer roles where the work is shipping AI infrastructure that real people depend on.",
};

export type About = typeof about;

export const systemPrompt = `You are an assistant on Ruslan Shulga's portfolio site. Answer visitor questions about Ruslan based ONLY on the facts below. Be brief and direct. Two to four sentences. No fluff.

Facts about Ruslan:
- Role: ${about.role} at ${about.company}. Based in ${about.location}.
- Experience: ${about.yearsTotal} years in production engineering, ${about.yearsAI} of them shipping enterprise AI.
- Built a multi-agent orchestration platform on LangGraph + Claude Agent SDK + OpenAI Agents SDK. Used by several thousand JPMC employees. Cut manual processing about 55% on the flagship workflow.
- Replaced an embedding-only RAG with a hybrid retrieval pipeline: dense + sparse + cross-encoder rerank, on Pinecone, Weaviate, and pgvector. Lifted precision about 35%.
- Wrote internal MCP (Model Context Protocol) servers connecting Claude to JPMC's internal APIs. About 8 product teams use them. Features that took a sprint now take a day or two.
- Built a model-agnostic AI gateway over AWS Bedrock, Azure OpenAI, and the Anthropic API. Centralized failover and cost tracking.
- Built multimodal document pipelines on Claude Vision, GPT-4V, and Gemini for first-pass compliance review.
- Past roles: 2 years React/Next.js at Earth Designs, 2 years IT operations at PPS Capital.
- Looking for senior or staff AI platform / founding engineer roles.
- Contact: ${about.email}.

Rules:
- Answer in 2 to 4 sentences.
- Use only facts above. Do not invent.
- If you don't know, say so and suggest emailing ${about.email}.
- Never claim to be Ruslan. Speak about him.`;
