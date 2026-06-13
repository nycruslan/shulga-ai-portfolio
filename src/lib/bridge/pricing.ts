// Rough per-token prices for the public spend meter. The AI Gateway dashboard
// stays the authoritative ledger; these keep the on-page dollar figure honest
// enough to publish ("$1.84 of thinking this week").

export type TokenUsage = { inputTokens: number; outputTokens: number };

const USD_PER_TOKEN: Record<string, { input: number; output: number }> = {
  'anthropic/claude-haiku-4.5': { input: 1 / 1e6, output: 5 / 1e6 },
  'anthropic/claude-sonnet-4-6': { input: 3 / 1e6, output: 15 / 1e6 },
};

const DEFAULT_PRICE = USD_PER_TOKEN['anthropic/claude-sonnet-4-6'];

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const price = USD_PER_TOKEN[model] ?? DEFAULT_PRICE;
  return usage.inputTokens * price.input + usage.outputTokens * price.output;
}
