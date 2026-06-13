import { useEffect, useMemo, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import type { BriefingSectionData, BriefingStatusData } from '../../lib/bridge/briefing';

// The Briefing Room. One input, one button, and a document that builds itself
// in front of the recruiter: section cards pop in as Curator finishes them
// (same-id data parts reconcile), every link verified against a real case
// study. The finished briefing persists, so a revisit shows it instantly.

type Props = { online: boolean };

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function getStored(key: string, prefix: string): string {
  try {
    const v = localStorage.getItem(key);
    if (v) return v;
    const fresh = uid(prefix);
    localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return uid(prefix);
  }
}

function sectionsOf(messages: UIMessage[]): BriefingSectionData[] {
  // Same-id parts already reconcile within a message; collect across messages
  // keyed by index so a regenerated briefing fully replaces the old one.
  const byIndex = new Map<number, BriefingSectionData>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    byIndex.clear(); // only the latest assistant message is the document
    for (const part of m.parts) {
      if (part.type === 'data-briefingSection') {
        const data = part.data as BriefingSectionData;
        byIndex.set(data.index, data);
      }
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

export default function BriefingRoom({ online }: Props) {
  const visitorId = useMemo(() => getStored('bridge-visitor-id', 'vis'), []);
  const [briefingId, setBriefingId] = useState(() => getStored('bridge-briefing-id', 'brf'));
  // Keyed by id: switching briefings invalidates the load without a sync reset.
  const [loaded, setLoaded] = useState<{ id: string; messages: UIMessage[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/bridge/conversation.json?id=${encodeURIComponent(briefingId)}`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d) => {
        if (!cancelled) setLoaded({ id: briefingId, messages: d.messages ?? [] });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ id: briefingId, messages: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [briefingId]);

  const initialMessages = loaded?.id === briefingId ? loaded.messages : null;

  const reset = () => {
    const fresh = uid('brf');
    try {
      localStorage.setItem('bridge-briefing-id', fresh);
    } catch {
      /* storage unavailable; the in-memory id still rotates */
    }
    setBriefingId(fresh);
  };

  if (!online) {
    return (
      <p className="font-mono text-xs" style={{ color: 'var(--color-text-subtle)' }}>
        Briefing room offline: the gateway key is not installed yet.
      </p>
    );
  }
  if (initialMessages === null) {
    return (
      <p className="font-mono text-xs" style={{ color: 'var(--color-text-subtle)' }}>
        Unlocking the briefing room…
      </p>
    );
  }
  return (
    <BriefingSession
      key={briefingId}
      briefingId={briefingId}
      visitorId={visitorId}
      initialMessages={initialMessages}
      onReset={reset}
    />
  );
}

function BriefingSession({
  briefingId,
  visitorId,
  initialMessages,
  onReset,
}: {
  briefingId: string;
  visitorId: string;
  initialMessages: UIMessage[];
  onReset: () => void;
}) {
  const [input, setInput] = useState('');
  const [stage, setStage] = useState<BriefingStatusData | null>(null);

  const { messages, sendMessage, status, error } = useChat({
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: '/api/bridge/briefing',
      body: { briefingId, visitorId },
    }),
    onData: (part) => {
      if (part.type === 'data-briefingStatus') setStage(part.data as BriefingStatusData);
    },
  });

  const sections = sectionsOf(messages);
  const busy = status === 'submitted' || status === 'streaming';
  const hasBriefing = sections.length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (trimmed.length < 8 || busy) return;
    void sendMessage({ text: trimmed });
    setInput('');
    setStage(null);
  };

  return (
    <div className="space-y-4">
      {!hasBriefing && !busy && (
        <p
          className="max-w-2xl text-sm leading-relaxed"
          style={{ color: 'var(--color-text-muted)' }}
        >
          Hiring? Describe the role in one sentence and the crew assembles a briefing for you, live:
          Scout compiles the dossier from real case studies and the latest commits, Curator writes
          it. Sections land as they're finished, links included.
        </p>
      )}

      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='e.g. "Senior frontend engineer for an AI fintech product"'
          aria-label="Describe the role you are hiring for"
          disabled={busy}
          className="min-w-0 flex-1 rounded-md px-3 py-2 text-sm outline-none disabled:opacity-60"
          style={{
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border-strong)',
            color: 'var(--color-text)',
          }}
        />
        <button
          type="submit"
          disabled={busy || input.trim().length < 8}
          className="rounded-md px-4 py-2 font-mono text-xs disabled:opacity-40"
          style={{ border: '1px solid var(--color-accent-dim)', color: 'var(--color-accent)' }}
        >
          {busy ? 'assembling…' : 'assemble briefing'}
        </button>
        {hasBriefing && !busy && (
          <button
            type="button"
            onClick={onReset}
            className="rounded-md px-3 py-2 font-mono text-xs"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-subtle)' }}
          >
            new briefing
          </button>
        )}
      </form>

      {(busy || stage) && stage?.stage !== 'done' && (
        <p
          className="font-mono text-xs"
          aria-live="polite"
          style={{ color: stage?.stage === 'failed' ? '#e2a04a' : 'var(--color-text-subtle)' }}
        >
          {stage?.note ?? 'Opening the dossier…'}
        </p>
      )}
      {error && (
        <p className="font-mono text-xs" style={{ color: '#e2a04a' }}>
          {error.message.includes('429')
            ? 'Rate limited (3 briefings per hour). Try again later.'
            : 'Composition failed. Send the role line again.'}
        </p>
      )}

      {hasBriefing && (
        <ol className="grid gap-3 md:grid-cols-2" aria-live="polite" aria-atomic="false">
          {sections.map((s) => (
            <li
              key={s.index}
              className="rounded-lg p-4"
              style={{
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border)',
                contain: 'layout style',
              }}
            >
              <p
                className="font-display text-base font-medium"
                style={{ color: 'var(--color-text)' }}
              >
                {s.title}
              </p>
              <p
                className="mt-2 text-sm leading-relaxed"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {s.body}
              </p>
              {s.href && (
                <a
                  href={s.href}
                  className="mt-3 inline-block font-mono text-xs underline-offset-4 hover:underline"
                  style={{ color: 'var(--color-accent)' }}
                >
                  {s.linkLabel ?? 'case study'} →
                </a>
              )}
            </li>
          ))}
          {busy && (
            <li
              aria-hidden="true"
              className="rounded-lg p-4 motion-safe:animate-pulse"
              style={{ border: '1px dashed var(--color-border-strong)', minHeight: 96 }}
            >
              <p className="font-mono text-xs" style={{ color: 'var(--color-text-subtle)' }}>
                next section…
              </p>
            </li>
          )}
        </ol>
      )}

      {hasBriefing && !busy && (
        <p className="font-mono text-[11px]" style={{ color: 'var(--color-text-subtle)' }}>
          Assembled by the crew from real case studies; this run is mission-logged on the board
          above with its cost on the meter.
        </p>
      )}
    </div>
  );
}
