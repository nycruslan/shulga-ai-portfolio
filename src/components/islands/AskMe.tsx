import { useCallback, useEffect, useRef, useState } from 'react';
import { about } from '../../data/about';

type Msg = { role: 'user' | 'assistant'; content: string };

const SESSION_LIMIT = 20;
const STORAGE_KEY = 'askme-session';

const SUGGESTED = [
  'What does Ruslan do at JPMC?',
  'Walk me through his hybrid RAG pipeline',
  'Why should I hire him?',
  "What's MCP and why does it matter?",
];

function loadSession(): { messages: Msg[]; msgCount: number } {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      return {
        messages: Array.isArray(data.messages) ? data.messages : [],
        msgCount: typeof data.msgCount === 'number' ? data.msgCount : 0,
      };
    }
  } catch {}
  return { messages: [], msgCount: 0 };
}

function saveSession(messages: Msg[], msgCount: number) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ messages, msgCount }));
  } catch {}
}

export default function AskMe() {
  const [open, setOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [messages, setMessages] = useState<Msg[]>(() => loadSession().messages);
  const [input, setInput] = useState('');
  const [msgCount, setMsgCount] = useState(() => loadSession().msgCount);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    function onOpen() { setOpen(true); }
    window.addEventListener('open-ask-me', onOpen as EventListener);
    return () => window.removeEventListener('open-ask-me', onOpen as EventListener);
  }, []);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      // Lenis intercepts wheel events globally — stop it so the background doesn't scroll
      (window as any).__lenis?.stop();
      setTimeout(() => inputRef.current?.focus(), 80);
    } else {
      document.body.style.overflow = '';
      (window as any).__lenis?.start();
    }
  }, [open]);

  // Scroll to bottom after paint — rAF ensures DOM is updated before reading scrollHeight
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [messages]);

  // Persist conversation to sessionStorage when streaming finishes
  useEffect(() => {
    if (!generating && messages.length > 0) {
      saveSession(messages, msgCount);
    }
  }, [generating, messages, msgCount]);

  // Auto-resize textarea as user types
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Trap Tab inside the dialog and restore focus to the opener on close
  useEffect(() => {
    if (!open) return;
    const root = containerRef.current;
    if (!root) return;
    const opener = document.activeElement as HTMLElement | null;
    function onTab(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const items = root!.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, [tabindex]:not([tabindex="-1"])'
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    root.addEventListener('keydown', onTab);
    return () => {
      root.removeEventListener('keydown', onTab);
      opener?.focus?.();
    };
  }, [open]);

  const send = useCallback(async (userText: string) => {
    const text = userText.trim();
    if (!text || generating) return;

    const nextMsgCount = msgCount + 1;
    setMsgCount(nextMsgCount);
    setInput('');

    const history: Msg[] = [...messages, { role: 'user', content: text }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setGenerating(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        const errText = res.ok ? 'Empty response' : await res.text().catch(() => 'Request failed');
        throw new Error(errText);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        const snapshot = acc;
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant') {
            copy[copy.length - 1] = { ...last, content: snapshot };
          }
          return copy;
        });
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === 'assistant' && !last.content) {
          copy[copy.length - 1] = { ...last, content: `Something went wrong. Email ${about.email}.` };
        }
        return copy;
      });
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }, [messages, generating, msgCount]);

  const onSubmit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (generating) {
      abortRef.current?.abort();
      setGenerating(false);
      return;
    }
    send(input);
  };

  const hitLimit = msgCount >= SESSION_LIMIT;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ask my portfolio"
        data-magnetic
        className="askme-fab"
        style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          zIndex: 9998,
          padding: '10px 14px',
          background: '#0e1011',
          border: '1px solid #2a2d30',
          color: '#e6e7e8',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          borderRadius: 999,
          cursor: 'pointer',
          boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span
          style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#7af2a0',
            boxShadow: '0 0 10px #7af2a0',
          }}
        />
        Ask me anything →
      </button>
    );
  }

  return (
    <div
      ref={containerRef}
      data-lenis-prevent
      role="dialog"
      aria-label="Ask my portfolio"
      onClick={(e) => { if (e.target === containerRef.current) setOpen(false); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9998,
        background: 'rgba(8, 9, 10, 0.7)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 'min(640px, 96vw)',
          // dvh accounts for virtual keyboard on mobile; vh fallback for older browsers
          height: 'min(80dvh, 720px)',
          margin: '0 12px 12px',
          background: '#0e1011',
          border: '1px solid #2a2d30',
          borderRadius: 12,
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderBottom: '1px solid #1a1d1f',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: generating ? '#7af2a0' : '#3a8f58',
                boxShadow: generating ? '0 0 12px #7af2a0' : 'none',
                transition: 'background 300ms, box-shadow 300ms',
              }}
            />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: '#e6e7e8' }}>
              Ask my portfolio
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#5e6469' }}>
              · powered by Claude Haiku
            </span>
          </div>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#8a8f98',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              padding: 4,
            }}
          >
            esc
          </button>
        </div>

        {/* Body — minHeight:0 required for overflow:auto in flex column; overscrollBehavior:contain stops scroll chaining */}
        <div
          ref={scrollRef}
          className="themed-scroll"
          style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', padding: '18px 20px', fontSize: 14, lineHeight: 1.6 }}
        >
          {messages.length === 0 && <Intro onPick={(p) => send(p)} />}

          {messages.map((m, i) => (
            <div key={i} style={{ marginBottom: 16 }}>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: '#5e6469',
                  marginBottom: 4,
                }}
              >
                {m.role === 'user' ? 'You' : 'Portfolio'}
              </div>
              <div style={{ color: m.role === 'user' ? '#e6e7e8' : '#cdd2d8', whiteSpace: 'pre-wrap' }}>
                {m.content || (generating && i === messages.length - 1 ? <Cursor /> : null)}
              </div>
            </div>
          ))}

          {hitLimit && (
            <div style={{ borderTop: '1px solid #1a1d1f', paddingTop: 14, marginTop: 8 }}>
              <p style={{ color: '#8a8f98', fontSize: 13, marginBottom: 10 }}>
                That's a lot of questions. Probably time to talk directly.
              </p>
              <a
                href={`mailto:${about.email}`}
                style={{
                  display: 'inline-block',
                  padding: '8px 14px',
                  border: '1px solid #2a2d30',
                  color: '#e6e7e8',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  borderRadius: 6,
                  textDecoration: 'none',
                }}
              >
                {about.email} →
              </a>
            </div>
          )}
        </div>

        {/* Input */}
        {!hitLimit && (
          <form
            onSubmit={onSubmit}
            style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid #1a1d1f' }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit(e);
                }
              }}
              placeholder="Ask anything about my work…"
              rows={1}
              style={{
                flex: 1,
                background: 'transparent',
                border: '1px solid #1a1d1f',
                borderRadius: 6,
                padding: '10px 12px',
                color: '#e6e7e8',
                fontSize: 14,
                fontFamily: 'var(--font-sans)',
                resize: 'none',
                outline: 'none',
                maxHeight: 120,
                overflowY: 'auto',
              }}
            />
            <button
              type="submit"
              style={{
                background: generating ? '#1a1d1f' : '#e6e7e8',
                color: generating ? '#e6e7e8' : '#08090a',
                border: 'none',
                borderRadius: 6,
                padding: '0 16px',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {generating ? 'stop' : 'send'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function Intro({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div style={{ color: '#8a8f98' }}>
      <p style={{ color: '#e6e7e8', marginBottom: 8 }}>
        Ask anything about my work.
      </p>
      <p style={{ marginBottom: 18, fontSize: 13 }}>
        Powered by Claude Haiku — answers are grounded in my actual projects and experience.
        Try one of these:
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {SUGGESTED.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            style={{
              textAlign: 'left',
              background: 'transparent',
              border: '1px solid #1a1d1f',
              color: '#cdd2d8',
              borderRadius: 6,
              padding: '10px 12px',
              fontFamily: 'var(--font-sans)',
              fontSize: 13,
              cursor: 'pointer',
              transition: 'background 150ms, border-color 150ms',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = '#1a1d1f';
              (e.currentTarget as HTMLElement).style.borderColor = '#2a2d30';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'transparent';
              (e.currentTarget as HTMLElement).style.borderColor = '#1a1d1f';
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function Cursor() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 14,
        background: '#e6e7e8',
        verticalAlign: 'text-bottom',
        animation: 'askme-blink 1s steps(2) infinite',
      }}
    />
  );
}
