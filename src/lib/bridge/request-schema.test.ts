import { describe, expect, it } from 'vitest';
import {
  briefingRequestSchema,
  chatRequestSchema,
  conversationIdSchema,
  envoyRequestSchema,
} from './request-schema';

const id = (prefix: 'con' | 'brf') => `${prefix}-${crypto.randomUUID()}`;
const message = (index: number) => ({
  id: `message-${index}`,
  role: index % 2 === 0 ? ('assistant' as const) : ('user' as const),
  parts: [{ type: 'text', text: `message ${index}` }],
});

describe('bridge request schemas', () => {
  it('requires the correct UUID prefix for each endpoint', () => {
    const messages = [message(1)];
    expect(envoyRequestSchema.safeParse({ messages, conversationId: id('con') }).success).toBe(
      true,
    );
    expect(envoyRequestSchema.safeParse({ messages, conversationId: id('brf') }).success).toBe(
      false,
    );
    expect(briefingRequestSchema.safeParse({ messages, briefingId: id('brf') }).success).toBe(true);
    expect(conversationIdSchema.safeParse('con-not-a-uuid').success).toBe(false);
  });

  it('keeps only the newest 24 UI messages', () => {
    const messages = Array.from({ length: 30 }, (_, index) => message(index));
    const parsed = envoyRequestSchema.parse({ messages, conversationId: id('con') });
    expect(parsed.messages).toHaveLength(24);
    expect(parsed.messages[0].id).toBe('message-6');
  });

  it('rejects missing ids and oversized text parts', () => {
    expect(
      envoyRequestSchema.safeParse({
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
        conversationId: id('con'),
      }).success,
    ).toBe(false);
    expect(
      briefingRequestSchema.safeParse({
        messages: [
          {
            id: 'message-1',
            role: 'user',
            parts: [{ type: 'text', text: 'x'.repeat(4_001) }],
          },
        ],
        briefingId: id('brf'),
      }).success,
    ).toBe(false);
  });
});

describe('chatRequestSchema', () => {
  it('accepts at most 20 bounded messages', () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? ('assistant' as const) : ('user' as const),
      content: `message ${index}`,
    }));
    expect(chatRequestSchema.safeParse({ messages }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ messages: [...messages, messages[0]] }).success).toBe(
      false,
    );
    expect(
      chatRequestSchema.safeParse({
        messages: [{ role: 'user', content: 'x'.repeat(2_001) }],
      }).success,
    ).toBe(false);
  });
});
