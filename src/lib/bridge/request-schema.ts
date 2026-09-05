import { z } from 'zod';

const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

export const envoyConversationIdSchema = z.string().regex(new RegExp(`^con-${UUID_V4}$`, 'i'));
export const briefingIdSchema = z.string().regex(new RegExp(`^brf-${UUID_V4}$`, 'i'));
export const conversationIdSchema = z.union([envoyConversationIdSchema, briefingIdSchema]);

const messagePartSchema = z
  .looseObject({
    type: z.string().min(1).max(80),
    text: z.string().max(4_000).optional(),
  })
  .superRefine((part, ctx) => {
    if (part.type === 'text' && typeof part.text !== 'string') {
      ctx.addIssue({ code: 'custom', message: 'Text parts require text.' });
    }
  });

const uiMessageSchema = z.looseObject({
  id: z.string().min(1).max(128),
  role: z.enum(['user', 'assistant']),
  parts: z.array(messagePartSchema).max(64),
});

const recentUiMessagesSchema = z
  .array(uiMessageSchema)
  .min(1)
  .max(128)
  .transform((messages) => messages.slice(-24));

export const envoyRequestSchema = z.object({
  messages: recentUiMessagesSchema,
  conversationId: envoyConversationIdSchema,
});

export const briefingRequestSchema = z.object({
  messages: recentUiMessagesSchema,
  briefingId: briefingIdSchema,
});

const chatMessageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('user'),
    content: z.string().trim().min(1).max(2_000),
  }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().trim().min(1).max(4_000),
  }),
]);

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(20),
});
