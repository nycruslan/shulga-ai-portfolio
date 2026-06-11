import { useEffect, useMemo, useRef, useState } from 'react';
import { about } from '../../data/about';

const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

type Action = {
  id: string;
  title: string;
  hint?: string;
  keywords?: string;
  run: () => void;
};

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const actions: Action[] = useMemo(
    () => [
      {
        id: 'chat',
        title: 'Ask my portfolio',
        hint: 'Open the in-browser AI chat',
        keywords: 'chat ai ask llm question',
        run: () => window.dispatchEvent(new CustomEvent('open-ask-me')),
      },
      {
        id: 'work',
        title: 'Jump to work',
        keywords: 'projects portfolio cases',
        run: () => location.assign('/#work'),
      },
      {
        id: 'about',
        title: 'Jump to about',
        keywords: 'story bio',
        run: () => location.assign('/#about'),
      },
      {
        id: 'contact',
        title: 'Jump to contact',
        keywords: 'email reach hello',
        run: () => location.assign('/#contact'),
      },
      {
        id: 'email',
        title: 'Copy email',
        hint: about.email,
        keywords: 'mail address',
        run: async () => {
          try {
            await navigator.clipboard.writeText(about.email);
            flash('Email copied to clipboard');
          } catch {
            flash(about.email);
          }
        },
      },
      {
        id: 'github',
        title: 'GitHub →',
        hint: shortUrl(about.github),
        keywords: 'code source repo',
        run: () => window.open(about.github, '_blank', 'noopener,noreferrer'),
      },
      {
        id: 'linkedin',
        title: 'LinkedIn →',
        hint: shortUrl(about.linkedin),
        keywords: 'profile network',
        run: () => window.open(about.linkedin, '_blank', 'noopener,noreferrer'),
      },
      {
        id: 'evals',
        title: 'View eval scores',
        hint: '/evals',
        keywords: 'evals tests scores quality llm judge',
        run: () => location.assign('/evals'),
      },
      {
        id: 'mcp',
        title: 'Copy MCP endpoint',
        hint: '/api/mcp',
        keywords: 'mcp server agent connector tools',
        run: async () => {
          try {
            await navigator.clipboard.writeText('https://ruslanshulga.com/api/mcp');
            flash('MCP endpoint copied. Add it to Claude → Settings → Connectors.');
          } catch {
            flash('https://ruslanshulga.com/api/mcp');
          }
        },
      },
      {
        id: 'resume',
        title: 'View resume JSON',
        hint: '/api/me.json',
        keywords: 'cv api data',
        run: () => window.open('/api/me.json', '_blank'),
      },
    ],
    []
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => (a.title + ' ' + (a.keywords || '')).toLowerCase().includes(q));
  }, [query, actions]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (!open) return;
      if (e.key === 'Escape') setOpen(false);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const action = filtered[activeIdx];
        if (action) {
          setOpen(false);
          action.run();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, activeIdx]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIdx(0);
    const opener = document.activeElement as HTMLElement | null;
    setTimeout(() => inputRef.current?.focus(), 30);
    function onTab(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const items = root.querySelectorAll<HTMLElement>(
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
    window.addEventListener('keydown', onTab);
    return () => {
      window.removeEventListener('keydown', onTab);
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-label="Command palette"
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(8, 9, 10, 0.7)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '15vh',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 92vw)',
          background: '#0e1011',
          border: '1px solid #2a2d30',
          borderRadius: 8,
          boxShadow: '0 24px 48px rgba(0,0,0,0.5)',
          overflow: 'hidden',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <input
          ref={inputRef}
          name="command"
          aria-label="Search commands"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIdx(0);
          }}
          placeholder="Search commands…"
          style={{
            width: '100%',
            padding: '14px 18px',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: '#e6e7e8',
            fontSize: 14,
            fontFamily: 'var(--font-mono)',
            borderBottom: '1px solid #1a1d1f',
          }}
        />
        <ul className="themed-scroll" style={{ listStyle: 'none', margin: 0, padding: 6, maxHeight: '50vh', overflow: 'auto' }}>
          {filtered.length === 0 && (
            <li style={{ padding: '14px 12px', color: '#787f86', fontSize: 13 }}>No matches.</li>
          )}
          {filtered.map((a, i) => (
            <li
              key={a.id}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => {
                setOpen(false);
                a.run();
              }}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '10px 12px',
                borderRadius: 4,
                cursor: 'pointer',
                background: i === activeIdx ? '#1a1d1f' : 'transparent',
                color: i === activeIdx ? '#e6e7e8' : '#8a8f98',
                fontSize: 13,
              }}
            >
              <span>{a.title}</span>
              {a.hint && <span style={{ color: '#787f86', fontSize: 11 }}>{a.hint}</span>}
            </li>
          ))}
        </ul>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '8px 14px',
            borderTop: '1px solid #1a1d1f',
            fontSize: 10,
            color: '#787f86',
          }}
        >
          <span>↑ ↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

function flash(message: string) {
  const el = document.createElement('div');
  el.textContent = message;
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#1a1d1f',
    border: '1px solid #2a2d30',
    color: '#e6e7e8',
    padding: '10px 16px',
    borderRadius: '6px',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    zIndex: 10001,
    boxShadow: '0 12px 24px rgba(0,0,0,0.4)',
    opacity: '0',
    transition: 'opacity 200ms',
  });
  document.body.appendChild(el);
  requestAnimationFrame(() => (el.style.opacity = '1'));
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }, 1800);
}
