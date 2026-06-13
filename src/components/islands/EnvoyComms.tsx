import { useEffect, useMemo, useRef, useState } from 'react';
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

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function usePersistentId(key: string, prefix: string): string {
  return useMemo(() => {
    try {
      const existing = localStorage.getItem(key);
      if (existing) return existing;
      const fresh = uid(prefix);
      localStorage.setItem(key, fresh);
      return fresh;
    } catch {
      return uid(prefix);
    }
  }, [key, prefix]);
}

function MissionCard({ progress, state }: { progress?: DispatchProgress; state: string }) {
  const label =
    progress?.state === 'done'
      ? 'MISSION COMPLETE'
      : progress?.state === 'failed'
        ? 'MISSION FAILED'
        : 'MISSION RUNNING';
  const color =
    progress?.state === 'done'
      ? 'var(--color-accent)'
      : progress?.state === 'failed'
        ? '#e2a04a'
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
        {!progress && state !== 'input-streaming' && 'Dispatching…'}
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
  const visitorId = usePersistentId('bridge-visitor-id', 'vis');
  const conversationId = usePersistentId('bridge-conversation-id', 'con');
  const [initialMessages, setInitialMessages] = useState<UIMessage[] | null>(null);
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/bridge/conversation.json?id=${encodeURIComponent(conversationId)}`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d) => setInitialMessages(d.messages ?? []))
      .catch(() => setInitialMessages([]));
  }, [conversationId]);

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
      visitorId={visitorId}
      conversationId={conversationId}
      initialMessages={initialMessages}
      input={input}
      setInput={setInput}
      endRef={endRef}
    />
  );
}

function CommsSession({
  visitorId,
  conversationId,
  initialMessages,
  input,
  setInput,
  endRef,
}: {
  visitorId: string;
  conversationId: string;
  initialMessages: UIMessage[];
  input: string;
  setInput: (v: string) => void;
  endRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { messages, sendMessage, status, error } = useChat({
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: '/api/bridge/envoy',
      body: { conversationId, visitorId },
    }),
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
        className="max-h-[360px] space-y-3 overflow-y-auto pr-1"
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
          <li className="font-mono text-xs" style={{ color: '#e2a04a' }}>
            {error.message.includes('429')
              ? 'Rate limited. The channel reopens within the hour.'
              : 'The channel dropped. Send that again.'}
          </li>
        )}
        <div ref={endRef} />
      </ol>

      {messages.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => send(s)}
              className="rounded-full px-3 py-1 font-mono text-[11px] transition-colors hover:[color:var(--color-text)]"
              style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}
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
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-md px-4 py-2 font-mono text-xs disabled:opacity-40"
          style={{
            border: '1px solid var(--color-accent-dim)',
            color: 'var(--color-accent)',
          }}
        >
          send
        </button>
      </form>
    </div>
  );
}
