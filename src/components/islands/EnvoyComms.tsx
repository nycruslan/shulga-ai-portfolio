import { useCallback, useEffect, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from 'ai';
import type { DispatchProgress } from '../../lib/bridge/agents/envoy';

// Comms: hail the bridge. Renders Envoy's typed message parts with the
// three-layer disclosure model: plain-language status lines for everyone, a
// mission card for dispatches (Scout's run streaming into it live), and an
// expandable trace for the technical reader. Conversations persist server-side
// and reload on mount, so a refresh mid-mission recovers the transcript.

type Props = { online: boolean };

const SUGGESTIONS = [
  'What did Ruslan ship this week?',
  "What's the hardest system he's built?",
  'How does this bridge actually work?',
];

// Plain-language layer-1 lines per tool (active -> done).
const TOOL_LINES: Record<string, { active: string; done: (output: unknown) => string }> = {
  search_portfolio: {
    active: 'Searching the portfolio…',
    done: (o) => `Found ${(o as { hits?: unknown[] })?.hits?.length ?? 0} passages.`,
  },
  get_project: { active: 'Pulling the case study…', done: () => 'Case study loaded.' },
  get_eval_summary: {
    active: "Checking last night's eval scores…",
    done: () => 'Eval scores retrieved.',
  },
};

const STORAGE_KEY = 'bridge-conversation-id';
const ID_RE = /^con-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function newConversationId(): string {
  return `con-${crypto.randomUUID()}`;
}

function storedConversationId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing && ID_RE.test(existing)) return existing;
    const fresh = newConversationId();
    localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return newConversationId();
  }
}

function useConversationId() {
  const [id, setId] = useState(storedConversationId);
  const reset = useCallback(() => {
    const fresh = newConversationId();
    try {
      localStorage.setItem(STORAGE_KEY, fresh);
    } catch {
      /* storage unavailable; the in-memory id still rotates */
    }
    setId(fresh);
  }, []);
  return [id, reset] as const;
}

function MissionCard({ progress, state }: { progress?: DispatchProgress; state: string }) {
  const failed = progress?.state === 'failed' || state === 'output-error';
  const label =
    progress?.state === 'done' ? 'MISSION COMPLETE' : failed ? 'MISSION FAILED' : 'MISSION RUNNING';
  const color =
    progress?.state === 'done'
      ? 'var(--color-accent)'
      : failed
        ? 'var(--color-warning)'
        : 'var(--color-text-muted)';
  return (
    <div
      className="my-2 rounded-md p-3"
      style={{ border: '1px solid var(--color-border-strong)', background: 'var(--color-bg)' }}
    >
      <p className="font-mono text-[10px] tracking-widest uppercase" style={{ color }}>
        {label}
        {progress ? ` — #${progress.missionId} → Scout` : ''}
      </p>
      <p
        className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {progress?.state === 'working' && progress.note}
        {progress?.state === 'done' && progress.report}
        {progress?.state === 'failed' && progress.report}
        {!progress && state === 'input-streaming' && 'Envoy is writing the mission brief…'}
        {!progress && state === 'output-error' && 'Mission failed before Scout returned.'}
        {!progress && state !== 'input-streaming' && state !== 'output-error' && 'Dispatching…'}
      </p>
      {progress?.state === 'working' && (
        <p className="mt-1 font-mono text-[10px]" style={{ color: 'var(--color-text-subtle)' }}>
          live — Scout is working
        </p>
      )}
    </div>
  );
}

export default function EnvoyComms({ online }: Props) {
  const [conversationId, resetConversationId] = useConversationId();
  const [loaded, setLoaded] = useState<{ id: string; messages: UIMessage[] } | null>(null);
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/bridge/conversation.json?id=${encodeURIComponent(conversationId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 409) {
          resetConversationId();
          return null;
        }
        return response.ok ? response.json() : { messages: [] };
      })
      .then((data) => {
        if (data && !controller.signal.aborted) {
          setLoaded({
            id: conversationId,
            messages: Array.isArray(data.messages) ? data.messages : [],
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ id: conversationId, messages: [] });
      });
    return () => controller.abort();
  }, [conversationId, resetConversationId]);

  const initialMessages = loaded?.id === conversationId ? loaded.messages : null;

  if (!online) {
    return (
      <p className="font-mono text-xs" style={{ color: 'var(--color-text-subtle)' }}>
        Comms station offline: the gateway key is not installed yet. The rest of the bridge runs
        without it.
      </p>
    );
  }
  if (initialMessages === null) {
    return (
      <p className="font-mono text-xs" style={{ color: 'var(--color-text-subtle)' }}>
        Opening the channel…
      </p>
    );
  }
  return (
    <CommsSession
      key={conversationId}
      conversationId={conversationId}
      initialMessages={initialMessages}
      input={input}
      setInput={setInput}
      endRef={endRef}
      onOwnershipExpired={resetConversationId}
    />
  );
}

function CommsSession({
  conversationId,
  initialMessages,
  input,
  setInput,
  endRef,
  onOwnershipExpired,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
  input: string;
  setInput: (v: string) => void;
  endRef: React.RefObject<HTMLLIElement | null>;
  onOwnershipExpired: () => void;
}) {
  const { messages, sendMessage, status, error, stop } = useChat({
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: '/api/bridge/envoy',
      body: { conversationId },
    }),
    onError: (requestError) => {
      if (/ownership expired|already processed/i.test(requestError.message)) {
        onOwnershipExpired();
      }
    },
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [messages, endRef]);

  const busy = status === 'submitted' || status === 'streaming';
  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    void sendMessage({ text: trimmed });
    setInput('');
  };

  return (
    <div className="space-y-3">
      <ol
        className="themed-scroll max-h-[360px] space-y-3 overflow-y-auto pr-1"
        data-lenis-prevent
        aria-live="polite"
        aria-atomic="false"
      >
        {messages.length === 0 && (
          <li className="text-sm" style={{ color: 'var(--color-text-subtle)' }}>
            Open channel. Ask about Ruslan's work, or send Scout to check what shipped this week.
            Missions you dispatch land on the board below, permanently.
          </li>
        )}
        {messages.map((m) => (
          <li key={m.id} className="text-sm leading-relaxed" style={{ contain: 'layout style' }}>
            <span
              className="mr-2 font-mono text-xs"
              style={{ color: m.role === 'user' ? 'var(--color-accent)' : 'var(--color-text)' }}
            >
              {m.role === 'user' ? 'you' : 'Envoy'}
            </span>
            {m.parts.map((part, i) => {
              if (part.type === 'text') {
                return (
                  <span
                    key={i}
                    className="whitespace-pre-wrap"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {part.text}
                  </span>
                );
              }
              if (isToolUIPart(part)) {
                const name = getToolName(part);
                if (name === 'dispatch_scout') {
                  const progress =
                    part.state === 'output-available'
                      ? (part.output as DispatchProgress)
                      : part.state === 'output-error'
                        ? undefined
                        : (part as { output?: DispatchProgress }).output;
                  return <MissionCard key={i} progress={progress} state={part.state} />;
                }
                const lines = TOOL_LINES[name];
                const done = part.state === 'output-available';
                return (
                  <span
                    key={i}
                    className="block font-mono text-xs"
                    style={{ color: 'var(--color-text-subtle)' }}
                  >
                    {done
                      ? (lines?.done(part.output) ?? `${name} done.`)
                      : (lines?.active ?? `${name}…`)}
                    {done && (
                      <details className="ml-1 inline-block align-top">
                        <summary className="cursor-pointer select-none">trace</summary>
                        <pre
                          className="mt-1 max-w-full overflow-x-auto rounded p-2 text-[10px]"
                          style={{
                            background: 'var(--color-bg)',
                            color: 'var(--color-text-subtle)',
                          }}
                        >
                          {JSON.stringify({ input: part.input, output: part.output }, null, 2)}
                        </pre>
                      </details>
                    )}
                  </span>
                );
              }
              return null;
            })}
          </li>
        ))}
        {error && (
          <li className="font-mono text-xs" style={{ color: 'var(--color-warning)' }}>
            {/rate limit|budget cap/i.test(error.message)
              ? 'Rate limited. The channel reopens later.'
              : 'The channel dropped. Send that again.'}
          </li>
        )}
        <li ref={endRef} aria-hidden="true" />
      </ol>

      {messages.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => send(s)}
              className="bridge-chip rounded-full px-3 py-1.5 font-mono text-[11px]"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? 'Envoy is replying…' : 'Hail the bridge…'}
          aria-label="Message to Envoy"
          className="min-w-0 flex-1 rounded-md px-3 py-2 text-sm outline-none"
          style={{
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border-strong)',
            color: 'var(--color-text)',
          }}
        />
        <button
          type={busy ? 'button' : 'submit'}
          onClick={busy ? () => void stop() : undefined}
          disabled={!busy && !input.trim()}
          className="bridge-btn rounded-md px-4 py-2 font-mono text-xs"
        >
          {busy ? 'stop' : 'send'}
        </button>
      </form>
    </div>
  );
}
