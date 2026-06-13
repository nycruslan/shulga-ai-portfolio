import { describe, expect, it, vi } from 'vitest';
import {
  DirectChatTransport,
  ToolLoopAgent,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  stepCountIs,
  tool,
} from 'ai';
import type { ModelMessage } from 'ai';
import type { LanguageModelV3GenerateResult, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { Chat } from '@ai-sdk/react';
import { z } from 'zod';

// PHASE 0 SPIKE 1: the needsApproval round-trip.
//
// Curator's "draft diff -> human approves -> apply" mechanic depends entirely
// on this flow, and vercel/ai#10196 reported a post-approval crash in the
// agent UI stream on a 6.0 beta. This spike proves the round-trip works on the
// exact installed version, at both levels we will use it:
//   1. core level (server-side generate loop), and
//   2. Chat client level (the same path useChat takes in the browser,
//      via DirectChatTransport so no HTTP server is needed).
// It runs on MockLanguageModelV3, so it is deterministic and free, and stays
// in the suite as a regression tripwire for future ai package upgrades.

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
  totalTokens: 15,
} as const;

// v6 trap: finishReason is { unified, raw }, not a plain string as in v5.
const toolCallsFinish = { unified: 'tool-calls', raw: 'tool_use' } as const;
const stopFinish = { unified: 'stop', raw: 'end_turn' } as const;

const toolCallContent = {
  type: 'tool-call' as const,
  toolCallId: 'call-1',
  toolName: 'applyCopyDiff',
  input: JSON.stringify({ path: 'src/pages/index.astro', summary: 'tighten hero intro' }),
};

// Function-based mocks instead of the documented array form: the installed
// MockLanguageModelV3 has an off-by-one in array mode (it records the call
// BEFORE indexing, so the first call serves element 1 and element 0 is never
// used). A self-counting function sidesteps that and is version-proof.
type ApplyCopyDiffInput = { path: string; summary: string };

function makeAgent(
  execute: (input: ApplyCopyDiffInput) => Promise<unknown>,
  opts: { stream?: boolean } = {},
) {
  let call = 0;
  const model = new MockLanguageModelV3(
    opts.stream
      ? {
          doStream: async () => {
            const streams: LanguageModelV3StreamPart[][] = [
              [
                { type: 'stream-start', warnings: [] },
                toolCallContent,
                { type: 'finish', finishReason: toolCallsFinish, usage },
              ],
              [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'Change applied. ' },
                { type: 'text-delta', id: 't1', delta: 'The hero reads better now.' },
                { type: 'text-end', id: 't1' },
                { type: 'finish', finishReason: stopFinish, usage },
              ],
            ];
            const chunks = streams[Math.min(call++, streams.length - 1)];
            return { stream: convertArrayToReadableStream(chunks) };
          },
        }
      : {
          doGenerate: async () => {
            const responses: LanguageModelV3GenerateResult[] = [
              { content: [toolCallContent], finishReason: toolCallsFinish, usage, warnings: [] },
              {
                content: [{ type: 'text', text: 'Done. The change is live.' }],
                finishReason: stopFinish,
                usage,
                warnings: [],
              },
            ];
            return responses[Math.min(call++, responses.length - 1)];
          },
        },
  );

  const agent = new ToolLoopAgent({
    model,
    instructions: 'You are Curator. Propose and apply copy changes.',
    tools: {
      applyCopyDiff: tool({
        description: 'Apply a copy change to the site',
        inputSchema: z.object({ path: z.string(), summary: z.string() }),
        needsApproval: true,
        execute,
      }),
    },
    stopWhen: stepCountIs(4),
  });
  return agent;
}

describe('spike: needsApproval round-trip (core level)', () => {
  it('pauses on the approval request, then executes the tool after approval', async () => {
    const execute = vi.fn(async ({ path }: { path: string }) => ({ applied: true, path }));
    const agent = makeAgent(execute);

    // Round 1: the model wants the tool; the loop must pause, not execute.
    const userMessage: ModelMessage = {
      role: 'user',
      content: 'Tighten the hero intro and apply it.',
    };
    const first = await agent.generate({ messages: [userMessage] });

    const approvalRequest = first.content.find((p) => p.type === 'tool-approval-request');
    expect(approvalRequest).toBeDefined();
    expect(execute).not.toHaveBeenCalled();

    if (approvalRequest?.type !== 'tool-approval-request') throw new Error('unreachable');
    expect(approvalRequest.toolCall.toolName).toBe('applyCopyDiff');

    // Round 2: approval arrives as a tool message; the loop executes and finishes.
    const second = await agent.generate({
      messages: [
        userMessage,
        ...first.response.messages,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-approval-response',
              approvalId: approvalRequest.approvalId,
              approved: true,
            },
          ],
        },
      ],
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toEqual({
      path: 'src/pages/index.astro',
      summary: 'tighten hero intro',
    });
    expect(second.text).toBe('Done. The change is live.');
  });

  it('never executes the tool when the approval is denied', async () => {
    const execute = vi.fn(async () => ({ applied: true }));
    const agent = makeAgent(execute);

    const userMessage: ModelMessage = {
      role: 'user',
      content: 'Tighten the hero intro and apply it.',
    };
    const first = await agent.generate({ messages: [userMessage] });
    const approvalRequest = first.content.find((p) => p.type === 'tool-approval-request');
    if (approvalRequest?.type !== 'tool-approval-request') throw new Error('no approval request');

    await agent.generate({
      messages: [
        userMessage,
        ...first.response.messages,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-approval-response',
              approvalId: approvalRequest.approvalId,
              approved: false,
              reason: 'Not this one.',
            },
          ],
        },
      ],
    });

    expect(execute).not.toHaveBeenCalled();
  });
});

describe('spike: needsApproval round-trip (Chat client level)', () => {
  it('surfaces approval-requested to the client and resumes after addToolApprovalResponse', async () => {
    const execute = vi.fn(async ({ path }: { path: string }) => ({ applied: true, path }));
    const agent = makeAgent(execute, { stream: true });

    const errors: unknown[] = [];
    const chat = new Chat({
      transport: new DirectChatTransport({ agent }),
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      onError: (error) => {
        errors.push(error);
      },
    });

    await chat.sendMessage({ text: 'Tighten the hero intro and apply it.' });

    // The assistant message must now hold the tool part in approval-requested state.
    const assistant = chat.messages.at(-1);
    expect(assistant?.role).toBe('assistant');
    const pending = assistant?.parts.find(
      (p) => isToolUIPart(p) && p.state === 'approval-requested',
    );
    expect(pending).toBeDefined();
    expect(execute).not.toHaveBeenCalled();
    if (!pending || !isToolUIPart(pending) || pending.state !== 'approval-requested') {
      throw new Error('unreachable');
    }

    // Approve, exactly as the browser UI would. sendAutomaticallyWhen resends.
    await chat.addToolApprovalResponse({ id: pending.approval.id, approved: true });

    // Wait for the follow-up round to settle.
    await vi.waitFor(() => {
      expect(chat.status).toBe('ready');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    // This is where vercel/ai#10196 crashed ("no tool invocation found").
    expect(errors).toEqual([]);

    const final = chat.messages.at(-1);
    const toolPart = final?.parts.find((p) => isToolUIPart(p));
    expect(toolPart && isToolUIPart(toolPart) ? toolPart.state : undefined).toBe(
      'output-available',
    );
    const text = final?.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(text).toBe('Change applied. The hero reads better now.');
  });
});
