import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';

// Deterministic stand-ins for local dev WITHOUT a gateway key, and for tests.
// They make the full comms UX browsable (dispatch included) at zero cost.
// Production never sees these: without a key the comms station reports
// offline instead of pretending.

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
  totalTokens: 15,
} as const;
const toolCallsFinish = { unified: 'tool-calls', raw: 'tool_use' } as const;
const stopFinish = { unified: 'stop', raw: 'end_turn' } as const;

const text = (id: string, ...deltas: string[]): LanguageModelV3StreamPart[] => [
  { type: 'text-start', id },
  ...deltas.map((delta) => ({ type: 'text-delta' as const, id, delta })),
  { type: 'text-end', id },
];

function sequence(streams: LanguageModelV3StreamPart[][]) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream(streams[Math.min(call++, streams.length - 1)]),
    }),
  });
}

/** Envoy mock: greets, dispatches Scout once, then closes. */
export function mockEnvoyModel() {
  return sequence([
    [
      { type: 'stream-start', warnings: [] },
      ...text('t0', '[mock] On it. ', 'Dispatching Scout to check the feed.'),
      {
        type: 'tool-call',
        toolCallId: 'dispatch-1',
        toolName: 'dispatch_scout',
        input: JSON.stringify({ task: 'report recent pushes' }),
      },
      { type: 'finish', finishReason: toolCallsFinish, usage },
    ],
    [
      { type: 'stream-start', warnings: [] },
      ...text('t1', '[mock] Mission closed. ', "Scout's report is above."),
      { type: 'finish', finishReason: stopFinish, usage },
    ],
  ]);
}

/** Scout mock: one tool call to the (real) GitHub tool, then a short report. */
export function mockScoutModel() {
  return sequence([
    [
      { type: 'stream-start', warnings: [] },
      {
        type: 'tool-call',
        toolCallId: 'gh-1',
        toolName: 'github_activity',
        input: '{}',
      },
      { type: 'finish', finishReason: toolCallsFinish, usage },
    ],
    [
      { type: 'stream-start', warnings: [] },
      ...text(
        't0',
        '[mock] Sweep done. ',
        'The activity feed was fetched for real; this summary line is scripted.',
      ),
      { type: 'finish', finishReason: stopFinish, usage },
    ],
  ]);
}
