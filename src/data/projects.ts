export interface Project {
  slug: string;
  title: string;
  blurb: string;
  stack: string[];
  metrics: { label: string; value: string }[];
}

export const projects: Project[] = [
  {
    slug: 'multi-agent-platform',
    title: 'Multi-agent orchestration platform',
    blurb:
      "Production multi-agent workflows used by several thousand employees firm-wide. LangGraph orchestrates Claude Agent SDK and OpenAI Agents SDK. Each agent has persistent memory and calls internal tools. Irreversible actions pause for a human checkpoint.",
    stack: ['LangGraph', 'Claude Agent SDK', 'OpenAI Agents SDK', 'Python', 'React'],
    metrics: [
      { label: 'Manual processing cut on flagship workflow', value: '~55%' },
      { label: 'Concurrent users at peak', value: 'several thousand' },
    ],
  },
  {
    slug: 'hybrid-rag',
    title: 'Hybrid retrieval pipeline',
    blurb:
      "Replaced an embedding-only RAG with a hybrid pipeline: dense plus sparse retrieval, cross-encoder re-ranking, indexed across Pinecone, Weaviate, and pgvector depending on the use case. The pieces that mattered weren't the models. They were the eval harness and the index strategy per domain.",
    stack: ['Pinecone', 'Weaviate', 'pgvector', 'Cross-encoder re-ranking', 'RAGAS'],
    metrics: [
      { label: 'Retrieval precision improvement', value: '~35%' },
      { label: 'Eval cadence', value: 'nightly' },
    ],
  },
  {
    slug: 'mcp-servers',
    title: 'Internal MCP servers',
    blurb:
      "Custom Model Context Protocol servers that connect Claude to internal APIs and databases. Around 8 product teams use the stack. Features that used to take a sprint now take a day or two.",
    stack: ['MCP', 'Python', 'Anthropic API', 'Internal APIs'],
    metrics: [
      { label: 'Teams using the stack', value: '~8' },
      { label: 'Typical feature ship time', value: '1-2 days vs 1 sprint' },
    ],
  },
  {
    slug: 'ai-gateway',
    title: 'Model-agnostic AI gateway',
    blurb:
      "An AI gateway on top of AWS Bedrock and Azure OpenAI, with direct Anthropic API access for newer Claude models. Around 8 product teams route through it for model selection, automatic failover, and centralized cost tracking across Claude, GPT-4, Llama, and Titan.",
    stack: ['AWS Bedrock', 'Azure OpenAI', 'Anthropic API', 'Cost tracking', 'Provider failover'],
    metrics: [
      { label: 'Product teams routing through', value: '~8' },
      { label: 'Providers supported', value: '3 primary, 4+ models' },
    ],
  },
  {
    slug: 'document-ai',
    title: 'Multimodal document pipelines',
    blurb:
      "Document and image processing pipelines on Claude Vision and GPT-4V, with Gemini added recently for cost reasons. Handles the first pass of compliance reviews that used to sit with analysts.",
    stack: ['Claude Vision', 'GPT-4V', 'Gemini', 'OCR', 'Compliance review automation'],
    metrics: [
      { label: 'Use case', value: 'First-pass compliance review' },
      { label: 'Originally done by', value: 'Human analysts' },
    ],
  },
];
